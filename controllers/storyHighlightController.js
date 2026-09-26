// controllers/storyHighlightController.js
// Thin controller for story highlights, close friends, and story analytics

'use strict';
const svc = require('../services/storyHighlightService');
const logger = require('../src/config/logger');

// ── Highlights ──────────────────────────────────────────────────────────────────
exports.createHighlight = async (req, res) => {
  try {
    const hl = await svc.createHighlight(req.app.get('prisma'), {
      userId: req.user.id,
      ...req.body,
    });
    res.status(201).json({ success: true, data: hl });
  } catch (e) { logger.error('createHighlight', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.listHighlights = async (req, res) => {
  try {
    const list = await svc.listHighlights(req.app.get('prisma'), { userId: req.user.id });
    res.json({ success: true, data: list });
  } catch (e) { logger.error('listHighlights', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.getHighlight = async (req, res) => {
  try {
    const hl = await svc.getHighlight(req.app.get('prisma'), {
      highlightId: parseInt(req.params.id),
      requesterId: req.user.id,
    });
    res.json({ success: true, data: hl });
  } catch (e) { logger.error('getHighlight', e); res.status(404).json({ success: false, message: e.message }); }
};

exports.deleteHighlight = async (req, res) => {
  try {
    await svc.deleteHighlight(req.app.get('prisma'), { highlightId: parseInt(req.params.id), userId: req.user.id });
    res.json({ success: true });
  } catch (e) { logger.error('deleteHighlight', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.addItem = async (req, res) => {
  try {
    const item = await svc.addItemToHighlight(req.app.get('prisma'), {
      highlightId: parseInt(req.params.id),
      userId: req.user.id,
      storyId: req.body.storyId,
    });
    res.status(201).json({ success: true, data: item });
  } catch (e) { logger.error('addItem', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.removeItem = async (req, res) => {
  try {
    await svc.removeItemFromHighlight(req.app.get('prisma'), {
      highlightId: parseInt(req.params.id),
      itemId: parseInt(req.params.itemId),
      userId: req.user.id,
    });
    res.json({ success: true });
  } catch (e) { logger.error('removeItem', e); res.status(400).json({ success: false, message: e.message }); }
};

// ── Close Friends ────────────────────────────────────────────────────────────────
exports.listCloseFriends = async (req, res) => {
  try {
    const friends = await svc.listCloseFriends(req.app.get('prisma'), { userId: req.user.id });
    res.json({ success: true, data: friends });
  } catch (e) { logger.error('listCloseFriends', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.addCloseFriend = async (req, res) => {
  try {
    await svc.addCloseFriend(req.app.get('prisma'), { userId: req.user.id, friendId: req.body.friendId });
    res.status(201).json({ success: true });
  } catch (e) { logger.error('addCloseFriend', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.removeCloseFriend = async (req, res) => {
  try {
    await svc.removeCloseFriend(req.app.get('prisma'), { userId: req.user.id, friendId: parseInt(req.params.friendId) });
    res.json({ success: true });
  } catch (e) { logger.error('removeCloseFriend', e); res.status(400).json({ success: false, message: e.message }); }
};

// ── Story Analytics ──────────────────────────────────────────────────────────────
exports.getStoryAnalytics = async (req, res) => {
  try {
    const data = await svc.getStoryAnalytics(req.app.get('prisma'), {
      storyId: parseInt(req.params.storyId),
      userId: req.user.id,
    });
    res.json({ success: true, data });
  } catch (e) { logger.error('getStoryAnalytics', e); res.status(400).json({ success: false, message: e.message }); }
};

exports.getBusinessAnalytics = async (req, res) => {
  try {
    const data = await svc.getBusinessStoryAnalytics(req.app.get('prisma'), {
      businessProfileId: req.params.businessId,
      userId: req.user.id,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.json({ success: true, data });
  } catch (e) { logger.error('getBusinessAnalytics', e); res.status(400).json({ success: false, message: e.message }); }
};
