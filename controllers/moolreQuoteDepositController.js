'use strict';

const crypto = require('crypto');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const ledger = require('../services/ledgerService'); // §P.4 authoritative ledger (shadow journalIntegration no longer used on this path)
const settlementCore = require('../src/services/moolreDepositSettlement'); // r15 R15-B shared ONCE-settlement core
const {
  createTransactionQuote,
  persistTransactionQuote,
  getFreshServerRateGhsPerUsdc,
  RateUnavailableError,
  QuoteIdentityConflictError,
  consumeTransactionQuote,
  getPersistedTransactionQuoteExact,
} = require('../src/services/transactionQuoteService');
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D
const { recordReconciliationException } = require('../services/reconciliationExceptionService');
const modelBSettlement = require('../services/modelBSettlementService'); // §P.5-E
const routePolicy = require('../src/services/routePolicyService');
const { Prisma } = require('@prisma/client');
const Decimal = Prisma.Decimal;

// §P.5-C: rails are owned by the versioned route policy — this set mirrors
// MOOLRE_MOMO_COLLECTION rails so controller and policy can never drift.
const MOMO = new Set(routePolicy.DEPOSIT_ROUTES.MOOLRE_MOMO_COLLECTION.rails);
const NETWORK_MAP = {
  MTN_MOMO: 'MTN',
  TELECEL_CASH: 'TELECEL',
  VODAFONE_CASH: 'TELECEL',
  AIRTELTIGO: 'AIRTELTIGO',
};
const QUOTE_TTL_SECONDS = 600;

// ── §P.5-D provider-observation identity (this surface) ─────────────────────
// Moolre settlement notifications recorded here are ALWAYS successful
// collections (status 1 / P01; anything else is acknowledged out of the
// lifecycle above), so the observation identity is provider + reference with
// a constant status dimension: `event:moolre-collection:${externalRef}`.
// The substrate's identity contract governs the rest: an exact semantic
// duplicate replays; a materially different payload under this identity
// (e.g. a different collected amount) is CONTRADICTORY EVIDENCE — retained
// as a distinct conflict row and rejected fail-closed below. No provider
// event id is invented; providerRef comes from the durable initiation record.
const moolreEventDedupKey = (externalRef) => `event:moolre-collection:${externalRef}`;

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
  const moolre = req.app.get('moolreCollectionService');
  if (!moolre) return res.status(503).json({ success: false, message: 'Deposit service unavailable.' });

  try {
    const { amountGhs, provider, phoneNumber, memo } = req.body;
    const userId = Number(req.user.id);
    const ghsFloat = Number(amountGhs);

    if (!Number.isFinite(ghsFloat) || ghsFloat <= 0)
      return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
    if (!MOMO.has(provider))
      return res.status(400).json({ success: false, message: 'Use this endpoint only for MoMo providers.' });
    if (!phoneNumber || String(phoneNumber).replace(/\D/g, '').length < 9)
      return res.status(400).json({ success: false, message: 'A valid phone number is required.' });

    // 271C fail-closed stale-rate gate: Moolre initiation shares the SAME
    // canonical freshness/rate helper as the generic fiat route. A stale or
    // missing external observation fails HERE — before the quote is persisted,
    // before any TransactionHistory row exists, and before Moolre is asked to
    // initiate a payment. No direct GlobalSettings rate read remains.
    const rate = await getFreshServerRateGhsPerUsdc({
      prisma,
      marketOracle: req.app.get('marketOracle'),
    });

    // §P.5-E audit r13 (§5/§6): the CANONICAL quoted GHS is the exact 2dp
    // amount the quote authority rounded and persisted — the raw input float
    // is NEVER sent to the provider (a sub-pesewa input like 100.005 used to
    // be forwarded verbatim while the quote normalized to 100.01/100.00 —
    // provider request, metadata and quote disagreed). amountGhsCanonical is
    // derived BELOW from the created quote so all three agree exactly.
    const network = NETWORK_MAP[provider];
    // §P.5-C route-aware quote: this mounted endpoint deterministically
    // selects MOOLRE_MOMO_COLLECTION and validates the requested rail.
    const routeIdentity = routePolicy.resolveDepositRoute({ route: 'MOOLRE_MOMO_COLLECTION', provider });
    // Harness-safe header read: mock reqs in mounted-handler tests may omit
    // headers entirely; a missing header is simply "no idempotency key".
    const idempotencyHeader = req.headers && typeof req.headers === 'object' ? req.headers['idempotency-key'] : undefined;
    const quoteIdentity = typeof idempotencyHeader === 'string' && idempotencyHeader.trim() ? idempotencyHeader.trim() : null;
    const quote = createTransactionQuote({
      id: crypto.randomUUID(),
      userId,
      purpose: 'deposit',
      amountGhs: ghsFloat,
      feeGhs: 0,
      rateGhsPerUsdc: rate.rateGhsPerUsdc,
      // §P.5-C Decimal-native rate path: pass the EXACT DB Decimal through —
      // never a JS Number reconstruction of it.
      rateGhsPerUsdcExact: rate.rateGhsPerUsdcExact,
      rateSource: rate.rateSource,
      // rateAsOf is the TRUE external observation the gate verified — never a
      // MOCK-echo or admin-fabricated stamp (issue #271 / PR 271B).
      rateAsOf: rate.rateAsOf,
      ttlSeconds: QUOTE_TTL_SECONDS,
      routeIdentity,
      quoteIdentity,
    });

    // The canonical amount the quote authority committed — exact 2dp string.
    const amountGhsCanonical = quote._amountGhsExact ?? String(quote.amountGhs);

    // Return the transaction created in the same transaction that persists the
    // quote. Avoid a second, non-atomic lookup that could select an unrelated
    // pending deposit if multiple deposits are created concurrently.
    const pending = await prisma.$transaction(async (tx) => {
      await persistTransactionQuote(tx, quote);
      return tx.transactionHistory.create({
        data: {
          userId,
          type: 'DEPOSIT_FIAT',
          // §P.5-E audit r13 (§2): the pending projection derives from the
          // EXACT persisted 12dp quote string — never the lossy Number.
          amountUsdc: quote._usdcAmountExact ?? quote.usdcAmount,
          txHash: `MOOLRE_DEP_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          status: 'PENDING',
          initiatedByUserId: userId,
          metadata: {
            provider,
            network,
            // canonical 2dp authority (§5) — the SAME value sent to Moolre
            amountGhs: Number(quote.amountGhs),
            amountGhsExact: amountGhsCanonical,
            quoteId: quote.id,
            quoteAmountUsdc: quote.usdcAmount,
            quoteAmountUsdcExact: quote._usdcAmountExact ?? null,
            quoteExpiresAt: quote.expiresAt,
            rateAtInitiation: rate.rateGhsPerUsdc,
            rateSource: quote.rateSource,
            rateAsOf: quote.rateAsOf,
            ratePair: 'USDC/GHS',
            settlementCurrency: 'USDC',
            displayCurrency: 'GHS',
            selectedRoute: quote.selectedRoute,
            routeProviderRail: quote.routeProviderRail,
            routePolicyVersion: quote.routePolicyVersion,
            payerPhone: phoneNumber,
            channel: 'APP',
            ...(memo ? { memo: String(memo) } : {}),
          },
        },
      });
    });

    let moolreResult;
    try {
      // §P.5-E audit r13 (§5): the provider request amount is the CANONICAL
      // quoted GHS — the exact 2dp authority the quote persisted, never a raw
      // unnormalized JS Number.
      moolreResult = await moolre.initiatePayment({
        externalRef: pending.txHash,
        amountGhs: amountGhsCanonical,
        payerPhone: phoneNumber,
        network,
      });
    } catch (moolreErr) {
      // ── r15 R15-B: explicit provider OUTCOME classification drives the
      // lifecycle — a thrown error is NOT proof that Moolre refused. A
      // timeout/reset/5xx can occur AFTER Moolre accepted the same
      // externalRef; marking the deposit FAILED then would orphan collected
      // money and invite a second instruction under a new reference.
      const outcome = moolreErr.providerOutcome || 'UNKNOWN_OUTCOME';
      if (outcome === 'NOT_DISPATCHED' || outcome === 'DEFINITIVE_REJECTION') {
        // Provably no instruction exists — the terminal failure transition is
        // safe. §P.5-E audit r5: a DB-enforced conditional claim — only a
        // still-PENDING deposit can be failed here. A deposit that
        // concurrently completed elsewhere can never be resurrected to FAILED
        // by an unconditional write.
        await prisma.transactionHistory.updateMany({ where: { id: pending.id, status: 'PENDING' }, data: { status: 'FAILED' } });
        logger.error({ err: moolreErr, outcome }, '[moolreQuoteDeposit] provider initiation definitively refused');
        return res.status(502).json({
          success: false,
          code: outcome,
          message: moolreErr.message?.replace(/^\[MoolreCollectionService\]\s*/, '') || 'Payment provider error. Please retry.',
        });
      }
      // UNKNOWN_OUTCOME / DUPLICATE_REFERENCE (TP13): Moolre remains the
      // authoritative owner of the SAME durable externalRef — the deposit
      // STAYS PENDING, NEVER becomes FAILED, and NO second instruction may
      // be issued. The attempt is durable evidence; the outcome resolves by
      // callback or status query under the SAME reference.
      const attempt = {
        outcome,
        error: String(moolreErr.message || moolreErr).slice(0, 500),
        providerCode: moolreErr.code ?? null,
        at: new Date().toISOString(),
      };
      const marked = await prisma.transactionHistory.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { metadata: { ...(pending.metadata || {}), providerAttempt: attempt } },
      });
      if (marked.count === 1) {
        // Durable evidence of the ambiguous initiation (INBOUND observation,
        // append-only; retries converge on the same identity).
        try {
          await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE',
            direction: 'INBOUND',
            status: outcome === 'DUPLICATE_REFERENCE' ? 'DUPLICATE_REFERENCE' : 'AMBIGUOUS',
            providerRef: null,
            dedupKey: `event:moolre-initiation:${pending.txHash}`,
            amountGhs: amountGhsCanonical,
            relatedReference: pending.txHash,
            raw: { stage: 'INITIATE', ...attempt },
          });
        } catch (evidenceErr) {
          if (!(evidenceErr instanceof fiatLiquidity.ConflictingEvidenceError)) throw evidenceErr;
          // A materially identical re-record of the SAME ambiguous attempt
          // converges on the committed observation — the attempt evidence
          // already exists. Materially DIFFERENT observations fail closed
          // above (the substrate retains the contradiction).
          logger.warn({ reference: pending.txHash, outcome },
            '[moolreQuoteDeposit] ambiguous-initiation evidence already recorded — converging');
        }
      }
      logger.error({ err: moolreErr, outcome }, '[moolreQuoteDeposit] provider initiation outcome UNKNOWN — deposit stays PENDING');
      return res.status(202).json({
        success: false,
        code: outcome === 'DUPLICATE_REFERENCE' ? 'MOOLRE_DUPLICATE_REFERENCE' : 'MOOLRE_OUTCOME_UNKNOWN',
        retryable: false,
        message: outcome === 'DUPLICATE_REFERENCE'
          ? 'Moolre already holds this payment reference. The deposit stays pending and will be resolved by provider status or callback under the same reference — do NOT initiate a new deposit for this payment.'
          : 'The provider outcome is not yet known. The deposit stays pending and will be resolved by provider callback or status lookup under the same reference — do NOT initiate a new deposit for this payment.',
        data: { reference: pending.txHash, status: 'PENDING' },
      });
    }

    if (moolreResult.providerRef) {
      // §P.5-E audit r13 (§4): the durable stamp is a database-enforced
      // compare-and-set on the NULL slot (audit r11 semantics for the
      // TransactionHistory side too — no last-writer-wins between concurrent
      // OTP/late confirmations), and the SAME authoritative reference is
      // enriched onto the durable Moolre observation whenever the early P01
      // callback already committed it with providerRef = NULL.
      const stamped = await prisma.transactionHistory.updateMany({
        where: { id: pending.id, providerRef: null },
        data: { providerRef: moolreResult.providerRef },
      });
      if (stamped.count === 0) {
        const nowRef = (await prisma.transactionHistory.findUnique({ where: { id: pending.id }, select: { providerRef: true } }))?.providerRef ?? null;
        if (nowRef !== moolreResult.providerRef) {
          return res.status(409).json({
            success: false,
            message: 'A different provider reference is already bound to this deposit — initiation completed at the provider, but the identity contradiction must be reconciled before settlement.',
            code: 'PROVIDER_REF_CONTRADICTION',
          });
        }
      }
      try {
        await fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, moolreEventDedupKey(pending.txHash), moolreResult.providerRef);
      } catch (enrichErr) {
        if (enrichErr instanceof fiatLiquidity.ConflictingEvidenceError) {
          return res.status(409).json({ success: false, message: enrichErr.message, code: 'CONTRADICTORY_PROVIDER_EVIDENCE' });
        }
        throw enrichErr;
      }
    }

    return res.status(201).json({
      success: true,
      requiresOtp: moolreResult.requiresOtp,
      data: {
        reference: pending.txHash,
        quoteId: quote.id,
        status: 'PENDING',
        amountGhs: quote.amountGhs,
        quotedRate: quote.rateGhsPerUsdc,
        usdcAmount: quote.usdcAmount,
        quoteValidUntil: quote.expiresAt,
        provider,
        phoneNumber,
        // §P.5-C route decision — the response tells the caller exactly which
        // route + rail their deposit is bound to, and under which policy.
        selectedRoute: quote.selectedRoute || null,
        routeProviderRail: quote.routeProviderRail || null,
        routePolicyVersion: quote.routePolicyVersion || null,
      },
    });
  } catch (err) {
    // 271C: stale/unavailable external rate — nothing was persisted and the
    // provider was never contacted.
    if (err instanceof RateUnavailableError) {
      return res.status(503).json({ success: false, message: err.message, code: err.code });
    }
    // §P.5-C: a retried initiation under an existing Idempotency-Key fails
    // closed — the original initiation stands (no second quote or pending
    // deposit). Closes the middleware response-cache fail-open hole at the DB.
    if (err instanceof QuoteIdentityConflictError) {
      return res.status(409).json({ success: false, message: 'This idempotency key is already bound to a deposit initiation.', code: 'DEPOSIT_IDEMPOTENCY_CONFLICT' });
    }
    logger.error({ err }, '[moolreQuoteDeposit] initiation error');
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
};

exports.webhook = async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const expectedSecret = process.env.MOOLRE_WEBHOOK_SECRET;
    if (!expectedSecret) return res.status(503).json({ success: false, message: 'Webhook endpoint not configured.' });

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-moolre-signature'];
    let authenticated = signature && safeEqual(
      signature,
      crypto.createHmac('sha256', expectedSecret).update(rawBody).digest('hex'),
    );
    if (!authenticated) authenticated = safeEqual(req.headers['x-moolre-webhook-secret'], expectedSecret);
    if (!authenticated) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const { status, code, data } = req.body || {};
    if (Number(status) !== 1 || code !== 'P01') return res.status(200).json({ success: true, message: 'Event acknowledged.' });

    const externalRef = data?.externalref;
    if (!externalRef) return res.status(400).json({ success: false, message: 'Missing externalref.' });
    // ── §P.5-D/r10: lossless GHS input boundary (audit r10) — the Moolre
    // settlement amount is parsed through the P5-D exact-decimal authority
    // (toExactGhsDecimal), never through JS Number: sub-pesewa inputs that
    // would silently collapse through a float (e.g. '100.3000000000000001' →
    // 100.30) are rejected fail-closed BEFORE any evidence row or mutation,
    // and accepted input is never altered on its way to evidence/settlement
    // comparison.
    let settledGhs;
    try {
        settledGhs = fiatLiquidity.toExactGhsDecimal(data?.amount, { field: 'amount' });
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid settlement amount — must be a positive decimal exact to the pesewa (2 decimal places).' });
    }

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: externalRef } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown reference.' });

    // ── §P.5-E audit r13 (§4): early-callback prerequisite, reopened per
    // ROUTE. r8 refused the P01 callback while TransactionHistory.providerRef
    // was not yet stamped, because recording the observation with
    // providerRef = NULL first would make the provider's later legitimate
    // retry — the SAME dedupKey, now carrying the stamped ref — fail as
    // contradictory evidence and permanently block settlement. That tradeoff
    // is now split by what durably proves "this deposit passed through a
    // Moolre initiation":
    //
    //   * MOOLRE_MOMO_COLLECTION route: true BY CONSTRUCTION — the route's
    //     initiation endpoint ALWAYS calls moolre.initiatePayment, so an
    //     early P01 in the pre-stamp race window is a legitimate collection
    //     observation. Under the r10/r11 enrichment semantics (committed-null
    //     + incoming-present is a strictly-additive database compare-and-set)
    //     the observation now records DURABLY with providerRef = NULL and the
    //     settlement proceeds; the initiation stamp enriches the SAME row and
    //     exact retries converge. The r8 failure mode (money collected at the
    //     provider, deposit permanently unsettled, no durable evidence) is
    //     closed. Authority conditions are unchanged and fully enforced: the
    //     callback is HMAC-authenticated, externalref resolves to EXACTLY
    //     this TransactionHistory, the route policy still gates the
    //     settlement surface, and providerRef is supplementary identity —
    //     never the sole authenticity proof.
    //   * GENERIC_FIAT_AGGREGATOR route: Moolre involvement is proven ONLY
    //     by the OTP-confirmation stamp (confirmMoolreOtp initiates the
    //     Moolre payment). The §P.5-C rail-aware contract is preserved: a
    //     generic deposit that never passed through the Moolre OTP path can
    //     never be re-interpreted as a Moolre settlement — fail closed 409
    //     with NO observation constructed (r8 semantics), and the provider's
    //     P01 retry settles once the stamp lands. NOT recording here avoids
    //     committing a NULL-ref identity for a deposit whose Moolre payment
    //     may not exist; recording-for-enrichment is not needed because the
    //     stamp necessarily precedes collection success on this surface.
    const quoteId = existing.metadata?.quoteId ?? null;
    let routeRow = null;
    if (quoteId) {
        try {
            routeRow = await getPersistedTransactionQuoteExact({ prisma, quoteId });
        } catch (quoteErr) { /* missing/consumed quote fails closed below at the quote gate */ }
    }
    const moolreInitiatedRoute = routeRow?.selectedRoute === 'MOOLRE_MOMO_COLLECTION';
    if (!moolreInitiatedRoute && !existing.providerRef) {
      return res.status(409).json({ success: false, message: 'Deposit has no Moolre collection confirmation — cannot settle on the Moolre webhook.' });
    }

    // §P.5-D LIQUIDITY EVIDENCE: append the raw Moolre collection observation
    // OUT-OF-BAND, BEFORE ANY state decision — including the state checks
    // below. "Evidence before state checks" begins once the surface has
    // enough authoritative identity to construct the observation (see the
    // providerRef prerequisite above). EVERY identifiable P01 notification
    // is durable evidence, whatever the deposit's current state: a
    // contradictory late notification against a terminal row must remain
    // durably visible for reconciliation, not vanish behind an early
    // return. Append-only; exact retries converge.
    //
    // FAIL-CLOSED: the evidence layer is part of the authority boundary, NOT
    // best-effort logging. If the raw observation cannot be durably persisted,
    // the deposit settlement MUST NOT proceed as though evidence exists — no
    // customer USDC is credited and no liquidity transition happens while the
    // authoritative record of the provider's claim is missing. The deposit
    // stays PENDING; Moolre retries or ops investigates.
    //
    // CONTRADICTORY EVIDENCE (typed): a materially different payload under
    // the committed observation identity (e.g. a different collected amount
    // for the same externalref) fails closed with 409 — the substrate
    // retained the contradictory row under its own conflict identity and
    // NOTHING is settled on it. Ops sees both rows plus a
    // ReconciliationException; the contradiction is never silently absorbed.
    let providerEvent;
    try {
        const recorded = await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE',
            direction: 'INBOUND',
            status: 'SUCCESSFUL',
            // §r13 (§4): may be NULL when the early P01 precedes the
            // initiation stamp — the observation identity is the authenticated
            // callback (HMAC + externalref), and the NULL slot is enriched to
            // the initiation ref by the stamp path or the reconcile below.
            providerRef: existing.providerRef ?? null,
            dedupKey: moolreEventDedupKey(externalRef),
            amountGhs: settledGhs,
            relatedReference: externalRef,
            raw: req.body || null,
        });
        providerEvent = recorded.event;
    } catch (evidenceErr) {
        if (evidenceErr instanceof fiatLiquidity.ConflictingEvidenceError) {
            // ── §P.5-D/r10: the flagging claim is HONEST (audit r10) — the
            // API never claims the contradiction "was flagged" unless the
            // ReconciliationException write actually committed. If that
            // operational write fails, respond fail-closed (500) honestly
            // instead of the flagged 409; the retained evidence is NOT rolled
            // back, settlement stays blocked, and a retry of the same callback
            // re-attempts the flagging (the contradictory row converges to its
            // conflict identity — nothing is lost or duplicated).
            let flagged = false;
            let flagErr = null;
            try {
                await recordReconciliationException(prisma, {
                    entityType: 'TRANSACTION',
                    entityId: externalRef,
                    reference: existing.providerRef || externalRef,
                    reason: 'CONTRADICTORY_PROVIDER_EVIDENCE',
                    details: {
                        provider: 'MOOLRE',
                        dedupKey: evidenceErr.details?.dedupKey ?? moolreEventDedupKey(externalRef),
                        differingFields: evidenceErr.details?.differingFields ?? null,
                        conflictingDedupKey: evidenceErr.details?.conflictingDedupKey ?? null,
                    },
                });
                flagged = true;
            } catch (err) {
                flagErr = err;
                logger.error({ err, reference: externalRef }, '[moolreQuoteDepositWebhook] contradictory evidence retained, but ReconciliationException persistence FAILED');
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
        logger.error({ err: evidenceErr, reference: externalRef }, '[moolreQuoteDepositWebhook] §P.5-D evidence persistence FAILED — settlement blocked');
        return res.status(503).json({
            success: false,
            message: 'Deposit evidence could not be durably recorded. Settlement has not been processed; please retry.'
        });
    }

    // ── §P.5-E audit r13 (§4/§7): providerRef reconciliation ────────────────
    // NOTE (r13): reconciliation runs BEFORE the lifecycle early-returns —
    // every authenticated P01 converges the ref authorities (event ↔ TH) even
    // when the deposit is already terminal: a backfilled observation ref
    // reaches a deposit that settled early with a NULL ref, and a
    // post-settlement contradiction still surfaces 409 for ops. All reconcile
    // mutations are idempotent compare-and-sets — convergent under retries.
// With the early-callback prerequisite removed, the durable observation
    // may carry a NULL providerRef (early P01 before the initiation stamp)
    // while TransactionHistory later holds the initiation ref, or vice versa.
    // Before ANY settlement mutation the two authorities are reconciled to
    // the SAME value:
    //   * event NULL + TH ref   → enrich the observation (r11 substrate CAS)
    //   * event ref + TH NULL   → stamp TransactionHistory (CAS on NULL)
    //   * both present, differ  → CONTRADICTION — fail closed, NOTHING settles
    //   * equal (or both NULL) → converged — settle on the shared identity
    let settlementProviderRef;
    try {
        settlementProviderRef = await settlementCore.reconcileSettlementProviderRef(prisma, { deposit: existing, providerEvent });
    } catch (refErr) {
        if (refErr instanceof settlementCore.ProviderRefContradictionError) {
            return res.status(409).json({ success: false, message: refErr.message, code: refErr.code });
        }
        throw refErr;
    }


    // ── lifecycle (existing contract, unchanged) ───────────────────────────
    if (existing.status === 'COMPLETED') return res.status(200).json({ success: true, message: 'Already processed.' });
    if (existing.status !== 'PENDING') return res.status(409).json({ success: false, message: `Deposit is ${existing.status}.` });
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);
    // §P.5-E: OFF (default) keeps the §P.4 clearing:conversion bridge; ON
    // settles the purchase through authoritative inventory (Model B).
    const modelBOn = await modelBSettlement.isModelBSettlementEnabled(prisma);

    if (!quoteId) return res.status(409).json({ success: false, message: 'Deposit is missing its transaction quote.' });

    const result = await settlementCore.settleMoolreDeposit(prisma, {
        deposit: existing,
        quoteId,
        settledGhs,
        providerEvent,
        settlementProviderRef,
        payerMsisdn: data?.payer || null,
        providerData: data,
        evidenceSource: 'moolre_webhook',
    });

    const io = req.app.get('socketio');
    if (io) io.to(`user_${existing.userId}`).emit('deposit_success', {
      type: 'DEPOSIT_FIAT',
      amountGhs: settledGhs,
      amountUsdc: result.quote.usdcAmount,
      provider: existing.metadata?.provider || 'MOBILE_MONEY',
      reference: externalRef,
      newBalance: result.newBalance,
    });

    try {
      await getNotificationService(req).sendNotification({
        userId: existing.userId,
        title: 'Deposit Confirmed',
        body: `GH₵ ${settledGhs.toFixed(2)} has been credited at the quoted rate.`,
        category: 'GENERAL',
        actionPayload: { action: 'OPEN_WALLET', reference: externalRef },
      });
    } catch (notificationError) {
      logger.error({ err: notificationError }, '[moolreQuoteDeposit] notification failed');
    }

    await audit(prisma, {
      actorId: existing.userId,
      actorName: '',
      action: 'DEPOSIT_MOOLRE_COMPLETED',
      targetType: 'TRANSACTION',
      targetId: String(existing.id),
      metadata: { amountGhs: settledGhs, amountUsdc: result.quote.usdcAmount, externalRef, quoteId },
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: 'Deposit credited.',
      data: {
        reference: externalRef,
        amountGhs: settledGhs,
        amountUsdc: result.quote.usdcAmount,
        quoteId,
        transaction: result.updatedTx,
      },
    });
  } catch (err) {
    logger.error({ err }, '[moolreQuoteDeposit] webhook error');
    return res.status(409).json({ success: false, message: err.message });
  }
};
