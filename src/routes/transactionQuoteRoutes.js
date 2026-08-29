'use strict';

const express = require('express');
const { z } = require('zod');
const { createTransactionQuote } = require('../services/transactionQuoteService');

const router = express.Router();

const requestSchema = z.object({
  amountGhs: z.number().positive().finite(),
  rateGhsPerUsdc: z.number().positive().finite(),
  feeGhs: z.number().min(0).finite().optional(),
  ttlSeconds: z.number().int().min(1).max(900).optional(),
  purpose: z.enum(['deposit', 'usdc_purchase', 'withdrawal', 'local_wallet']),
});

function createQuoteHandler(req, res) {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid quote request',
      details: parsed.error.flatten(),
    });
  }

  try {
    const quote = createTransactionQuote(parsed.data);
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
