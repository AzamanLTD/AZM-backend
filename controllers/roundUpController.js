// controllers/roundUpController.js
// =============================================================================
// AZAMAN — Round-Up Savings Controller (Phase 3)
//
// Cash App / Acorns-style: every debit transaction rounds up to the nearest
// dollar and the difference auto-deposits into a target vault.
//
// GET  /api/round-up          — get user's round-up settings
// PUT  /api/round-up          — update settings (enable/disable, target vault, multiplier)
// GET  /api/round-up/history  — recent round-up contributions
// POST /api/round-up/process  — process a round-up for a given transaction amount
// =============================================================================

const logger = require('../src/config/logger');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[roundUpCtrl] ${fn.name}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

// GET /api/round-up
exports.getSettings = wrap(async function getSettings(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    let settings = await prisma.roundUpSettings.findUnique({
        where: { userId },
        include: { targetVault: true },
    });

    if (!settings) {
        settings = await prisma.roundUpSettings.create({
            data: { userId, enabled: false },
            include: { targetVault: true },
        });
    }

    res.json({ success: true, settings });
});

// PUT /api/round-up
exports.updateSettings = wrap(async function updateSettings(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { enabled, targetVaultId, multiplier } = req.body;

    const data = {};
    if (typeof enabled === 'boolean') data.enabled = enabled;
    if (targetVaultId !== undefined) {
        // Verify vault belongs to user
        if (targetVaultId) {
            const vault = await prisma.vault.findUnique({ where: { id: targetVaultId } });
            if (!vault || vault.userId !== userId) {
                return res.status(404).json({ success: false, message: 'Target vault not found' });
            }
        }
        data.targetVaultId = targetVaultId || null;
    }
    if (typeof multiplier === 'number' && multiplier > 0) data.multiplier = multiplier;

    const settings = await prisma.roundUpSettings.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
        include: { targetVault: true },
    });

    res.json({ success: true, settings });
});

// POST /api/round-up/process
// Called after a transaction to compute & deposit the round-up amount
exports.processRoundUp = wrap(async function processRoundUp(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { amountUsdc } = req.body;

    if (typeof amountUsdc !== 'number' || amountUsdc <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const settings = await prisma.roundUpSettings.findUnique({
        where: { userId },
        include: { targetVault: true },
    });

    if (!settings || !settings.enabled) {
        return res.json({ success: true, roundUpAmount: 0, message: 'Round-up not enabled' });
    }

    // Compute round-up
    const multiplier = settings.multiplier || 1.0;
    const rounded = Math.ceil(amountUsdc / multiplier) * multiplier;
    const roundUpAmount = Math.round((rounded - amountUsdc) * 100) / 100;

    if (roundUpAmount <= 0) {
        return res.json({ success: true, roundUpAmount: 0 });
    }

    // Deposit into target vault if set
    if (settings.targetVaultId) {
        await prisma.$transaction([
            prisma.vault.update({
                where: { id: settings.targetVaultId },
                data: {
                    currentAmountUsdc: { increment: roundUpAmount },
                    totalAzmEarned: { increment: roundUpAmount * 0.01 }, // 1% AZM reward
                },
            }),
            prisma.vaultDeposit.create({
                data: {
                    vaultId: settings.targetVaultId,
                    userId,
                    amountUsdc: roundUpAmount,
                    type: 'ROUND_UP',
                },
            }),
            prisma.roundUpSettings.update({
                where: { userId },
                data: { totalSavedUsdc: { increment: roundUpAmount } },
            }),
        ]);
    } else {
        // No vault — just track total
        await prisma.roundUpSettings.update({
            where: { userId },
            data: { totalSavedUsdc: { increment: roundUpAmount } },
        });
    }

    res.json({ success: true, roundUpAmount, totalSaved: settings.totalSavedUsdc + roundUpAmount });
});

// GET /api/round-up/history
exports.getHistory = wrap(async function getHistory(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    const settings = await prisma.roundUpSettings.findUnique({
        where: { userId },
    });

    if (!settings || !settings.targetVaultId) {
        return res.json({ success: true, history: [] });
    }

    const history = await prisma.vaultDeposit.findMany({
        where: {
            vaultId: settings.targetVaultId,
            type: 'ROUND_UP',
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });

    res.json({ success: true, history });
});
