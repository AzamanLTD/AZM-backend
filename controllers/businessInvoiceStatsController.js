'use strict';

const getBusinessProfile = async (prisma, userId) => {
  const profile = await prisma.businessProfile.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (!profile) {
    const error = new Error('No business profile found.');
    error.status = 404;
    throw error;
  }
  return profile;
};

/**
 * GET /api/business/invoices/stats
 * Lifetime invoice counters for the business dashboard.
 * Uses database aggregates so the result is independent of list pagination.
 */
exports.getInvoiceStats = async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const profile = await getBusinessProfile(prisma, req.user.id);

    const [sent, paid, paidRevenue] = await Promise.all([
      prisma.businessInvoice.count({
        where: { businessProfileId: profile.id, status: 'SENT' },
      }),
      prisma.businessInvoice.count({
        where: { businessProfileId: profile.id, status: 'PAID' },
      }),
      prisma.businessInvoice.aggregate({
        where: { businessProfileId: profile.id, status: 'PAID' },
        _sum: { billTotalUsdc: true },
      }),
    ]);

    return res.json({
      success: true,
      stats: {
        sent,
        paid,
        paidRevenue: Number(paidRevenue._sum.billTotalUsdc || 0),
      },
    });
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }
};
