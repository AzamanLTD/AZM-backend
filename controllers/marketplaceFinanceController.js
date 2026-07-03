exports.getStats = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const business = await prisma.businessProfile.findFirst({
            where: { userId: req.user.id }, select: { id: true },
        });
        if (!business) return res.status(404).json({ success: false, message: 'No business profile.' });

        const [escrows, orders, invoices] = await Promise.all([
            prisma.smartEscrow.findMany({
                where: { payeeId: business.id },
                select: { status: true, amountUsdc: true },
            }),
            prisma.businessOrder.findMany({
                where: { businessProfileId: business.id },
                select: { status: true, totalAmount: true },
            }),
            prisma.businessInvoice.findMany({
                where: { businessProfileId: business.id },
                select: { status: true, totalAmount: true },
            }),
        ]);

        const totalEscrow = escrows.reduce((s, e) => s + Number(e.amountUsdc || 0), 0);
        const heldEscrow = escrows.filter(e => e.status === 'FUNDED')
            .reduce((s, e) => s + Number(e.amountUsdc || 0), 0);
        const releasedEscrow = escrows.filter(e => e.status === 'RELEASED')
            .reduce((s, e) => s + Number(e.amountUsdc || 0), 0);
        const refundedEscrow = escrows.filter(e => e.status === 'REFUNDED')
            .reduce((s, e) => s + Number(e.amountUsdc || 0), 0);

        res.json({
            success: true,
            stats: {
                totalEscrow,
                heldEscrow,
                releasedEscrow,
                refundedEscrow,
                totalOrders: orders.length,
                completedOrders: orders.filter(o => o.status === 'DELIVERED').length,
                totalInvoices: invoices.length,
                paidInvoices: invoices.filter(i => i.status === 'PAID').length,
            },
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getTransactions = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const business = await prisma.businessProfile.findFirst({
            where: { userId: req.user.id }, select: { id: true },
        });
        if (!business) return res.status(404).json({ success: false, message: 'No business profile.' });

        const escrows = await prisma.smartEscrow.findMany({
            where: { payeeId: business.id },
            include: {
                payer: { select: { id: true, username: true, azamanId: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        const transactions = escrows.map(e => ({
            id: e.id,
            type: 'ESCROW',
            amount: Number(e.amountUsdc || 0),
            status: e.status,
            customer: e.payer,
            createdAt: e.createdAt,
        }));

        res.json({ success: true, transactions });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
