const dineInTabService = require('../services/dineInTabService');

exports.openTab = async (req, res) => {
    try {
        const result = await dineInTabService.openTab(req.prisma, {
            businessProfileId: req.body.businessProfileId,
            userId: req.user.id,
            customerAzamanId: req.body.customerAzamanId,
            locationId: req.body.locationId,
            tableId: req.body.tableId,
        });
        res.status(201).json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.addItem = async (req, res) => {
    try {
        const result = await dineInTabService.addItem(req.prisma, {
            tabId: req.params.tabId,
            userId: req.user.id,
            productId: req.body.productId,
            name: req.body.name,
            unitPriceUsdc: req.body.unitPriceUsdc,
            quantity: req.body.quantity,
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.finalizeTab = async (req, res) => {
    try {
        const result = await dineInTabService.finalizeTab(req.prisma, {
            tabId: req.params.tabId,
            userId: req.user.id,
            taxRatePct: req.body.taxRatePct,
            tipUsdc: req.body.tipUsdc,
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.confirmAndPay = async (req, res) => {
    try {
        const result = await dineInTabService.confirmAndPay(req.prisma, {
            tabId: req.params.tabId,
            customerId: req.user.id,
            tipUsdc: req.body.tipUsdc,
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getTab = async (req, res) => {
    try {
        const tab = await dineInTabService.getTab(req.prisma, {
            tabId: req.params.tabId,
            customerId: req.user.id,
        });
        res.json({ success: true, tab });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.getOpenTabs = async (req, res) => {
    try {
        const tabs = await dineInTabService.getOpenTabs(req.prisma, {
            businessProfileId: req.query.businessProfileId,
            userId: req.user.id,
            status: req.query.status,
        });
        res.json({ success: true, tabs });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.reportDefault = async (req, res) => {
    try {
        const result = await dineInTabService.reportDefault(req.prisma, {
            tabId: req.params.tabId,
            userId: req.user.id,
            reason: req.body.reason,
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};
