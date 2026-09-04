'use strict';

const crypto = require('crypto');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const journal = require('../services/journalIntegration');
const {
  createTransactionQuote,
  persistTransactionQuote,
  consumeTransactionQuote,
} = require('../src/services/transactionQuoteService');

const MOMO = new Set(['MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH', 'AIRTELTIGO']);
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

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const rate = Number(settings?.liveRetailRate ?? settings?.liveUsdToGhs);
    if (!Number.isFinite(rate) || rate <= 0)
      return res.status(503).json({ success: false, message: 'Exchange rate unavailable. Please retry shortly.' });

    const network = NETWORK_MAP[provider];
    const quote = createTransactionQuote({
      id: crypto.randomUUID(),
      userId,
      purpose: 'deposit',
      amountGhs: ghsFloat,
      feeGhs: 0,
      rateGhsPerUsdc: rate,
      rateSource: settings.liveRateSource || 'AZM_ADMIN_MOCK',
      rateAsOf: settings.lastRateSync || new Date(),
      ttlSeconds: QUOTE_TTL_SECONDS,
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
            rateAtInitiation: rate,
            rateSource: quote.rateSource,
            rateAsOf: quote.rateAsOf,
            ratePair: 'USDC/GHS',
            settlementCurrency: 'USDC',
            displayCurrency: 'GHS',
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
      },
    });
  } catch (err) {
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

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: externalRef } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown reference.' });
    if (existing.status === 'COMPLETED') return res.status(200).json({ success: true, message: 'Already processed.' });
    if (existing.status !== 'PENDING') return res.status(409).json({ success: false, message: `Deposit is ${existing.status}.` });

    const quoteId = existing.metadata?.quoteId;
    if (!quoteId) return res.status(409).json({ success: false, message: 'Deposit is missing its transaction quote.' });

    const result = await prisma.$transaction(async (tx) => {
      const quote = await consumeTransactionQuote({
        prisma: tx,
        quoteId,
        userId: existing.userId,
        purpose: 'deposit',
      });

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
            providerData: data,
          },
        },
      });

      await tx.user.update({
        where: { id: existing.userId },
        data: { availableBalance: { increment: quote.usdcAmount } },
      });

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

    journal.recordDeposit(existing.userId, result.quote.usdcAmount, externalRef, {
      source: 'moolre',
      amountGhs: settledGhs,
      quoteId,
    }).catch((e) => logger.warn({ err: e.message, externalRef }, '[moolreQuoteDeposit] Journal recording failed'));

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
