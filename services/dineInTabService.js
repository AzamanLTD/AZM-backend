// Adapter: bridges dineInController to DineInService class
const DineInService = require('./marketplace/dineInService');
const { notifyDineInEvent } = require('./bizNotificationService');

const service = (prisma, opts = {}) => new DineInService(prisma, opts.io);

const notify = (prisma, opts, result, type, extra = {}) => notifyDineInEvent(prisma, {
    businessProfileId: extra.businessProfileId || result?.businessProfileId || result?.tab?.businessProfileId,
    tabId: extra.tabId || result?.id || result?.tab?.id,
    type,
    totalAmount: extra.totalAmount,
    extraMetadata: extra.metadata,
    io: opts?.io,
}).catch(() => null);

exports.openTab = async (prisma, opts) => {
    const result = await service(prisma, opts).openTab({ businessProfileId: opts.businessProfileId, azamanId: opts.azamanId || opts.customerAzamanId, locationId: opts.locationId, tableId: opts.tableId });
    await notify(prisma, opts, result, 'DINE_IN_TAB_OPENED');
    return result;
};

exports.addItem = async (prisma, opts) => service(prisma, opts).addItem({ tabId: opts.tabId, productId: opts.productId, name: opts.name, price: opts.price ?? opts.unitPriceUsdc, quantity: opts.quantity, notes: opts.notes, addedBy: opts.addedBy ?? opts.userId });

exports.addCustomerItem = async (prisma, opts) => service(prisma, opts).addCustomerItem({ tabId: opts.tabId, customerId: opts.customerId ?? opts.userId, productId: opts.productId, selection: opts.selection, quantity: opts.quantity });

exports.finalizeTab = async (prisma, opts) => {
    const result = await service(prisma, opts).finalizeTab(opts.tabId);
    await notify(prisma, opts, result, 'DINE_IN_TAB_FINALIZED', { tabId: opts.tabId, totalAmount: result?.grandTotalUsdc ?? result?.subtotalUsdc });
    return result;
};

exports.getTabs = async (prisma, opts) => service(prisma, opts).getBusinessTabs(opts.businessProfileId, opts.status);
exports.getOpenTabs = exports.getTabs;
exports.getCustomerTabs = async (prisma, opts) => service(prisma, opts).getCustomerTabs(opts.userId, opts.status);

exports.getTab = async (prisma, { tabId, customerId, businessProfileId, io }) => {
    const svc = new DineInService(prisma, io);
    const tab = await svc.getTab(tabId);
    if (!tab) throw new Error('Tab not found.');
    const isBusinessReader = businessProfileId != null && tab.businessProfile?.id === businessProfileId;
    const isCustomerReader = customerId != null && tab.customerId === customerId;
    if (!isBusinessReader && !isCustomerReader) throw new Error('Not authorized to view this tab.');
    return tab;
};

exports.confirmTab = async (prisma, { tabId, customerId, io }) => service(prisma, { io }).confirmTab(tabId, customerId);

exports.confirmAndPay = async (prisma, { tabId, customerId, tipUsdc, io }) => {
    const svc = new DineInService(prisma, io);
    if (typeof svc.confirmAndPay === 'function') {
        const result = await svc.confirmAndPay(tabId, customerId, { tipUsdc });
        if (result?.payment?.alreadyPaid && result.tab?.status === 'FINALIZED') result.tab = await svc.confirmTab(tabId, customerId);
        if (!result?.payment?.alreadyPaid) {
            await notify(prisma, { io }, result, 'DINE_IN_TAB_PAID', { tabId, totalAmount: result?.tab?.grandTotalUsdc, metadata: { invoiceId: result?.invoice?.id || result?.payment?.invoice?.id } });
        }
        return result;
    }
    return svc.confirmTab(tabId, customerId);
};

exports.cancelTab = async (prisma, opts) => service(prisma, opts).cancelTab(opts.tabId);
exports.reportDefault = exports.cancelTab;
