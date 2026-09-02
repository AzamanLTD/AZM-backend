// Adapter: bridges dineInController to DineInService class
const DineInService = require('./marketplace/dineInService');

const service = (prisma, opts = {}) => new DineInService(prisma, opts.io);

exports.openTab = async (prisma, opts) => service(prisma, opts).openTab({
    businessProfileId: opts.businessProfileId,
    azamanId: opts.azamanId || opts.customerAzamanId,
    tableId: opts.tableId,
});

exports.addItem = async (prisma, opts) => service(prisma, opts).addItem({
    tabId: opts.tabId,
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

exports.getTab = async (prisma, opts) => {
    const svc = service(prisma, opts);
    const tab = await svc.getTab(opts.tabId);
    if (!tab) throw new Error('Tab not found.');
    if (opts.customerId != null && tab.customerId !== opts.customerId) {
        throw new Error('Not authorized to view this tab.');
    }
    return tab;
};

exports.confirmTab = async (prisma, opts) => service(prisma, opts).confirmTab(opts.tabId, opts.customerId);

exports.confirmAndPay = async (prisma, opts) => service(prisma, opts).confirmAndPay(opts.tabId, opts.customerId, { tipUsdc: opts.tipUsdc });

exports.cancelTab = async (prisma, opts) => service(prisma, opts).cancelTab(opts.tabId);

exports.reportDefault = exports.cancelTab;
