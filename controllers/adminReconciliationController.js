'use strict';

// =============================================================================
// §WP-I — READ-ONLY RECONCILIATION OPERATOR SURFACE
//
// This controller exposes state an operator must SEE and nothing they can ACT
// on. There is deliberately no resolve, dismiss, unquarantine or force-settle
// action: adjudicating a provider observation needs its own evidence contract
// and audit trail, and a button here would be a way to manufacture a witness.
// =============================================================================

const operator = require('../src/services/reconciliationOperatorService');

function prismaOf(req) {
    return req.app.get('prisma');
}

async function list(req, res) {
    const prisma = prismaOf(req);
    try {
        const query = req.query || {};
        const result = await operator.listExceptions(prisma, query);
        return res.json({
            success: true,
            limit: result.limit,
            offset: result.offset,
            maxLimit: operator.MAX_LIMIT,
            items: result.items,
        });
    } catch (err) {
        return res.status(503).json({ success: false, message: 'Reconciliation case store is unavailable.' });
    }
}

async function quarantined(req, res) {
    const prisma = prismaOf(req);
    try {
        const result = await operator.listQuarantined(prisma, req.query || {});
        return res.json({ success: true, limit: result.limit, offset: result.offset, maxLimit: operator.MAX_LIMIT, items: result.items });
    } catch (err) {
        return res.status(503).json({ success: false, message: 'Observation claim store is unavailable.' });
    }
}

async function stuckDeposits(req, res) {
    const prisma = prismaOf(req);
    try {
        const result = await operator.listStuckDeposits(prisma, req.query || {});
        return res.json({ success: true, limit: result.limit, offset: result.offset, maxLimit: operator.MAX_LIMIT, items: result.items });
    } catch (err) {
        return res.status(503).json({ success: false, message: 'Deposit store is unavailable.' });
    }
}

async function summary(req, res) {
    const prisma = prismaOf(req);
    try {
        return res.json({ success: true, summary: await operator.summary(prisma) });
    } catch (err) {
        return res.status(503).json({ success: false, message: 'Reconciliation summary is unavailable.' });
    }
}

module.exports = { list, quarantined, stuckDeposits, summary };
