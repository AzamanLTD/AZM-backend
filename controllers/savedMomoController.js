// controllers/savedMomoController.js
// =============================================================================
// AZAMAN — SAVED MOMO ACCOUNTS  (Master Sprint v2, 2026-05-27)
//
// Endpoints:
//   POST  /api/saved-momo/lookup     — resolve registered name (no save)
//   POST  /api/saved-momo            — create (requires password re-confirm
//                                       OR 2FA token if enabled)
//   GET   /api/saved-momo            — list
//   PATCH /api/saved-momo/:id        — rename / mark primary
//   DELETE /api/saved-momo/:id
// =============================================================================

const logger = require('../src/config/logger');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[savedMomoController] ${fn.name || 'h'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// PUBLIC: name lookup (does NOT persist anything)
// =============================================================================
exports.lookup = wrap(async function lookup(req, res) {
    const { provider, phoneNumber } = req.body;
    const svc = req.app.get('momoNameLookupService');
    if (!svc) {
        return res.status(500).json({ success: false, message: 'Name lookup service not configured.' });
    }
    const result = await svc.resolveName({ provider, phoneNumber });
    if (!result.ok) {
        return res.status(400).json({ success: false, message: result.message });
    }
    res.json({ success: true, name: result.name, msisdn: result.msisdn, provider: result.provider });
});

// =============================================================================
// CREATE — gated by password re-confirm OR 2FA token
// =============================================================================
exports.create = wrap(async function create(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { nickname, provider, phoneNumber, password, totpToken, isPrimary = false } = req.body;

    if (!nickname || !provider || !phoneNumber) {
        return res.status(400).json({
            success: false,
            message: 'nickname, provider, and phoneNumber are required.',
        });
    }

    // Security gate
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { password: true, isTwoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) return res.status(401).json({ success: false, message: 'Auth failed.' });

    if (user.isTwoFactorEnabled) {
        if (!totpToken) {
            return res.status(401).json({
                success: false,
                code: '2FA_REQUIRED',
                message: 'Two-factor token required to save a payout destination.',
            });
        }
        const ok = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: totpToken,
            window: 1,
        });
        if (!ok) {
            return res.status(401).json({ success: false, message: 'Invalid 2FA token.' });
        }
    } else {
        if (!password) {
            return res.status(401).json({
                success: false,
                code: 'PASSWORD_REQUIRED',
                message: 'Password required to save a payout destination.',
            });
        }
        const matches = await bcrypt.compare(password, user.password);
        if (!matches) {
            return res.status(401).json({ success: false, message: 'Invalid password.' });
        }
    }

    // Resolve name via lookup (best-effort — we still save if lookup fails so
    // users with edge-case numbers aren't blocked, but we mark unverified).
    let accountName = null;
    let isVerified = false;
    try {
        const svc = req.app.get('momoNameLookupService');
        const lookupRes = await svc.resolveName({ provider, phoneNumber });
        if (lookupRes.ok) {
            accountName = lookupRes.name;
            isVerified = true;
            // Use normalised phone the lookup returned
            req.body.phoneNumber = lookupRes.msisdn;
        }
    } catch (_) { /* swallow */ }

    // Optional primary flip — clear other primaries first
    if (isPrimary) {
        await prisma.savedMomoAccount.updateMany({
            where: { userId, isPrimary: true },
            data: { isPrimary: false },
        });
    }

    const created = await prisma.savedMomoAccount.create({
        data: {
            userId,
            nickname: String(nickname).slice(0, 40),
            provider,
            phoneNumber: req.body.phoneNumber,
            accountName,
            isVerified,
            isPrimary,
        },
    });

    res.status(201).json({ success: true, account: created });
});

exports.list = wrap(async function list(req, res) {
    const prisma = req.app.get('prisma');
    const accounts = await prisma.savedMomoAccount.findMany({
        where: { userId: req.user.id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, accounts });
});

exports.update = wrap(async function update(req, res) {
    const prisma = req.app.get('prisma');
    const { id } = req.params;
    const { nickname, isPrimary } = req.body;

    const acc = await prisma.savedMomoAccount.findUnique({ where: { id } });
    if (!acc || acc.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    if (isPrimary === true) {
        await prisma.savedMomoAccount.updateMany({
            where: { userId: req.user.id, isPrimary: true },
            data: { isPrimary: false },
        });
    }

    const updated = await prisma.savedMomoAccount.update({
        where: { id },
        data: {
            ...(nickname ? { nickname: String(nickname).slice(0, 40) } : {}),
            ...(isPrimary !== undefined ? { isPrimary: !!isPrimary } : {}),
        },
    });
    res.json({ success: true, account: updated });
});

exports.remove = wrap(async function remove(req, res) {
    const prisma = req.app.get('prisma');
    const { id } = req.params;
    const acc = await prisma.savedMomoAccount.findUnique({ where: { id } });
    if (!acc || acc.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Account not found.' });
    }
    await prisma.savedMomoAccount.delete({ where: { id } });
    res.json({ success: true });
});
