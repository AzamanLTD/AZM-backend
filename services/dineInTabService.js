// Adapter: bridges dineInController to DineInService class
const DineInService = require('./marketplace/dineInService');

const service = (prisma, opts = {}) => new DineInService(prisma, opts.io);

exports.openTab = async (prisma, opts) => service(prisma, opts).openTab({
    businessProfileId: opts.businessProfileId,
    azamanId: opts.azamanId || opts.customerAzamanId,
    locationId: opts.locationId,
    tableId: opts.tableId,
});

exports.addItem = async (prisma, opts) => service(prisma, opts).addItem({
    tabId: opts.tabId,
    productId: opts.productId,
    name: opts.name,
    price: opts.price ?? opts.unitPriceUsdc,
    quantity: opts.quantity,
    notes: opts.notes,
    addedBy: opts.addedBy ?? opts.userId,
});

exports.addCustomerItem = async (prisma, opts) => service(prisma, opts).addCustomerItem({
    tabId: opts.tabId,
    customerId: opts.customerId ?? opts.userId,
    productId: opts.productId,
    selection: opts.selection,
    quantity: opts.quantity,
});

exports.finalizeTab = async (prisma, opts) => service(prisma, opts).finalizeTab(opts.tabId);

exports.getTabs = async (prisma, opts) => service(prisma, opts).getBusinessTabs(opts.businessProfileId, opts.status);

exports.getOpenTabs = exports.getTabs;

exports.getCustomerTabs = async (prisma, opts) => service(prisma, opts).getCustomerTabs(opts.userId, opts.status);

exports.getTab = async (prisma, { tabId, customerId, io }) => {
    const svc = new DineInService(prisma, io);
    const tab = await svc.getTab(tabId);
    if (!tab) throw new Error('Tab not found.');
    if (customerId != null && tab.customerId !== customerId) {
        throw new Error('Not authorized to view this tab.');
    }
    return tab;
};

exports.confirmTab = async (prisma, { tabId, customerId, io }) => service(prisma, { io }).confirmTab(tabId, customerId);

exports.confirmAndPay = async (prisma, { tabId, customerId, tipUsdc, io }) => {
    const svc = new DineInService(prisma, io);
    if (typeof svc.confirmAndPay === 'function') {
        return svc.confirmAndPay(tabId, customerId, { tipUsdc });
    }
    return svc.confirmTab(tabId, customerId);
};

exports.cancelTab = async (prisma, { tabId, io }) => service(prisma, { io }).cancelTab(tabId);

exports.reportDefault = exports.cancelTab;
