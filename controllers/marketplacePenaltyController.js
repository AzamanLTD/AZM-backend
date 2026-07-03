const { PenaltyPolicyService } = require('../services/marketplace/penaltyPolicyService');

exports.getPolicy = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const business = await prisma.businessProfile.findFirst({
            where: { userId: req.user.id }, select: { id: true },
        });
        if (!business) return res.status(404).json({ success: false, message: 'No business profile.' });

        const svc = new PenaltyPolicyService(prisma);
        const policy = await svc.getOrCreateDefault(business.id);
        res.json({ success: true, policy });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updatePolicy = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const business = await prisma.businessProfile.findFirst({
            where: { userId: req.user.id }, select: { id: true },
        });
        if (!business) return res.status(404).json({ success: false, message: 'No business profile.' });

        const svc = new PenaltyPolicyService(prisma);
        const policy = await svc.update(business.id, req.body);
        res.json({ success: true, policy });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};
