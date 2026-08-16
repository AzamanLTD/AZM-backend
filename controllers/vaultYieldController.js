// controllers/vaultYieldController.js
// =============================================================================
// AZAMAN — Vault DeFi Yield Controller (Phase 3)
//
// Enables vaults to earn yield through simulated DeFi protocols (Aave, Compound,
// or internal LP). In production, these would integrate with on-chain smart
// contracts; currently runs as a mock/simulated APR for display and tracking.
//
// Endpoints:
//   GET  /api/vaults/yield/strategies              — list available strategies
//   POST /api/vaults/:id/yield/enable              — enable yield for a vault
//   POST /api/vaults/:id/yield/disable             — disable yield
//   POST /api/vaults/:id/yield/compound             — manually compound
//   GET  /api/vaults/:id/yield/earnings            — get yield earnings history
// =============================================================================

const logger = require('../src/config/logger');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[vaultYieldCtrl] ${fn.name}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

// Available DeFi yield strategies (seeded or fetched from on-chain oracle)
const STRATEGIES = [
    {
        id: 'aave-v3',
        name: 'AAVE',
        displayName: 'Aave V3 — Stablecoin Pool',
        protocol: 'AAVE',
        apr: 0.0450,
        riskLevel: 'LOW',
        minAmountUsdc: 10,
        maxAmountUsdc: null,
        description: 'Supply USDC to Aave V3 lending pool. Earns variable APR from borrower interest. Funds are over-collateralized and liquidation-protected.',
        logoUrl: 'https://cryptologos.cc/logos/aave-aave-logo.png',
    },
    {
        id: 'compound-v3',
        name: 'COMPOUND',
        displayName: 'Compound V3 — USDC Market',
        protocol: 'COMPOUND',
        apr: 0.0385,
        riskLevel: 'LOW',
        minAmountUsdc: 10,
        maxAmountUsdc: null,
        description: 'Supply USDC to Compound V3 market. Earns COMP rewards + interest. Audited smart contracts, battle-tested since 2020.',
        logoUrl: 'https://cryptologos.cc/logos/compound-comp-logo.png',
    },
    {
        id: 'internal-lp',
        name: 'INTERNAL_LP',
        displayName: 'AZAMAN Internal LP',
        protocol: 'INTERNAL',
        apr: 0.0650,
        riskLevel: 'MEDIUM',
        minAmountUsdc: 50,
        maxAmountUsdc: 50000,
        description: 'Provide liquidity to AZAMAN P2P matching pool. Higher APR from trade fees, but carries platform risk. AZM bonus rewards on top.',
        logoUrl: null,
    },
];

// GET /api/vaults/yield/strategies
exports.listStrategies = wrap(async function listStrategies(req, res) {
    const prisma = req.app.get('prisma');

    // Try to fetch from DB, fall back to constants
    let strategies = [];
    try {
        strategies = await prisma.deFiYieldStrategy.findMany({
            where: { isActive: true },
            orderBy: { apr: 'desc' },
        });
    } catch (e) {
        // Table might not exist yet in prod (overlay hasn't run)
        logger.warn('[vaultYield] DeFiYieldStrategy table not found, using constants');
    }

    if (!strategies.length) {
        strategies = STRATEGIES;
    }

    res.json({ success: true, strategies });
});

// POST /api/vaults/:id/yield/enable
exports.enableYield = wrap(async function enableYield(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;
    const { strategy } = req.body;

    if (!strategy) return res.status(400).json({ success: false, message: 'Strategy name required' });

    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });
    if (vault.status !== 'ACTIVE') return res.status(400).json({ success: false, message: 'Vault must be active' });

    // Find the strategy
    const strat = STRATEGIES.find(s => s.name === strategy);
    if (!strat) return res.status(400).json({ success: false, message: 'Unknown strategy' });

    if (parseFloat(vault.currentAmountUsdc) < strat.minAmountUsdc) {
        return res.status(400).json({ success: false, message: `Minimum $${strat.minAmountUsdc} required for ${strat.displayName}` });
    }

    const updated = await prisma.vault.update({
        where: { id },
        data: {
            yieldEnabled: true,
            yieldStrategy: strategy,
            yieldApr: strat.apr,
            yieldAutoCompound: true,
            yieldLastCompoundAt: new Date(),
        },
    });

    res.json({ success: true, vault: updated, strategy: strat });
});

// POST /api/vaults/:id/yield/disable
exports.disableYield = wrap(async function disableYield(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;

    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });

    const updated = await prisma.vault.update({
        where: { id },
        data: {
            yieldEnabled: false,
            yieldStrategy: null,
            yieldApr: 0,
        },
    });

    res.json({ success: true, vault: updated });
});

// POST /api/vaults/:id/yield/compound — manually trigger compounding
exports.compound = wrap(async function compound(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;

    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });
    if (!vault.yieldEnabled) return res.status(400).json({ success: false, message: 'Yield not enabled' });

    // Calculate earned since last compound
    const now = new Date();
    const lastCompound = vault.yieldLastCompoundAt || vault.startDate;
    const secondsElapsed = (now - lastCompound) / 1000;
    const daysElapsed = secondsElapsed / 86400;

    // Daily compounding: APR / 365 * principal
    const apr = parseFloat(vault.yieldApr);
    const principal = parseFloat(vault.currentAmountUsdc);
    const earned = principal * apr * (daysElapsed / 365);

    if (earned <= 0) {
        return res.json({ success: true, message: 'No yield to compound yet', earned: 0, vault });
    }

    // Add yield to vault balance
    const updated = await prisma.vault.update({
        where: { id },
        data: {
            yieldEarnedUsdc: { increment: earned },
            currentAmountUsdc: { increment: earned },
            yieldLastCompoundAt: now,
        },
    });

    res.json({ success: true, earned, vault: updated });
});

// GET /api/vaults/:id/yield/earnings — get yield summary
exports.getEarnings = wrap(async function getEarnings(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;

    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });

    // Calculate projected earnings
    const apr = parseFloat(vault.yieldApr);
    const principal = parseFloat(vault.currentAmountUsdc);
    const now = new Date();
    const maturity = vault.maturityDate;
    const daysToMaturity = Math.max(0, (maturity - now) / 86400000);

    const projectedEarned = vault.yieldEnabled
        ? principal * apr * (daysToMaturity / 365)
        : 0;

    // Estimate daily earnings
    const dailyEarned = vault.yieldEnabled
        ? (principal + parseFloat(vault.yieldEarnedUsdc)) * apr / 365
        : 0;

    res.json({
        success: true,
        yield: {
            enabled: vault.yieldEnabled,
            strategy: vault.yieldStrategy,
            apr: apr,
            earnedUsdc: parseFloat(vault.yieldEarnedUsdc),
            projectedUsdc: projectedEarned,
            dailyEarnedUsdc: dailyEarned,
            autoCompound: vault.yieldAutoCompound,
            lastCompoundAt: vault.yieldLastCompoundAt,
            daysToMaturity: Math.ceil(daysToMaturity),
        },
    });
});

// POST /api/vaults/:id/yield/toggle-auto — toggle auto-compounding
exports.toggleAutoCompound = wrap(async function toggleAutoCompound(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;

    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });
    if (!vault.yieldEnabled) return res.status(400).json({ success: false, message: 'Yield not enabled' });

    const updated = await prisma.vault.update({
        where: { id },
        data: { yieldAutoCompound: !vault.yieldAutoCompound },
    });

    res.json({ success: true, vault: updated });
});
