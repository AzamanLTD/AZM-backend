'use strict';

const express = require('express');
const { z } = require('zod');
const { protectActive } = require('../middleware/banGuardMiddleware');
const {
  createServerTransactionQuote,
  RateUnavailableError,
  QuoteIdentityConflictError,
  QuoteIdentityReplayError,
} = require('../src/services/transactionQuoteService');
const routePolicy = require('../src/services/routePolicyService');

const router = express.Router();

const requestSchema = z.object({
  amountGhs: z.number().positive().finite(),
  ttlSeconds: z.number().int().min(1).max(900).optional(),
  purpose: z.enum(['deposit', 'usdc_purchase', 'withdrawal', 'local_wallet']),
});

async function createQuoteHandler(req, res) {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid quote request',
      details: parsed.error.flatten(),
    });
  }

  const prisma = req.app.get('prisma');
  const marketOracle = req.app.get('marketOracle');

  if (!prisma) {
    return res.status(503).json({ error: 'Quote service is not configured' });
  }

  try {
    // §P.5-C: an optional Idempotency-Key header becomes the DB-enforced
    // quote identity — identical reuse replays the committed quote (same
    // route decision, rate, amounts, expiry); conflicting reuse fails 409.
    // Without the header, behavior is exactly as before (optional, not
    // mandatory — existing clients are unaffected).
    const idempotencyHeader = req.headers && typeof req.headers === 'object' ? req.headers['idempotency-key'] : undefined;
    const quoteIdentity = typeof idempotencyHeader === 'string' && idempotencyHeader.trim()
      ? idempotencyHeader.trim()
      : null;

    const quote = await createServerTransactionQuote({
      prisma,
      marketOracle,
      userId: Number(req.user.id),
      purpose: parsed.data.purpose,
      amountGhs: parsed.data.amountGhs,
      ttlSeconds: parsed.data.ttlSeconds,
      // Deposit-purpose price quotes persist the mounted route candidate set
      // + policy version but honestly claim NO selected route (this surface
      // makes no route decision; the initiation endpoints do).
      routeIdentity: parsed.data.purpose === 'deposit' ? routePolicy.priceQuoteRouteContext() : null,
      quoteIdentity,
    });

    return res.status(201).json({ quote });
  } catch (error) {
    // 271C truthfulness: a gated (deposit-purpose) stale/unavailable rate is
    // a genuine 503, not a generic 400 — the quote path must not disguise
    // fail-closed unavailability as a client error.
    if (error instanceof RateUnavailableError) {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    if (error instanceof QuoteIdentityReplayError) {
      return res.status(200).json({ quote: error.quote, idempotentReplay: true });
    }
    if (error instanceof QuoteIdentityConflictError) {
      return res.status(409).json({ error: 'Idempotency key was reused with a different quote request', code: error.code });
    }
    return res.status(400).json({ error: error.message });
  }
}

router.post('/', protectActive, createQuoteHandler);

module.exports = router;
