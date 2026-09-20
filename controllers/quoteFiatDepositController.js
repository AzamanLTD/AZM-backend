'use strict';

const crypto = require('crypto');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const ledger = require('../services/ledgerService'); // §P.4 authoritative ledger (shadow journalIntegration no longer used on this path)
const {
  createServerTransactionQuote,
  consumeTransactionQuote,
  RateUnavailableError,
  QuoteIdentityConflictError,
} = require('../src/services/transactionQuoteService');
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D
const { recordReconciliationException } = require('../services/reconciliationExceptionService');
const modelBSettlement = require('../services/modelBSettlementService'); // §P.5-E
const routePolicy = require('../src/services/routePolicyService');
const { Prisma } = require('@prisma/client');
const Decimal = Prisma.Decimal;

const FIAT_REF_PREFIX = 'FIAT_DEPOSIT_';
// §P.5-C: rails are owned by the versioned route policy — the controller set
// mirrors the policy's GENERIC_FIAT_AGGREGATOR rails so they can never drift.
const PROVIDERS = new Set(routePolicy.DEPOSIT_ROUTES.GENERIC_FIAT_AGGREGATOR.rails);
const QUOTE_TTL_SECONDS = 600;

// ── §P.5-D provider-observation identity (this surface) ─────────────────────
// ONE dedupKey names ONE provider observation, derived STRICTLY from fields
// actually present in the callback: the deposit reference and the reported
// status. A SUCCESS and a FAILED observation for the same reference are
// DISTINCT durable rows — materially different provider observations can
// never collapse into one; exact retries of the same observation converge
// idempotently. The evidence layer itself rejects a materially different
// payload under an already-committed identity (LIQUIDITY_CONFLICTING_EVIDENCE):
// contradictory evidence is retained and flagged, never silently absorbed.
// No provider event id is ever invented — only what the callback carries.
const GENERIC_EVENT_KEY_PREFIX = 'event:fiat-deposit';

// ── §P.5-D/r10: ONE authoritative callback-status interpretation ───────────
// The SAME interpretation drives the durable evidence identity AND the
// lifecycle (audit r10): the status durably recorded for evidence is exactly
// the status the lifecycle acts on — a raw representation can never be
// recorded as one status and then acted on as another (the r10 bug: a
// case-variant success was recorded as evidence yet failed the deposit).
// Supported representations — this surface's payload contract ('SUCCESS' and
// 'FAILED' in docs/tests), read case-insensitively per the project-wide
// provider-status vocabulary (cf. fiatSettlementWebhook.controller.js):
//   • omitted status (null/undefined/'')      → evidence SUCCESSFUL, settles
//   • 'SUCCESS' or 'SUCCESSFUL', any case     → evidence SUCCESSFUL, settles
//   • 'FAILED', any case                      → evidence FAILED, terminal CAS claim
//   • ANYTHING ELSE (unknown aliases, padded
//     tokens like ' SUCCESS ', 'PENDING', …)  → evidence: the uppercased raw
//     token under its own status-scoped identity, durably retained;
//     lifecycle: UNSUPPORTED — NO transition, fail-closed 422. The token is
//     never silently reinterpreted as success or failure, and no new
//     lifecycle state is invented: the deposit simply stays PENDING.
const interpretCallbackStatus = (status) => {
  if (status == null || status === '') return { evidence: 'SUCCESSFUL', intent: 'SUCCESS' };
  const token = String(status).toUpperCase();
  if (token === 'SUCCESS' || token === 'SUCCESSFUL') return { evidence: 'SUCCESSFUL', intent: 'SUCCESS' };
  if (token === 'FAILED') return { evidence: 'FAILED', intent: 'FAILED' };
  return { evidence: token, intent: 'UNSUPPORTED' };
};
const depositEventDedupKey = (reference, evidenceStatus) =>
  `${GENERIC_EVENT_KEY_PREFIX}:${reference}:${evidenceStatus}`;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getNotificationService(req) {
  const existing = req.app.get('notificationService');
  if (existing) return existing;
  const NotificationService = require('../services/notificationService');
  return new NotificationService(req.app.get('prisma'), req.app.get('socketio'));
}

exports.initiate = async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const amountGhs = Number(req.body.amountGhs);
    const provider = req.body.provider;
    const userId = Number(req.user.id);
    if (!Number.isFinite(amountGhs) || amountGhs <= 0) return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
    if (!PROVIDERS.has(provider)) return res.status(400).json({ success: false, message: `provider must be one of: ${[...PROVIDERS].join(', ')}.` });

    // §P.5-C route-aware quote: this mounted initiation endpoint deterministically
    // selects GENERIC_FIAT_AGGREGATOR and validates the requested rail. The
    // route decision is persisted ON the quote and in the pending transaction.
    const routeIdentity = routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider });
    // Harness-safe header read: mock reqs in mounted-handler tests may omit
    // headers entirely; a missing header is simply "no idempotency key".
    const idempotencyHeader = req.headers && typeof req.headers === 'object' ? req.headers['idempotency-key'] : undefined;
    const quoteIdentity = typeof idempotencyHeader === 'string' && idempotencyHeader.trim() ? idempotencyHeader.trim() : null;

    const { quote, tx } = await prisma.$transaction(async (db) => {
      const quote = await createServerTransactionQuote({ prisma: db, marketOracle: req.app.get('marketOracle'), userId, purpose: 'deposit', amountGhs, ttlSeconds: QUOTE_TTL_SECONDS, routeIdentity, quoteIdentity });
      const reference = `${FIAT_REF_PREFIX}${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const tx = await db.transactionHistory.create({
        data: {
          // §P.5-E audit r13 (§2): the pending row's projection derives from
          // the EXACT persisted 12dp quote string — never the lossy Number
          // projection (PostgreSQL applies the same 8dp HALF_UP the Model B
          // binding re-derives, so the row and the quote can never disagree).
          userId, type: 'DEPOSIT_FIAT', amountUsdc: quote._usdcAmountExact ?? quote.usdcAmount, feeUsdc: 0, txHash: reference, status: 'PENDING', initiatedByUserId: userId,
          metadata: { provider, amountGhs: quote.amountGhs, amountGhsExact: quote._amountGhsExact ?? null, quoteId: quote.id, quoteAmountUsdc: quote.usdcAmount, quoteAmountUsdcExact: quote._usdcAmountExact ?? null, quoteExpiresAt: quote.expiresAt, rateAtInitiation: quote.rateGhsPerUsdc, rateSource: quote.rateSource, rateAsOf: quote.rateAsOf, selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion },
        },
      });
      return { quote, tx };
    });

    return res.status(201).json({
      success: true,
      message: 'Deposit initiated. Complete the payment with your provider, then await confirmation.',
      data: { reference: tx.txHash, quoteId: quote.id, status: 'PENDING', provider, amountGhs: quote.amountGhs, quotedRate: quote.rateGhsPerUsdc, usdcEquivalent: quote.usdcAmount, quoteValidUntil: quote.expiresAt, selectedRoute: quote.selectedRoute || null, routeProviderRail: quote.routeProviderRail || null, routePolicyVersion: quote.routePolicyVersion || null, instructions: [`Send GHS ${quote.amountGhs.toFixed(2)} via ${provider}.`, `Use reference: ${tx.txHash}`, 'Funds will appear in your Azaman wallet after provider confirmation.'], transaction: tx },
    });
  } catch (error) {
    // 271C fail-closed stale-rate gate: no fresh external observation means
    // NO quote, NO pending transaction, and NO provider initiation — the
    // $transaction above never committed anything.
    if (error instanceof RateUnavailableError) {
      return res.status(503).json({ success: false, message: error.message, code: error.code });
    }
    // §P.5-C: a retried initiation under an existing Idempotency-Key fails
    // closed — the caller's original initiation stands (no second quote, no
    // second pending deposit). The middleware response cache normally answers
    // retries first; this closes its fail-open hole at the database.
    if (error instanceof QuoteIdentityConflictError) {
      return res.status(409).json({ success: false, message: 'This idempotency key is already bound to a deposit initiation.', code: 'DEPOSIT_IDEMPOTENCY_CONFLICT' });
    }
    logger.error({ err: error }, '[quoteFiatDeposit] initiation error');
    return res.status(500).json({ success: false, message: 'Unable to create deposit quote.' });
  }
};

exports.confirmMoolreOtp = async (req, res) => {
  const prisma = req.app.get('prisma');
  const moolre = req.app.get('moolreCollectionService');
  if (!moolre) return res.status(503).json({ success: false, message: 'Deposit service unavailable.' });
  try {
    const { reference, otpCode } = req.body || {};
    const userId = Number(req.user.id);
    if (!reference || !otpCode) return res.status(400).json({ success: false, message: 'reference and otpCode are required.' });
    const pending = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!pending || pending.userId !== userId || pending.type !== 'DEPOSIT_FIAT') return res.status(404).json({ success: false, message: 'Deposit not found.' });
    if (pending.status !== 'PENDING') return res.status(409).json({ success: false, message: `Deposit is already ${pending.status}.` });
    const meta = pending.metadata || {};
    if (!meta.quoteId || !meta.amountGhs || !meta.payerPhone || !meta.network) return res.status(409).json({ success: false, message: 'Deposit is missing its transaction quote.' });

    // §P.5-E audit r13 (§5): the provider request amount is the CANONICAL
    // quoted GHS (exact 2dp) — never the raw unnormalized input float. The
    // quote authority already normalized the amount at initiation; provider
    // request, TransactionHistory metadata and the persisted quote agree
    // exactly at the GHS 2dp authority.
    const canonicalAmountGhs = meta.amountGhsExact ?? meta.amountGhs;
    const moolreResult = await moolre.initiatePayment({ externalRef: reference, amountGhs: canonicalAmountGhs, payerPhone: meta.payerPhone, network: meta.network, otpCode });
    if (moolreResult.requiresOtp) return res.status(400).json({ success: false, message: 'OTP verification failed. Check the code and retry.' });
    if (moolreResult.providerRef) {
      // §P.5-E audit r13 (§4): the durable stamp is a compare-and-set on the
      // NULL slot (a lost CAS means a different ref is already committed —
      // surfaced below as a contradiction), and the SAME authoritative
      // reference is enriched onto the durable Moolre observation whenever
      // the early P01 callback already committed it with providerRef = NULL.
      const stamped = await prisma.transactionHistory.updateMany({ where: { id: pending.id, providerRef: null }, data: { providerRef: moolreResult.providerRef } });
      if (stamped.count === 0) {
        const nowRef = (await prisma.transactionHistory.findUnique({ where: { id: pending.id }, select: { providerRef: true } }))?.providerRef ?? null;
        if (nowRef !== moolreResult.providerRef) {
          return res.status(409).json({ success: false, message: 'A different provider reference is already bound to this deposit — confirmation blocked for reconciliation.', code: 'PROVIDER_REF_CONTRADICTION' });
        }
      }
      try {
        await fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, `event:moolre-collection:${reference}`, moolreResult.providerRef);
      } catch (enrichErr) {
        if (enrichErr instanceof fiatLiquidity.ConflictingEvidenceError) {
          return res.status(409).json({ success: false, message: enrichErr.message, code: 'CONTRADICTORY_PROVIDER_EVIDENCE' });
        }
        throw enrichErr;
      }
    }
    return res.status(200).json({ success: true, requiresOtp: false, data: { reference, quoteId: meta.quoteId } });
  } catch (err) {
    logger.error({ err }, '[quoteMoolreDeposit] OTP confirmation error');
    return res.status(502).json({ success: false, message: err.message?.replace(/^\[MoolreCollectionService\]\s*/, '') || 'Payment provider error. Please retry.' });
  }
};

exports.webhook = async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('socketio');
  const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
  try {
    const expectedSecret = process.env.FIAT_WEBHOOK_SECRET;
    if (!expectedSecret) return res.status(503).json({ success: false, message: 'Webhook endpoint is not configured.' });
    if (!safeEqual(req.headers['x-azaman-webhook-secret'], expectedSecret)) return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
    const { reference, amountGhs, providerTxId, status } = req.body || {};
    if (!reference || amountGhs === undefined || amountGhs === null) return res.status(400).json({ success: false, message: 'reference and amountGhs are required.' });
    // ── §P.5-D/r10: lossless GHS input boundary (audit r10) ──────────────
    // The webhook amount is parsed through the P5-D exact-decimal authority
    // (toExactGhsDecimal) — NEVER through JS Number. The previous float
    // boundary FAILED OPEN: sub-pesewa inputs within half a double-ulp of a
    // pesewa-exact value (e.g. '100.3000000000000001') silently collapsed to
    // 100.30 and were accepted — violating "the authority never rounds
    // silently". Exact parsing rejects them fail-closed (400) BEFORE any
    // evidence row or mutation; accepted input is never altered on its way to
    // evidence/settlement comparison.
    let settledGhs;
    try {
        settledGhs = fiatLiquidity.toExactGhsDecimal(amountGhs, { field: 'amountGhs' });
    } catch (e) {
        return res.status(400).json({ success: false, message: 'amountGhs must be a positive decimal exact to the pesewa (2 decimal places).' });
    }
    // ── §P.5-D/r10: ONE authoritative status interpretation drives both
    // the durable evidence identity and the lifecycle (see above).
    const { evidence: evidenceStatus, intent: statusIntent } = interpretCallbackStatus(status);

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown deposit reference.' });

    // §P.5-D LIQUIDITY EVIDENCE: append the raw provider observation
    // OUT-OF-BAND, BEFORE ANY state decision — including the state checks
    // below. EVERY observation is durable evidence, whatever the deposit's
    // current state: a contradictory late callback against a terminal row
    // (COMPLETED/FAILED) must remain durably visible for reconciliation, not
    // vanish behind an early return. Append-only; exact retries converge;
    // materially different observations are distinct rows (status-scoped
    // identity above).
    //
    // FAIL-CLOSED: the evidence layer is part of the authority boundary, NOT
    // best-effort logging. If the raw observation cannot be durably persisted,
    // the deposit settlement MUST NOT proceed as though evidence exists — no
    // customer USDC is credited and no liquidity transition happens while the
    // authoritative record of the provider's claim is missing. The deposit
    // stays PENDING; the provider retries or ops investigates.
    //
    // CONTRADICTORY EVIDENCE (typed): a materially different payload under an
    // already-committed observation identity fails closed with 409 — the
    // substrate retained the contradictory row under its own conflict
    // identity and NOTHING is settled on it. Ops sees both rows plus a
    // ReconciliationException; the provider's contradiction is never silently
    // absorbed, and a legitimate later observation is never blocked by it
    // (distinct status ⇒ distinct identity ⇒ its own row).
    let providerEvent;
    try {
        const recorded = await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'GENERIC_FIAT_WEBHOOK',
            direction: 'INBOUND',
            status: evidenceStatus,
            providerRef: providerTxId || null,
            dedupKey: depositEventDedupKey(reference, evidenceStatus),
            amountGhs: settledGhs,
            relatedReference: reference,
            raw: req.body || null,
        });
        providerEvent = recorded.event;
    } catch (evidenceErr) {
        if (evidenceErr instanceof fiatLiquidity.ConflictingEvidenceError) {
            // ── §P.5-D/r10: the flagging claim is HONEST (audit r10) ─────
            // The contradictory observation is durably retained by the
            // substrate and settlement is already blocked — but the API must
            // NEVER claim the contradiction "was flagged" unless the
            // ReconciliationException write actually committed. If that
            // operational write fails, respond fail-closed (500) with an
            // honest message instead of the flagged 409; the retained
            // evidence is NOT rolled back, and a retry of the same callback
            // re-attempts the flagging (the contradictory row converges to
            // its conflict identity, so nothing is lost or duplicated).
            let flagged = false;
            let flagErr = null;
            try {
                await recordReconciliationException(prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference: providerTxId || reference,
                    reason: 'CONTRADICTORY_PROVIDER_EVIDENCE',
                    details: {
                        provider: 'GENERIC_FIAT_WEBHOOK',
                        dedupKey: evidenceErr.details?.dedupKey ?? depositEventDedupKey(reference, evidenceStatus),
                        differingFields: evidenceErr.details?.differingFields ?? null,
                        conflictingDedupKey: evidenceErr.details?.conflictingDedupKey ?? null,
                    },
                });
                flagged = true;
            } catch (err) {
                flagErr = err;
                logger.error({ err, reference }, '[quoteFiatDepositWebhook] contradictory evidence retained, but ReconciliationException persistence FAILED');
            }
            if (!flagged) {
                return res.status(500).json({
                    success: false,
                    message: 'Contradictory provider evidence was retained, but the reconciliation exception could not be recorded. Settlement has not been processed; operator attention is required — retrying the callback re-attempts the flagging.',
                    code: 'CONTRADICTION_RETAINED_FLAGGING_FAILED',
                    error: flagErr && String(flagErr.message || flagErr),
                });
            }
            return res.status(409).json({
                success: false,
                message: 'Contradictory provider evidence for this reference was retained and flagged for reconciliation. Settlement has not been processed.',
                code: 'CONTRADICTORY_PROVIDER_EVIDENCE',
            });
        }
        logger.error({ err: evidenceErr, reference }, '[quoteFiatDepositWebhook] §P.5-D evidence persistence FAILED — settlement blocked');
        return res.status(503).json({
            success: false,
            message: 'Deposit evidence could not be durably recorded. Settlement has not been processed; please retry.'
        });
    }

    // ── lifecycle (existing contract, unchanged) ───────────────────────────
    // FAILED is TERMINAL on this surface: a FAILED callback CAS-claims
    // PENDING → FAILED below, and this controller never resurrects a
    // non-PENDING deposit (409). A later SUCCESS callback after FAILED is
    // retained as durable evidence above (its own status-scoped row) but does
    // NOT settle — the project's lifecycle contract has no FAILED → COMPLETED
    // transition on the generic surface, and none is invented here.
    if (existing.status === 'COMPLETED') return res.status(200).json({ success: true, message: 'Deposit already processed.', data: { reference, alreadyProcessed: true } });
    if (existing.status !== 'PENDING') return res.status(409).json({ success: false, message: `Cannot complete deposit in state ${existing.status}.` });
    if (statusIntent === 'UNSUPPORTED') {
      // §P.5-D/r10: an unsupported status representation was durably retained
      // as evidence above (its own status-scoped identity) but is NEVER
      // interpreted as a lifecycle decision — the deposit stays PENDING
      // (fail-closed, retryable with a supported representation). No new
      // lifecycle state is invented.
      return res.status(422).json({ success: false, message: `Unsupported callback status representation ${JSON.stringify(status)} — recorded as evidence, no lifecycle action taken. Use 'SUCCESS' or 'FAILED'.`, code: 'UNSUPPORTED_CALLBACK_STATUS' });
    }
    if (statusIntent === 'FAILED') {
      const failed = await prisma.transactionHistory.updateMany({ where: { id: existing.id, status: 'PENDING' }, data: { status: 'FAILED', metadata: { ...(existing.metadata || {}), providerTxId: providerTxId || null, failedAt: new Date().toISOString() } } });
      return res.status(200).json({ success: true, message: failed.count > 0 ? 'Deposit marked as FAILED.' : 'Reference not in PENDING state.', data: { reference, status: 'FAILED' } });
    }
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);
    // §P.5-E: OFF (default) keeps the §P.4 clearing:conversion bridge; ON
    // settles the purchase through authoritative inventory (Model B).
    const modelBOn = await modelBSettlement.isModelBSettlementEnabled(prisma);

    const quoteId = existing.metadata?.quoteId;
    if (!quoteId) return res.status(409).json({ success: false, message: 'Deposit is missing its transaction quote.' });
    const result = await prisma.$transaction(async (tx) => {
      const quote = await consumeTransactionQuote({ prisma: tx, quoteId, userId: existing.userId, purpose: 'deposit' });
      // §P.5-C settlement binding: this surface's authenticated identity is
      // the fiat webhook secret. A quote created for a different route (e.g.
      // MOOLRE_MOMO_COLLECTION) may NOT settle here — fail closed before any
      // mutation. Historical quotes without a selectedRoute still settle.
      routePolicy.assertSettlementRouteAllowed({ quote, settlementSurface: 'GENERIC_FIAT_WEBHOOK' });
      // ── §P.5-D/r10: the GHS settlement comparison runs on EXACT decimals —
      // the webhook amount never touches JS Number. §P.5-E Model B authority:
      // exact pesewa equality against the quote — 99.99/100.01 against a
      // 100.00 quote fail closed BEFORE any mutation. The ±0.01 tolerance is
      // the flag-OFF legacy affordance only (audit r1), now EXACT: uniformly
      // one-pesewa-inclusive at every magnitude, where the old float boundary
      // accepted/rejected the same one-pesewa delta depending on binary
      // rounding accidents.
      // §P.5-E audit r13 (§2): the GHS comparison and EVERY authoritative
      // write below consume the quote's EXACT persisted strings — the legacy
      // Number fields stay presentation-only. Number() silently destroys the
      // 12dp USDC tail at magnitude and made the Model B exact-quote binding
      // fail closed on VALID quotes.
      const quotedGhs = new Prisma.Decimal(quote.amountGhsExact ?? quote.amountGhs); // exact 2dp persisted quote amount
      const quotedUsdcExact = quote.usdcAmountExact ?? String(quote.usdcAmount); // exact 12dp persisted quote amount
      // the committed ledger authority: the persisted 12dp quote projected ONCE
      // at 8dp HALF_UP — exactly the projection Model B re-derives
      const settledUsdcLedger = new Prisma.Decimal(quotedUsdcExact).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
      if (modelBOn
        ? settledGhs.toFixed(2) !== quotedGhs.toFixed(2)
        : settledGhs.sub(quotedGhs).abs().greaterThan('0.01')) {
        throw new Error('Settled GHS amount does not match the transaction quote');
      }
      const user = await tx.user.findUnique({ where: { id: existing.userId } });
      if (!user) throw new Error('User no longer exists for this deposit.');
      // ── §P.5-E audit r5 (state-machine CAS) ──────────────────────────
      // The PENDING → COMPLETED claim is made by the DATABASE's conditional
      // update, NOT by the `existing.status === 'PENDING'` pre-read above —
      // that read happened OUTSIDE this transaction and is stale by the time
      // we claim. A competing failure callback (PENDING → FAILED) that
      // committed in between leaves this update matching ZERO rows; we fail
      // closed and the entire settlement transaction (quote consumption,
      // customer credit, ledger posting, Model B settlement, liquidity
      // receipt) rolls back. A terminal FAILED deposit can never be
      // resurrected to COMPLETED.
      const claimed = await tx.transactionHistory.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'COMPLETED', amountUsdc: settledUsdcLedger, payerMsisdn: existing.payerMsisdn || null, metadata: { ...(existing.metadata || {}), providerTxId: providerTxId || null, settledAmountGhs: settledGhs.toFixed(2), settledAt: new Date().toISOString(), settlementRate: quote.rateGhsPerUsdc, settledRoute: quote.selectedRoute || null, settledRoutePolicyVersion: quote.routePolicyVersion || null } },
      });
      if (claimed.count !== 1) {
        throw new Error('Deposit is no longer PENDING — a concurrent state transition won; refusing to settle');
      }
      // Read AFTER the claim, inside the claiming transaction: the exact
      // 8dp amount PostgreSQL stored. The conditional update above is the
      // state-machine claim authority — this read can never observe a
      // different state.
      const updatedTx = await tx.transactionHistory.findUnique({ where: { id: existing.id } });
      // §P.5-E audit r13 (§2): the balance increment is the EXACT 8dp ledger
      // projection of the persisted 12dp quote — never a lossy JS Number
      // that PostgreSQL would have to re-round.
      await tx.user.update({ where: { id: existing.userId }, data: { availableBalance: { increment: settledUsdcLedger } } });

      // §P.4 AUTHORITATIVE ACCOUNTING — fiat-settled USDC deposit: customer
      // liability is credited against an EXPLICIT conversion clearing
      // balance in the SAME transaction as the projection credit and the
      // TransactionHistory settlement. No USDC inventory is invented (§P.5
      // economics is NOT realized here); no fake custody asset is posted.
      //   D clearing:conversion   — explicit temporary clearing balance
      //   C user:{id}:liability    — customer liability increases
      //
      // §P.5-E: the flag ON path settles Model B instead — FIFO inventory
      // lot claim, GHS asset accounting (fiat:momo:ghs / equity:treasury:ghs),
      // COGS realization, treasury-stake-funded customer liability and the
      // durable realized-economics record — clearing:conversion is NOT
      // touched (docs/p5e-model-b-settlement.md §2.4).
      if (modelBOn) {
        await modelBSettlement.settleDepositFromInventory(tx, {
          reference,
          transactionHistoryId: existing.id,
          userId: existing.userId,
          quoteId,
          // §P.5-E audit r13 (§2): the Model B quote binding receives the
          // EXACT persisted 12dp authority — the primitive re-verifies it
          // against the persisted quote row and fails closed on ANY lossy
          // caller projection.
          quotedGhs: quote.amountGhsExact ?? quote.amountGhs,
          quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact ?? quote.rateGhsPerUsdc,
          quotedUsdc: quotedUsdcExact,
          settledGhs,
          settledUsdc: updatedTx.amountUsdc, // exact Decimal(20,8) — the ledger authority
          selectedRoute: quote.selectedRoute || null,
          routeProviderRail: quote.routeProviderRail || null,
          routePolicyVersion: quote.routePolicyVersion || null,
          provider: 'GENERIC_FIAT_WEBHOOK',
          providerRef: providerTxId || null,
          // §P.5-D/P.5-E: the identity of the observation this settlement is
          // backed by — the RETURNED committed event row's dedupKey, never a
          // re-invented key (a materially different later observation lives on
          // its own row and can never masquerade as this evidence).
          evidenceDedupKey: providerEvent.dedupKey,
        });
      } else {
      await ledger.post(tx, {
        idempotencyKey: `ledger:deposit:fiat:${reference}`,
        entryType: 'DEPOSIT',
        description: 'Fiat-settled USDC deposit credited at quoted rate',
        reference,
        userId: existing.userId,
        relatedEntity: 'transactionHistory',
        relatedEntityId: existing.id,
        metadata: { source: 'fiat', quoteId, amountGhs: settledGhs, selectedRoute: quote.selectedRoute || null, routeProviderRail: quote.routeProviderRail || null },
        lines: [
          // Post EXACTLY what the settled TransactionHistory row records
          // (Decimal(20,8)) — see the Moolre twin for the exactness rationale.
          { account: 'clearing:conversion', debit: updatedTx.amountUsdc },
          { account: `user:${existing.userId}:liability`, credit: updatedTx.amountUsdc },
        ],
      });
      }

      // §P.5-D (flag ON): the settled, quote-matched deposit observation IS
      // the evidence that creates AVAILABLE GHS liquidity — same transaction
      // as the deposit CAS claim. Unmatched or unverified evidence NEVER
      // lands AVAILABLE (docs §3.1, invariant 1).
      if (liquidityAuthorityOn) {
        await fiatLiquidity.recordReceipt(tx, {
          provider: 'GENERIC_FIAT_WEBHOOK',
          rail: quote.routeProviderRail || null,
          providerRef: providerTxId || null,
          dedupKey: `receipt:fiat-deposit:${reference}`,
          amountGhs: settledGhs,
          route: quote.selectedRoute || null,
          reference,
          relatedTransactionId: existing.id,
          eventDedupKey: providerEvent.dedupKey,
          evidence: {
            source: 'fiat_webhook',
            quoteId,
            providerTxId: providerTxId || null,
            settledAt: new Date().toISOString(),
          },
        });
      }
      return { updatedTx, quote, newBalance: Number(user.availableBalance) + Number(quote.usdcAmount) };
    });

    if (emitBalanceUpdate) await emitBalanceUpdate(existing.userId);
    if (io) io.to(`user_${existing.userId}`).emit('deposit_success', { type: 'DEPOSIT_FIAT', reference, providerTxId: providerTxId || null, amountGhs: settledGhs, usdcEquivalent: result.quote.usdcAmount, rate: result.quote.rateGhsPerUsdc, timestamp: new Date().toISOString() });
    try { await getNotificationService(req).sendNotification({ userId: existing.userId, title: 'Deposit Confirmed', body: `GH₵${settledGhs.toFixed(2)} deposited — ${result.quote.usdcAmount.toFixed(2)} USDC added at your quoted rate.`, category: 'GENERAL', actionPayload: { action: 'OPEN_WALLET', reference } }); } catch (notificationError) { logger.error({ err: notificationError }, '[quoteFiatDepositWebhook] notification non-fatal'); }
    await audit(prisma, { actorId: existing.userId, actorName: '', action: 'DEPOSIT_FIAT_COMPLETED', targetType: 'TRANSACTION', targetId: String(existing.id), metadata: { amountGhs: settledGhs, amountUsdc: result.quote.usdcAmount, rate: result.quote.rateGhsPerUsdc, quoteId, providerTxId: providerTxId || null }, ipAddress: req.ip });
    return res.status(200).json({ success: true, message: 'Deposit confirmed and credited.', data: { reference, userId: existing.userId, amountGhs: settledGhs, usdcEquivalent: result.quote.usdcAmount, rate: result.quote.rateGhsPerUsdc, quoteId, transaction: result.updatedTx } });
  } catch (error) {
    logger.error({ err: error }, '[quoteFiatDepositWebhook] error');
    return res.status(409).json({ success: false, message: error.message });
  }
};
