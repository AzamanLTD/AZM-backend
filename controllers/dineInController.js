const logger = require('../src/config/logger');
const dineInTabService = require('../services/dineInTabService');

const serviceOptions = (req, extra = {}) => ({
    io: req.app.get('socketio') || req.app.get('io'),
    ...extra,
});

exports.openTab = async (req, res) => {
    try {
        const result = await dineInTabService.openTab(req.prisma, serviceOptions(req, {
            businessProfileId: req.body.businessProfileId,
            userId: req.user.id,
            customerAzamanId: req.body.customerAzamanId,
            locationId: req.body.locationId,
            tableId: req.body.tableId,
        }));
        res.status(201).json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.addItem = async (req, res) => {
    try {
        const result = await dineInTabService.addItem(req.prisma, serviceOptions(req, {
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
        const result = await dineInTabService.addCustomerItem(req.prisma, serviceOptions(req, {
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
        const result = await dineInTabService.finalizeTab(req.prisma, serviceOptions(req, {
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
        const result = await dineInTabService.confirmAndPay(req.prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            customerId: req.user.id,
            tipUsdc: req.body.tipUsdc,
        }));
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getTab = async (req, res) => {
    try {
        const tab = await dineInTabService.getTab(req.prisma, serviceOptions(req, {
            tabId: req.params.tabId,
            customerId: req.user.id,
        }));
        const prisma = req.prisma || req.app.get('prisma');
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
        res.json({
            success: true,
            tab: tab ? { ...tab, table, businessProfile: business } : tab,
        });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getOpenTabs = async (req, res) => {
    try {
        const tabs = await dineInTabService.getOpenTabs(req.prisma, serviceOptions(req, {
            businessProfileId: req.query.businessProfileId,
            userId: req.user.id,
            status: req.query.status,
        }));
        res.json({ success: true, tabs });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.reportDefault = async (req, res) => {
    try {
        const result = await dineInTabService.reportDefault(req.prisma, serviceOptions(req, {
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
        const businessId = req.adminScopedBusiness?.id ||
            (await prisma.businessProfile.findFirst({
                where: { userId: req.user.id }, select: { id: true }
            }))?.id;

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

        const guests = await prisma.user.findMany({
            where: {
                OR: [
                    { username: { contains: query, mode: 'insensitive' } },
                    { azamanId: { contains: query, mode: 'insensitive' } },
                ]
            },
            select: { id: true, username: true, azamanId: true },
            take: 10,
        });

        res.json({ success: true, guests });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
