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
const modelBSettlement = require('../services/modelBSettlementService'); // §P.5-E
const routePolicy = require('../src/services/routePolicyService');

const FIAT_REF_PREFIX = 'FIAT_DEPOSIT_';
// §P.5-C: rails are owned by the versioned route policy — the controller set
// mirrors the policy's GENERIC_FIAT_AGGREGATOR rails so they can never drift.
const PROVIDERS = new Set(routePolicy.DEPOSIT_ROUTES.GENERIC_FIAT_AGGREGATOR.rails);
const QUOTE_TTL_SECONDS = 600;

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
          userId, type: 'DEPOSIT_FIAT', amountUsdc: quote.usdcAmount, feeUsdc: 0, txHash: reference, status: 'PENDING', initiatedByUserId: userId,
          metadata: { provider, amountGhs: quote.amountGhs, quoteId: quote.id, quoteAmountUsdc: quote.usdcAmount, quoteExpiresAt: quote.expiresAt, rateAtInitiation: quote.rateGhsPerUsdc, rateSource: quote.rateSource, rateAsOf: quote.rateAsOf, selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion },
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

    const moolreResult = await moolre.initiatePayment({ externalRef: reference, amountGhs: meta.amountGhs, payerPhone: meta.payerPhone, network: meta.network, otpCode });
    if (moolreResult.requiresOtp) return res.status(400).json({ success: false, message: 'OTP verification failed. Check the code and retry.' });
    if (moolreResult.providerRef) await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: moolreResult.providerRef } });
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
    const settledGhs = Number(amountGhs);
    if (!Number.isFinite(settledGhs) || settledGhs <= 0) return res.status(400).json({ success: false, message: 'amountGhs must be a positive number.' });
    // §P.5-D: GHS evidence is exact to the pesewa — the authority never
    // rounds silently, so reject sub-pesewa precision up front (400, not a
    // mid-settlement failure).
    if (Math.round(settledGhs * 100) / 100 !== settledGhs) {
        return res.status(400).json({ success: false, message: 'amountGhs must be exact to the pesewa (2 decimal places).' });
    }

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown deposit reference.' });
    if (existing.status === 'COMPLETED') return res.status(200).json({ success: true, message: 'Deposit already processed.', data: { reference, alreadyProcessed: true } });
    if (existing.status !== 'PENDING') return res.status(409).json({ success: false, message: `Cannot complete deposit in state ${existing.status}.` });
    if (status && status !== 'SUCCESS') {
      const failed = await prisma.transactionHistory.updateMany({ where: { id: existing.id, status: 'PENDING' }, data: { status: 'FAILED', metadata: { ...(existing.metadata || {}), providerTxId: providerTxId || null, failedAt: new Date().toISOString() } } });
      return res.status(200).json({ success: true, message: failed.count > 0 ? 'Deposit marked as FAILED.' : 'Reference not in PENDING state.', data: { reference, status: 'FAILED' } });
    }

    // §P.5-D LIQUIDITY EVIDENCE: append the raw provider observation
    // OUT-OF-BAND, BEFORE the settle transaction — evidence always survives,
    // even when the settle fails closed. Append-only; replays converge.
    //
    // FAIL-CLOSED: the evidence layer is part of the authority boundary, NOT
    // best-effort logging. If the raw observation cannot be durably persisted,
    // the deposit settlement MUST NOT proceed as though evidence exists — no
    // customer USDC is credited and no liquidity transition happens while the
    // authoritative record of the provider's claim is missing. The deposit
    // stays PENDING; the provider retries or ops investigates.
    try {
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'GENERIC_FIAT_WEBHOOK',
            direction: 'INBOUND',
            status: (status || 'SUCCESS') === 'SUCCESS' ? 'SUCCESSFUL' : String(status).toUpperCase(),
            providerRef: providerTxId || null,
            dedupKey: `event:fiat-deposit:${reference}`,
            amountGhs: settledGhs,
            relatedReference: reference,
            raw: req.body || null,
        });
    } catch (evidenceErr) {
        logger.error({ err: evidenceErr, reference }, '[quoteFiatDepositWebhook] §P.5-D evidence persistence FAILED — settlement blocked');
        return res.status(503).json({
            success: false,
            message: 'Deposit evidence could not be durably recorded. Settlement has not been processed; please retry.'
        });
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
      const quotedGhs = Number(quote.amountGhs);
      if (Math.abs(settledGhs - quotedGhs) > 0.01) throw new Error('Settled GHS amount does not match the transaction quote');
      const user = await tx.user.findUnique({ where: { id: existing.userId } });
      if (!user) throw new Error('User no longer exists for this deposit.');
      const updatedTx = await tx.transactionHistory.update({ where: { id: existing.id }, data: { status: 'COMPLETED', amountUsdc: quote.usdcAmount, payerMsisdn: existing.payerMsisdn || null, metadata: { ...(existing.metadata || {}), providerTxId: providerTxId || null, settledAmountGhs: settledGhs, settledAt: new Date().toISOString(), settlementRate: quote.rateGhsPerUsdc, settledRoute: quote.selectedRoute || null, settledRoutePolicyVersion: quote.routePolicyVersion || null } } });
      await tx.user.update({ where: { id: existing.userId }, data: { availableBalance: { increment: quote.usdcAmount } } });

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
          quotedGhs: quote.amountGhs,
          quotedRateGhsPerUsdc: quote.rateGhsPerUsdc,
          quotedUsdc: quote.usdcAmount,
          settledGhs,
          settledUsdc: updatedTx.amountUsdc, // exact Decimal(20,8) — the ledger authority
          selectedRoute: quote.selectedRoute || null,
          routeProviderRail: quote.routeProviderRail || null,
          routePolicyVersion: quote.routePolicyVersion || null,
          provider: 'GENERIC_FIAT_WEBHOOK',
          providerRef: providerTxId || null,
          evidenceDedupKey: `event:fiat-deposit:${reference}`,
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
          eventDedupKey: `event:fiat-deposit:${reference}`,
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
