'use strict';

const crypto = require('crypto');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const journal = require('../services/journalIntegration');
const {
  createServerTransactionQuote,
  consumeTransactionQuote,
} = require('../src/services/transactionQuoteService');

const FIAT_REF_PREFIX = 'FIAT_DEPOSIT_';
const PROVIDERS = new Set([
  'MTN_MOMO',
  'TELECEL_CASH',
  'VODAFONE_CASH',
  'AIRTELTIGO',
  'BANK_TRANSFER',
]);
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

    if (!Number.isFinite(amountGhs) || amountGhs <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
    }
    if (!PROVIDERS.has(provider)) {
      return res.status(400).json({
        success: false,
        message: `provider must be one of: ${[...PROVIDERS].join(', ')}.`,
      });
    }

    const quote = await createServerTransactionQuote({
      prisma,
      marketOracle: req.app.get('marketOracle'),
      userId,
      purpose: 'deposit',
      amountGhs,
      ttlSeconds: QUOTE_TTL_SECONDS,
    });

    const reference = `${FIAT_REF_PREFIX}${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const tx = await prisma.transactionHistory.create({
      data: {
        userId,
        type: 'DEPOSIT_FIAT',
        amountUsdc: quote.usdcAmount,
        feeUsdc: 0,
        txHash: reference,
        status: 'PENDING',
        initiatedByUserId: userId,
        metadata: {
          provider,
          amountGhs: quote.amountGhs,
          quoteId: quote.id,
          quoteAmountUsdc: quote.usdcAmount,
          quoteExpiresAt: quote.expiresAt,
          rateAtInitiation: quote.rateGhsPerUsdc,
          rateSource: quote.rateSource,
          rateAsOf: quote.rateAsOf,
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Deposit initiated. Complete the payment with your provider, then await confirmation.',
      data: {
        reference,
        quoteId: quote.id,
        status: 'PENDING',
        provider,
        amountGhs: quote.amountGhs,
        quotedRate: quote.rateGhsPerUsdc,
        usdcEquivalent: quote.usdcAmount,
        quoteValidUntil: quote.expiresAt,
        instructions: [
          `Send GHS ${quote.amountGhs.toFixed(2)} via ${provider}.`,
          `Use reference: ${reference}`,
          'Funds will appear in your Azaman wallet after provider confirmation.',
        ],
        transaction: tx,
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[quoteFiatDeposit] initiation error');
    return res.status(500).json({ success: false, message: 'Unable to create deposit quote.' });
  }
};

exports.webhook = async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('socketio');
  const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

  try {
    const expectedSecret = process.env.FIAT_WEBHOOK_SECRET;
    if (!expectedSecret) {
      logger.error('[quoteFiatDepositWebhook] FIAT_WEBHOOK_SECRET is not configured.');
      return res.status(503).json({ success: false, message: 'Webhook endpoint is not configured.' });
    }

    if (!safeEqual(req.headers['x-azaman-webhook-secret'], expectedSecret)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
    }

    const { reference, amountGhs, providerTxId, status } = req.body || {};
    if (!reference || amountGhs === undefined || amountGhs === null) {
      return res.status(400).json({ success: false, message: 'reference and amountGhs are required.' });
    }

    const settledGhs = Number(amountGhs);
    if (!Number.isFinite(settledGhs) || settledGhs <= 0) {
      return res.status(400).json({ success: false, message: 'amountGhs must be a positive number.' });
    }

    const existing = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!existing) return res.status(404).json({ success: false, message: 'Unknown deposit reference.' });
    if (existing.status === 'COMPLETED') {
      return res.status(200).json({ success: true, message: 'Deposit already processed.', data: { reference, alreadyProcessed: true } });
    }
    if (existing.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: `Cannot complete deposit in state ${existing.status}.` });
    }

    if (status && status !== 'SUCCESS') {
      const failed = await prisma.transactionHistory.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'FAILED', metadata: { ...(existing.metadata || {}), providerTxId: providerTxId || null, failedAt: new Date().toISOString() } },
      });
      return res.status(200).json({
        success: true,
        message: failed.count > 0 ? 'Deposit marked as FAILED.' : 'Reference not in PENDING state.',
        data: { reference, status: 'FAILED' },
      });
    }

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
          payerMsisdn: existing.payerMsisdn || null,
          metadata: {
            ...(existing.metadata || {}),
            providerTxId: providerTxId || null,
            settledAmountGhs: settledGhs,
            settledAt: new Date().toISOString(),
            settlementRate: quote.rateGhsPerUsdc,
          },
        },
      });

      await tx.user.update({
        where: { id: existing.userId },
        data: { availableBalance: { increment: quote.usdcAmount } },
      });

      return {
        updatedTx,
        quote,
        newBalance: Number(user.availableBalance) + Number(quote.usdcAmount),
      };
    });

    if (emitBalanceUpdate) await emitBalanceUpdate(existing.userId);

    if (io) {
      io.to(`user_${existing.userId}`).emit('deposit_success', {
        type: 'DEPOSIT_FIAT',
        reference,
        providerTxId: providerTxId || null,
        amountGhs: settledGhs,
        usdcEquivalent: result.quote.usdcAmount,
        rate: result.quote.rateGhsPerUsdc,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      await getNotificationService(req).sendNotification({
        userId: existing.userId,
        title: 'Deposit Confirmed',
        body: `GH₵${settledGhs.toFixed(2)} deposited — ${result.quote.usdcAmount.toFixed(2)} USDC added at your quoted rate.`,
        category: 'GENERAL',
        actionPayload: { action: 'OPEN_WALLET', reference },
      });
    } catch (notificationError) {
      logger.error({ err: notificationError }, '[quoteFiatDepositWebhook] notification non-fatal');
    }

    await audit(prisma, {
      actorId: existing.userId,
      actorName: '',
      action: 'DEPOSIT_FIAT_COMPLETED',
      targetType: 'TRANSACTION',
      targetId: String(existing.id),
      metadata: {
        amountGhs: settledGhs,
        amountUsdc: result.quote.usdcAmount,
        rate: result.quote.rateGhsPerUsdc,
        quoteId,
        providerTxId: providerTxId || null,
      },
      ipAddress: req.ip,
    });

    journal.recordDeposit(existing.userId, result.quote.usdcAmount, reference, {
      source: 'fiat',
      provider: existing.metadata?.provider,
      amountGhs: settledGhs,
      quoteId,
    }).catch((e) => logger.warn({ err: e.message, reference }, '[quoteFiatDepositWebhook] Journal recording failed'));

    return res.status(200).json({
      success: true,
      message: 'Deposit confirmed and credited.',
      data: {
        reference,
        userId: existing.userId,
        amountGhs: settledGhs,
        usdcEquivalent: result.quote.usdcAmount,
        rate: result.quote.rateGhsPerUsdc,
        quoteId,
        transaction: result.updatedTx,
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[quoteFiatDepositWebhook] error');
    return res.status(409).json({ success: false, message: error.message });
  }
};
