'use strict';

const crypto = require('crypto');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const ledger = require('../services/ledgerService'); // §P.4 authoritative ledger (shadow journalIntegration no longer used on this path)
const {
  createTransactionQuote,
  persistTransactionQuote,
  getFreshServerRateGhsPerUsdc,
  RateUnavailableError,
  QuoteIdentityConflictError,
  consumeTransactionQuote,
} = require('../src/services/transactionQuoteService');
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D
const routePolicy = require('../src/services/routePolicyService');

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

    // Return the transaction created in the same transaction that persists the
    // quote. Avoid a second, non-atomic lookup that could select an unrelated
    // pending deposit if multiple deposits are created concurrently.
    const pending = await prisma.$transaction(async (tx) => {
      await persistTransactionQuote(tx, quote);
      return tx.transactionHistory.create({
        data: {
          userId,
          type: 'DEPOSIT_FIAT',
          amountUsdc: quote.usdcAmount,
          txHash: `MOOLRE_DEP_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          status: 'PENDING',
          initiatedByUserId: userId,
          metadata: {
            provider,
            network,
            amountGhs: ghsFloat,
            quoteId: quote.id,
            quoteAmountUsdc: quote.usdcAmount,
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
      moolreResult = await moolre.initiatePayment({
        externalRef: pending.txHash,
        amountGhs: ghsFloat,
        payerPhone: phoneNumber,
        network,
      });
    } catch (moolreErr) {
      await prisma.transactionHistory.update({ where: { id: pending.id }, data: { status: 'FAILED' } });
      logger.error({ err: moolreErr }, '[moolreQuoteDeposit] provider initiation failed');
      return res.status(502).json({
        success: false,
        message: moolreErr.message?.replace(/^\[MoolreCollectionService\]\s*/, '') || 'Payment provider error. Please retry.',
      });
    }

    if (moolreResult.providerRef) {
      await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: moolreResult.providerRef } });
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
    const settledGhs = Number(data?.amount);
    if (!externalRef) return res.status(400).json({ success: false, message: 'Missing externalref.' });
    if (!Number.isFinite(settledGhs) || settledGhs <= 0) return res.status(400).json({ success: false, message: 'Invalid settlement amount.' });
    // §P.5-D: GHS evidence is exact to the pesewa — the authority never
    // rounds silently, so reject sub-pesewa precision up front.
    if (Math.round(settledGhs * 100) / 100 !== settledGhs) {
        return res.status(400).json({ success: false, message: 'Settlement amount must be exact to the pesewa (2 decimal places).' });
    }

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: externalRef } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown reference.' });
    if (existing.status === 'COMPLETED') return res.status(200).json({ success: true, message: 'Already processed.' });
    if (existing.status !== 'PENDING') return res.status(409).json({ success: false, message: `Deposit is ${existing.status}.` });

    // §P.5-D LIQUIDITY EVIDENCE: append the raw Moolre collection observation
    // OUT-OF-BAND, BEFORE the settle transaction — evidence always survives,
    // even when the settle fails closed. Append-only; replays converge.
    //
    // FAIL-CLOSED: the evidence layer is part of the authority boundary, NOT
    // best-effort logging. If the raw observation cannot be durably persisted,
    // the deposit settlement MUST NOT proceed as though evidence exists — no
    // customer USDC is credited and no liquidity transition happens while the
    // authoritative record of the provider's claim is missing. The deposit
    // stays PENDING; Moolre retries or ops investigates.
    try {
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE',
            direction: 'INBOUND',
            status: 'SUCCESSFUL',
            providerRef: existing.providerRef,
            dedupKey: `event:moolre-collection:${externalRef}`,
            amountGhs: settledGhs,
            relatedReference: externalRef,
            raw: req.body || null,
        });
    } catch (evidenceErr) {
        logger.error({ err: evidenceErr, reference: externalRef }, '[moolreQuoteDepositWebhook] §P.5-D evidence persistence FAILED — settlement blocked');
        return res.status(503).json({
            success: false,
            message: 'Deposit evidence could not be durably recorded. Settlement has not been processed; please retry.'
        });
    }
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);

    const quoteId = existing.metadata?.quoteId;
    if (!quoteId) return res.status(409).json({ success: false, message: 'Deposit is missing its transaction quote.' });

    // §P.5-C rail-aware fail-closed: settlement on the Moolre webhook requires
    // PROOF of a legitimate Moolre collection (providerRef, stamped by the
    // Moolre initiate / OTP confirmation). A generic webhook deposit that
    // never passed through Moolre cannot be re-interpreted as a Moolre
    // settlement — 409 before any mutation.
    if (!existing.providerRef) {
      return res.status(409).json({ success: false, message: 'Deposit has no Moolre collection confirmation — cannot settle on the Moolre webhook.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const quote = await consumeTransactionQuote({
        prisma: tx,
        quoteId,
        userId: existing.userId,
        purpose: 'deposit',
      });

      // §P.5-C settlement binding: this surface's authenticated provider
      // identity is the Moolre HMAC. A quote whose selected route may not
      // settle via Moolre fails closed BEFORE any mutation. Quotes from the
      // generic aggregator's OTP-confirmed MoMo rails legitimately settle
      // here (their settlementSurfaces include MOOLRE_WEBHOOK); historical
      // quotes without a selected route also still settle.
      routePolicy.assertSettlementRouteAllowed({ quote, settlementSurface: 'MOOLRE_WEBHOOK' });

      const quotedGhs = Number(quote.amountGhs);
      if (Math.abs(settledGhs - quotedGhs) > 0.01) {
        throw new Error('Settled GHS amount does not match the transaction quote');
      }

      const user = await tx.user.findUnique({ where: { id: existing.userId } });
      if (!user) throw new Error('User no longer exists for this deposit.');

      const updatedTx = await tx.transactionHistory.update({
        where: { id: existing.id },
        data: {
          status: 'COMPLETED',
          amountUsdc: quote.usdcAmount,
          payerMsisdn: data?.payer || null,
          metadata: {
            ...(existing.metadata || {}),
            settledAmountGhs: settledGhs,
            settledAt: new Date().toISOString(),
            settledRoute: quote.selectedRoute || null,
            settledRoutePolicyVersion: quote.routePolicyVersion || null,
            providerData: data,
          },
        },
      });

      await tx.user.update({
        where: { id: existing.userId },
        data: { availableBalance: { increment: quote.usdcAmount } },
      });

      // §P.4 AUTHORITATIVE ACCOUNTING — same caller transaction as the
      // projection credit + TransactionHistory settlement:
      //   D clearing:conversion   — explicit temporary clearing (§P.5 later)
      //   C user:{id}:liability    — customer liability increases
      await ledger.post(tx, {
        idempotencyKey: `ledger:deposit:fiat:${externalRef}`,
        entryType: 'DEPOSIT',
        description: 'Fiat-settled USDC deposit credited (Moolre/aggregator settlement)',
        reference: externalRef,
        userId: existing.userId,
        relatedEntity: 'transactionHistory',
        relatedEntityId: existing.id,
        metadata: { source: 'moolre', quoteId, amountGhs: settledGhs, selectedRoute: quote.selectedRoute || null, routeProviderRail: quote.routeProviderRail || null },
        // Post EXACTLY what the settled TransactionHistory row records
        // (Decimal(20,8)) — quote.usdcAmount is numeric(30,12) and its JS
        // float form can carry >8 decimals, which the ledger's exactness
        // guard correctly refuses. The ledger and the canonical row can
        // never disagree.
        lines: [
          { account: 'clearing:conversion', debit: updatedTx.amountUsdc },
          { account: `user:${existing.userId}:liability`, credit: updatedTx.amountUsdc },
        ],
      });

      // §P.5-D (flag ON): the settled, quote-matched Moolre collection —
      // rail-gated by the providerRef proof — IS the evidence that creates
      // AVAILABLE GHS liquidity, in the SAME transaction as the deposit CAS
      // claim. Unmatched or unverified evidence NEVER lands AVAILABLE
      // (docs §3.1, invariant 1).
      if (liquidityAuthorityOn) {
        await fiatLiquidity.recordReceipt(tx, {
          provider: 'MOOLRE',
          rail: quote.routeProviderRail || null,
          providerRef: existing.providerRef,
          dedupKey: `receipt:moolre-collection:${externalRef}`,
          amountGhs: settledGhs,
          route: quote.selectedRoute || null,
          reference: externalRef,
          relatedTransactionId: existing.id,
          eventDedupKey: `event:moolre-collection:${externalRef}`,
          evidence: {
            source: 'moolre_collection',
            quoteId,
            providerRef: existing.providerRef,
            payer: data?.payer || null,
            settledAt: new Date().toISOString(),
          },
        });
      }

      return { updatedTx, quote, newBalance: Number(user.availableBalance) + Number(quote.usdcAmount) };
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
