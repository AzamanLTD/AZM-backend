const jwt = require('jsonwebtoken');

// Admin Business Scope — allows admin to act on behalf of any business
// Sets req.businessProfileId to the header value if the user is admin
exports.adminBusinessScope = async (req, res, next) => {
    let user = req.user;
    if (!user && req.headers.authorization?.startsWith('Bearer')) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            user = jwt.verify(token, process.env.JWT_SECRET);
            req.user = user;
        } catch (e) {
            // ignore
        }
    }

    if (user?.role === 'admin' && req.headers['x-admin-business-id']) {
        const prisma = req.app.get('prisma');
        const bizId = req.headers['x-admin-business-id'];

        const business = await prisma.businessProfile.findUnique({
            where: { id: bizId },
            select: { id: true, businessName: true, category: true, kybStatus: true },
        });

        if (business) {
            req.adminScopedBusiness = business;
            req.businessProfileId = bizId;
        }
    }
    next();
};
