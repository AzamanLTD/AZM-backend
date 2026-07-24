'use strict';

// =============================================================================
// AZAMAN — AZM Staking Routes
// Mounted at /api/azm-stake
//
// 4 endpoints: create stake, request unstake, list stakes, get tier info
// =============================================================================

const logger = require('../src/config/logger');
const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { createStakeSchema, unstakeSchema } = require('../services/validation/storefrontSchemas');
const azmStakeService = require('../services/azmStakeService');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err: err }, '[AzmStake]');
      res.status(400).json({ success: false, message: err.message });
    }
  };
}

router.use(protect, protectActive);

// POST /api/azm-stake/create — create a new stake
router.post('/create', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const parsed = createStakeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  const result = await azmStakeService.createStake(prisma, req.user.id, parsed.data.amountAzm);
  res.json({ success: true, data: result, message: `Staked ${parsed.data.amountAzm} AZM. Tier: ${result.tier}.` });
}));

// POST /api/azm-stake/unstake — request unstaking (starts cooldown)
router.post('/unstake', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const parsed = unstakeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  const stake = await azmStakeService.requestUnstake(prisma, req.user.id, parsed.data.stakeId);
  res.json({ success: true, data: stake, message: `Unstake requested. Available in ${azmStakeService.COOLDOWN_DAYS} days.` });
}));

// GET /api/azm-stake/stakes — list all user stakes
router.get('/stakes', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const stakes = await azmStakeService.getUserStakes(prisma, req.user.id);
  res.json({ success: true, data: stakes });
}));

// GET /api/azm-stake/tier — get current tier and staked balance
router.get('/tier', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const stakedBalance = await azmStakeService.getStakedBalance(prisma, req.user.id);
  const tier = await azmStakeService.getUserTier(prisma, req.user.id);
  res.json({ success: true, data: { stakedBalance, tier, thresholds: azmStakeService.TIER_THRESHOLDS } });
}));

module.exports = router;
