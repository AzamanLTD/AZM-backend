// Adapter: bridges dineInController to DineInService class
const DineInService = require('./marketplace/dineInService');

exports.openTab = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.openTab({
        businessProfileId: opts.businessProfileId,
        azamanId: opts.azamanId || opts.customerAzamanId,
        tableId: opts.tableId,
    });
};

exports.addItem = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.addItem({
        tabId: opts.tabId,
        name: opts.name,
        price: opts.price ?? opts.unitPriceUsdc,
        quantity: opts.quantity,
        notes: opts.notes,
        addedBy: opts.addedBy ?? opts.userId,
    });
};

exports.finalizeTab = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.finalizeTab(opts.tabId);
};

exports.getTabs = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.getBusinessTabs(opts.businessProfileId, opts.status);
};

exports.getOpenTabs = exports.getTabs;

exports.getCustomerTabs = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.getCustomerTabs(opts.userId, opts.status);
};

exports.getTab = async (prisma, { tabId, customerId }) => {
    const svc = new DineInService(prisma);
    const tab = await svc.getTab(tabId);
    if (!tab) throw new Error('Tab not found.');
    if (customerId != null && tab.customerId !== customerId) {
        throw new Error('Not authorized to view this tab.');
    }
    return tab;
};

exports.confirmTab = async (prisma, { tabId, customerId }) => {
    const svc = new DineInService(prisma);
    return svc.confirmTab(tabId, customerId);
};

// Compatibility alias for the existing controller route. This performs the
// domain's confirmation step only; payment/escrow is not fabricated here.
exports.confirmAndPay = exports.confirmTab;

exports.cancelTab = async (prisma, { tabId }) => {
    const svc = new DineInService(prisma);
    return svc.cancelTab(tabId);
};

// Existing business route name maps to the domain's cancellation operation.
exports.reportDefault = exports.cancelTab;
