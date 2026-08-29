'use strict';

const express = require('express');
const { z } = require('zod');
const { createServerTransactionQuote } = require('../services/transactionQuoteService');

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
    const quote = await createServerTransactionQuote({
      prisma,
      marketOracle,
      amountGhs: parsed.data.amountGhs,
      ttlSeconds: parsed.data.ttlSeconds,
    });

    return res.status(201).json({
      quote: {
        ...quote,
        purpose: parsed.data.purpose,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

router.post('/', createQuoteHandler);

module.exports = router;
