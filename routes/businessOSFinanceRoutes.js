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

function mapDashboard(stats) {
    return {
        ...stats,
        revenue: stats.revenue?.current ?? 0,
        revenuePrevious: stats.revenue?.previous ?? 0,
        revenueDelta: stats.revenue?.change ?? 0,
        expenses: stats.expenses?.current ?? 0,
        expensesPrevious: stats.expenses?.previous ?? 0,
        expenseDelta: stats.expenses?.change ?? 0,
        netProfit: stats.profit?.current ?? 0,
        previousNetProfit: stats.profit?.previous ?? 0,
    };
}

function mapPnl(current, prior) {
    const revenueLines = Object.entries(current.byCategory || {})
        .filter(([category]) => category)
        .map(([category, amount]) => ({ category, label: category, amount: Number(amount) }));
    const totalRevenue = Number(current.totalIncome || 0);
    const totalExpenses = Number(current.totalExpenses || 0);
    return {
        totalRevenue,
        priorRevenue: Number(prior?.totalIncome || 0),
        totalCogs: 0,
        priorCogs: 0,
        grossProfit: totalRevenue,
        totalOpex: totalExpenses,
        priorOpex: Number(prior?.totalExpenses || 0),
        netProfit: Number(current.netProfit || 0),
        priorNetProfit: Number(prior?.netProfit || 0),
        revenueLines: revenueLines.filter((line) => line.amount >= 0),
        cogsLines: [],
        opexLines: revenueLines.filter((line) => line.amount < 0).map((line) => ({ ...line, amount: Math.abs(line.amount) })),
        operatingExpenses: revenueLines.filter((line) => line.amount < 0).map((line) => ({ ...line, amount: Math.abs(line.amount) })),
        period: current.period || null,
        source: 'BusinessLedgerService',
        raw: { current, prior },
    };
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
    res.json({ data: mapDashboard(stats) });
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

    res.json({ data: mapPnl(current, prior) });
}));

router.get('/finance/cashflow', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const cf = await getLedgerService(req).getCashFlow(bpId, req.query);
    res.json({
        data: cf,
        cashflow: cf.dailyFlow || [],
        cashFlowSeries: cf.dailyFlow || [],
    });
}));

router.get('/finance/expenses', requirePermission('finance.view'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const exp = await getLedgerService(req).getExpenseBreakdown(bpId, req.query);
    res.json({ data: exp, categories: exp.categories || [], totalExpenses: exp.totalExpenses || 0 });
}));

module.exports = router;
