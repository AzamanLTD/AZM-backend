'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const logger = require('../src/config/logger');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');

function getPrisma(req) {
    return req.app.get('prisma');
}

async function getBusinessProfileId(req) {
    if (!req.user?.id) throw new Error('Authentication required.');
    if (req.businessProfileId) return req.businessProfileId;
    const prisma = getPrisma(req);
    const profile = await prisma.businessProfile.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
    });
    if (!profile) throw new Error('Business profile not found.');
    return profile.id;
}

function getLedgerService(req) {
    return new BusinessLedgerService(getPrisma(req));
}

function wrap(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            logger.error({ err }, '[BusinessOSFinance]');
            res.status(err.statusCode || 400).json({ success: false, message: err.message });
        }
    };
}

router.use(protect, protectActive);

router.get('/finance/dashboard', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const stats = await getLedgerService(req).getDashboardStats(bpId);
    res.json({ data: stats });
}));

router.get('/finance/pl', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const { startDate, endDate, days } = req.query;
    let currentArgs;
    if (startDate || endDate) {
        currentArgs = { startDate, endDate };
    } else {
        const numDays = Math.max(1, Math.min(366, Number(days) || 30));
        const end = new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - numDays);
        currentArgs = { startDate: start.toISOString(), endDate: end.toISOString() };
    }

    const current = await getLedgerService(req).getProfitLoss(bpId, currentArgs);
    let prior = null;
    if (currentArgs.startDate && currentArgs.endDate) {
        const start = new Date(currentArgs.startDate);
        const end = new Date(currentArgs.endDate);
        const durationMs = Math.max(1, end.getTime() - start.getTime());
        const priorEnd = new Date(start.getTime() - 1);
        const priorStart = new Date(priorEnd.getTime() - durationMs);
        prior = await getLedgerService(req).getProfitLoss(bpId, {
            startDate: priorStart.toISOString(),
            endDate: priorEnd.toISOString(),
        });
    }

    res.json({ data: { current, prior } });
}));

router.get('/finance/cashflow', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const cf = await getLedgerService(req).getCashFlow(bpId, req.query);
    res.json({ data: cf });
}));

router.get('/finance/expenses', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const exp = await getLedgerService(req).getExpenseBreakdown(bpId, req.query);
    res.json({ data: exp });
}));

module.exports = router;
