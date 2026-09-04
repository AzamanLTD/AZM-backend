const dineInTabService = require('../services/dineInTabService');
const { resolvePermissions } = require('../middleware/requirePermission');

const serviceOptions = (req, extra = {}) => ({
    ...extra,
    io: req.app && typeof req.app.get === 'function'
        ? (req.app.get('socketio') || req.app.get('io'))
        : undefined,
});

// Business-side controllers derive the effective business from trusted admin
// scope or the authenticated user's owned profile. Never trust a body/query
// businessProfileId because the service accepts that identifier directly.
const getEffectiveBusinessProfileId = async (req, prisma) => {
    if (req.adminScopedBusiness?.id) return req.adminScopedBusiness.id;
    if (req.user?.role === 'ADMIN' && req.businessProfileId) return req.businessProfileId;
    const profile = await prisma.businessProfile.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
    });
    return profile?.id || null;
};

exports.openTab = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const businessProfileId = await getEffectiveBusinessProfileId(req, prisma);
        if (!businessProfileId) return res.status(403).json({ success: false, message: 'No business profile.' });
        const result = await dineInTabService.openTab(prisma, serviceOptions(req, {
            businessProfileId,
            customerAzamanId: req.body.customerAzamanId,
            locationId: req.body.locationId,
            tableId: req.body.tableId,
        }));
        res.status(201).json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.addItem = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const result = await dineInTabService.addItem(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            userId: req.user.id,
            productId: req.body.productId,
            name: req.body.name,
            unitPriceUsdc: req.body.unitPriceUsdc,
            quantity: req.body.quantity,
        }));
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.addCustomerItem = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const result = await dineInTabService.addCustomerItem(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            customerId: req.user.id,
            productId: req.body.productId,
            selection: req.body.selection ?? req.body.variants ?? {},
            quantity: req.body.quantity,
        }));
        res.status(201).json({ success: true, item: result });
    } catch (err) { res.status(err.status || 400).json({ success: false, message: err.message }); }
};

exports.finalizeTab = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const result = await dineInTabService.finalizeTab(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            userId: req.user.id,
            taxRatePct: req.body.taxRatePct,
            tipUsdc: req.body.tipUsdc,
        }));
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.confirmAndPay = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const result = await dineInTabService.confirmAndPay(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            customerId: req.user.id,
            tipUsdc: req.body.tipUsdc,
        }));
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getTab = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        // This endpoint serves both customer clients and the business portal.
        // A business identity is only granted to the shared-read adapter after
        // resolving the same canonical permission used by business mutations.
        // Otherwise the request remains customer-scoped by req.user.id.
        const candidateBusinessProfileId = await getEffectiveBusinessProfileId(req, prisma);
        let businessProfileId = null;
        if (candidateBusinessProfileId) {
            const permissions = await resolvePermissions(prisma, req.user.id, candidateBusinessProfileId);
            if (permissions.includes('*') || permissions.includes('restaurant.dinein.manage')) {
                businessProfileId = candidateBusinessProfileId;
            }
        }
        const tab = await dineInTabService.getTab(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            customerId: req.user.id,
            businessProfileId,
        }));
        const table = tab?.tableId
            ? await prisma.businessTable.findUnique({
                where: { id: tab.tableId },
                select: { id: true, label: true, locationId: true, isActive: true },
            })
            : null;
        const business = tab?.businessProfile?.id
            ? await prisma.businessProfile.findUnique({
                where: { id: tab.businessProfile.id },
                select: { id: true, bizId: true, businessName: true, logoUrl: true },
            })
            : tab?.businessProfile;
        res.json({ success: true, tab: tab ? { ...tab, table, businessProfile: business } : tab });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getOpenTabs = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const businessProfileId = await getEffectiveBusinessProfileId(req, prisma);
        if (!businessProfileId) return res.status(403).json({ success: false, message: 'No business profile.' });
        const tabs = await dineInTabService.getOpenTabs(prisma, serviceOptions(req, {
            businessProfileId,
            userId: req.user.id,
            status: req.query.status,
        }));
        res.json({ success: true, tabs });
    } catch (err) { res.status(400).json({ success: false, message: err.message });
    }
};

exports.reportDefault = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const result = await dineInTabService.reportDefault(prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            userId: req.user.id,
            reason: req.body.reason,
        }));
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getGuests = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const businessId = await getEffectiveBusinessProfileId(req, prisma);
        if (!businessId) return res.status(404).json({ success: false, message: 'No business profile.' });

        const guests = await prisma.dineInTab.findMany({
            where: { businessProfileId: businessId },
            include: { customer: { select: { id: true, username: true, azamanId: true } } },
            distinct: ['customerId'],
            take: 50,
        });
        res.json({ success: true, guests: guests.map(g => g.customer) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.searchGuests = async (req, res) => {
    try {
        const prisma = req.prisma || req.app.get('prisma');
        const { query } = req.query;
        if (!query) return res.json({ success: true, guests: [] });

        const businessId = await getEffectiveBusinessProfileId(req, prisma);
        if (!businessId) return res.status(404).json({ success: false, message: 'No business profile.' });

        const guests = await prisma.dineInTab.findMany({
            where: {
                businessProfileId: businessId,
                customer: {
                    OR: [
                        { username: { contains: query, mode: 'insensitive' } },
                        { azamanId: { contains: query, mode: 'insensitive' } },
                    ],
                },
            },
            select: { customer: { select: { id: true, username: true, azamanId: true } } },
            distinct: ['customerId'],
            take: 10,
        });
        res.json({ success: true, guests: guests.map(g => g.customer) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports.serviceOptions = serviceOptions;
