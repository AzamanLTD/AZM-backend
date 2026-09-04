'use strict';

const { getReadPrisma } = require('../src/config/readReplica');

function numeric(value) {
  return Number(value || 0);
}

/**
 * Compatibility replacement for the legacy /admin/stats payload.
 * Keeps existing keys while adding the fields consumed by the Volume
 * dashboard. Fiat figures are explicitly GHS; crypto figures are USDC.
 */
exports.getPlatformStats = async (req, res) => {
  const prisma = getReadPrisma(req.app);
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, activeDisputes, allTimeFiat, fiat24h, crypto24h] = await Promise.all([
      prisma.user.count(),
      prisma.trade.count({ where: { status: 'DISPUTED' } }),
      prisma.trade.aggregate({
        where: { status: 'COMPLETED', currency: 'GHS' },
        _sum: { amountFiat: true },
      }),
      prisma.trade.aggregate({
        where: { status: 'COMPLETED', currency: 'GHS', createdAt: { gte: since24h } },
        _sum: { amountFiat: true },
      }),
      prisma.trade.aggregate({
        where: { status: 'COMPLETED', createdAt: { gte: since24h } },
        _sum: { amountCrypto: true },
      }),
    ]);

    const totalFiatVolume = numeric(allTimeFiat._sum.amountFiat);
    const fiatVolume24h = numeric(fiat24h._sum.amountFiat);
    const cryptoVolume24h = numeric(crypto24h._sum.amountCrypto);

    // Preserve the legacy metric semantics rather than silently redefining
    // platform PnL while the dedicated profit-breakdown endpoint remains the
    // authoritative admin profit surface.
    const estimatedPlatformProfitGhs = (totalFiatVolume * 0.015).toFixed(2);

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        activeDisputes,
        totalFiatVolume,
        fiatVolume24h,
        cryptoVolume24h,
        totalAdminProfit: estimatedPlatformProfitGhs,
        currencies: {
          fiat: 'GHS',
          crypto: 'USDC',
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
