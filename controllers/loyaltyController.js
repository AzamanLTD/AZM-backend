// controllers/loyaltyController.js
'use strict';
const svc = require('../services/loyaltyService');
const logger = require('../src/config/logger');

// ── Business side ────────────────────────────────────────────────────────────────
exports.createProgram = async (req, res) => {
  try {
    const prog = await svc.createProgram(req.app.get('prisma'), { businessProfileId: req.params.businessId, ...req.body });
    res.status(201).json({ success: true, data: prog });
  } catch (e) { logger.error('createProgram', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.listPrograms = async (req, res) => {
  try {
    const list = await svc.listPrograms(req.app.get('prisma'), { businessProfileId: req.params.businessId, includeInactive: req.query.includeInactive === 'true' });
    res.json({ success: true, data: list });
  } catch (e) { logger.error('listPrograms', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.updateProgram = async (req, res) => {
  try {
    const prog = await svc.updateProgram(req.app.get('prisma'), { programId: req.params.programId, businessProfileId: req.params.businessId, ...req.body });
    res.json({ success: true, data: prog });
  } catch (e) { logger.error('updateProgram', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.deleteProgram = async (req, res) => {
  try {
    await svc.deleteProgram(req.app.get('prisma'), { programId: req.params.programId, businessProfileId: req.params.businessId });
    res.json({ success: true });
  } catch (e) { logger.error('deleteProgram', e); res.status(400).json({ success: false, message: e.message }); }
};

// ── Customer side ────────────────────────────────────────────────────────────────
exports.getMyCards = async (req, res) => {
  try {
    const cards = await svc.getMyLoyaltyCards(req.app.get('prisma'), { userId: req.user.id });
    res.json({ success: true, data: cards });
  } catch (e) { logger.error('getMyCards', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.getMyCard = async (req, res) => {
  try {
    const card = await svc.getMyCard(req.app.get('prisma'), { programId: req.params.programId, userId: req.user.id });
    res.json({ success: true, data: card });
  } catch (e) { logger.error('getMyCard', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.addStamp = async (req, res) => {
  try {
    const card = await svc.addStamp(req.app.get('prisma'), { programId: req.params.programId, userId: req.body.userId, businessProfileId: req.params.businessId });
    res.json({ success: true, data: card });
  } catch (e) { logger.error('addStamp', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.redeemReward = async (req, res) => {
  try {
    const card = await svc.redeemReward(req.app.get('prisma'), { programId: req.params.programId, userId: req.user.id });
    res.json({ success: true, data: card });
  } catch (e) { logger.error('redeemReward', e); res.status(400).json({ success: false, message: e.message }); }
};
