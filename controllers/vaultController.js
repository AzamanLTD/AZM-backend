// controllers/vaultController.js
// =============================================================================
// AZAMAN — VAULT CONTROLLER  (Master Sprint, 2026-05-27)
//
// Thin HTTP layer over VaultService. All write paths are mounted on
// `protectActive` (ban-guarded) — banned users cannot create/deposit/break.
// Read endpoints (`list`, `getDetail`, `receipt`, `deposits`) use `protect`
// so a frozen account can still review their state.
// =============================================================================

const { audit } = require('../utils/audit');

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`[vaultController] ${fn.name || 'handler'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

exports.create = wrap(async function create(req, res) {
    const svc = req.app.get('vaultService');
    const userId = req.user.id;
    const { name, targetAmountUsdc, maturityDate, autoRule, rulesAcceptedVersion } = req.body;

    // Rules-of-the-game gate — body must explicitly accept
    if (!req.body.rulesAccepted) {
        return res.status(400).json({
            success: false,
            message: 'Rules of the Game must be accepted before creating a vault.',
        });
    }

    const vault = await svc.createVault({
        userId,
        name,
        targetAmountUsdc,
        maturityDate,
        autoRule,
        rulesAcceptedVersion,
    });
    res.status(201).json({ success: true, vault });
});

exports.list = wrap(async function list(req, res) {
    const svc = req.app.get('vaultService');
    const vaults = await svc.listForUser(req.user.id);
    res.json({ success: true, vaults });
});

exports.getDetail = wrap(async function getDetail(req, res) {
    const svc = req.app.get('vaultService');
    const vault = await svc.getDetail(req.user.id, req.params.id);
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    res.json({ success: true, vault });
});

exports.deposit = wrap(async function deposit(req, res) {
    const svc = req.app.get('vaultService');
    const result = await svc.depositManual({
        userId: req.user.id,
        vaultId: req.params.id,
        amountUsdc: req.body.amountUsdc,
    });
    await audit(req.app.get('prisma'), {
        actorId: req.user.id, actorName: req.user.username,
        action: 'VAULT_DEPOSIT', targetType: 'VAULT', targetId: String(req.params.id),
        metadata: { amountUsdc: req.body.amountUsdc }, ipAddress: req.ip,
    });
    res.json({ success: true, breakdown: result.breakdown });
});

exports.setAutoRule = wrap(async function setAutoRule(req, res) {
    const prisma = req.app.get('prisma');
    const { amountUsdc, frequency, enabled = true } = req.body;
    const vault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!vault || vault.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Vault not found' });
    }
    const FREQUENCY_MS = require('../services/vaultService').FREQUENCY_MS;
    const data = { autoRuleEnabled: !!enabled };
    if (enabled) {
        if (!FREQUENCY_MS[frequency]) throw new Error('Invalid frequency');
        if (!amountUsdc || Number(amountUsdc) <= 0) throw new Error('Invalid amountUsdc');
        data.autoRuleAmountUsdc = amountUsdc;
        data.autoRuleFrequency = frequency;
        data.autoRuleNextRun = new Date(Date.now() + FREQUENCY_MS[frequency]);
    } else {
        data.autoRuleAmountUsdc = null;
        data.autoRuleFrequency = null;
        data.autoRuleNextRun = null;
    }
    const updated = await prisma.vault.update({ where: { id: vault.id }, data });
    res.json({ success: true, vault: updated });
});

exports.disableAutoRule = wrap(async function disableAutoRule(req, res) {
    const prisma = req.app.get('prisma');
    const vault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!vault || vault.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Vault not found' });
    }
    const updated = await prisma.vault.update({
        where: { id: vault.id },
        data: {
            autoRuleEnabled: false,
            autoRuleAmountUsdc: null,
            autoRuleFrequency: null,
            autoRuleNextRun: null,
        },
    });
    res.json({ success: true, vault: updated });
});

exports.breakEarly = wrap(async function breakEarly(req, res) {
    const svc = req.app.get('vaultService');
    if (!req.body.confirmedBreak) {
        return res.status(400).json({
            success: false,
            message: 'Must explicitly confirmedBreak=true to break a vault early.',
        });
    }
    const vault = await svc.breakEarly({ userId: req.user.id, vaultId: req.params.id });
    await audit(req.app.get('prisma'), {
        actorId: req.user.id, actorName: req.user.username,
        action: 'VAULT_BROKEN_EARLY', targetType: 'VAULT', targetId: String(req.params.id),
        metadata: { penaltyUsdc: vault?.penaltyUsdc }, ipAddress: req.ip,
    });
    res.json({ success: true, vault });
});

exports.getReceipt = wrap(async function getReceipt(req, res) {
    const prisma = req.app.get('prisma');
    const vault = await prisma.vault.findUnique({ where: { id: req.params.id } });
    if (!vault || vault.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Vault not found' });
    }
    if (!vault.receiptSnapshot) {
        return res.status(404).json({ success: false, message: 'Receipt not yet generated' });
    }
    res.json({ success: true, receipt: vault.receiptSnapshot });
});

exports.listDeposits = wrap(async function listDeposits(req, res) {
    const prisma = req.app.get('prisma');
    const { id } = req.params;
    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault || vault.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Vault not found' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const cursor = req.query.cursor;
    const deposits = await prisma.vaultDeposit.findMany({
        where: { vaultId: id },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: limit,
        orderBy: { createdAt: 'desc' },
    });
    res.json({
        success: true,
        deposits,
        nextCursor: deposits.length === limit ? deposits[deposits.length - 1].id : null,
    });
});
