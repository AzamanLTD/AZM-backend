// Adapter: bridges dineInController to DineInService class
const DineInService = require('./marketplace/dineInService');
const { notifyDineInEvent } = require('./bizNotificationService');
const {
    addItem: addItemAtomically,
    addCustomerItem: addCustomerItemAtomically,
    removeItem: removeItemAtomically,
} = require('./dineInTabMutationService');

const service = (prisma, opts = {}) => new DineInService(prisma, opts.io);

const notify = (prisma, opts, result, type, extra = {}) => notifyDineInEvent(prisma, {
    businessProfileId: extra.businessProfileId || result?.businessProfileId || result?.tab?.businessProfileId,
    tabId: extra.tabId || result?.id || result?.tab?.id,
    type,
    totalAmount: extra.totalAmount,
    extraMetadata: extra.metadata,
    io: opts?.io,
}).catch(() => null);

const normalizeQuantity = (quantity) => {
    const qty = Number(quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw new Error('quantity must be an integer from 1 to 50.');
    }
    return qty;
};

const replayPaymentFromDurableState = (tab) => {
    const invoice = tab?.invoice;
    if (!tab || invoice?.status !== 'PAID' || !invoice.payTxHash) return null;
    const billPlusTip = Number(invoice.billTotalUsdc || 0) + Number(invoice.tipUsdc || 0);
    const fee = Number(invoice.feeUsdc || 0);
    const businessReceives = invoice.customerCoveredFee ? billPlusTip : billPlusTip - fee;
    return {
        tab,
        invoice,
        payment: {
            invoice,
            customerPays: Number(invoice.customerPaidUsdc || 0),
            businessReceives,
            fee,
            alreadyPaid: true,
        },
    };
};

const notifyRecoveredPayment = async (prisma, tab, io) => {
    await notify(prisma, { io }, {
        tab,
        businessProfileId: tab?.businessProfileId,
    }, 'DINE_IN_TAB_PAID', {
        tabId: tab?.id,
        totalAmount: Number(tab?.invoice?.customerPaidUsdc || 0),
        metadata: { invoiceId: tab?.invoice?.id },
    });
};

exports.openTab = async (prisma, opts) => {
    const result = await service(prisma, opts).openTab({ businessProfileId: opts.businessProfileId, azamanId: opts.azamanId || opts.customerAzamanId, locationId: opts.locationId, tableId: opts.tableId });
    await notify(prisma, opts, result, 'DINE_IN_TAB_OPENED');
    return result;
};

exports.addItem = async (prisma, opts) => addItemAtomically(prisma, {
    tabId: opts.tabId,
    productId: opts.productId,
    name: opts.name,
    price: opts.price ?? opts.unitPriceUsdc,
    quantity: normalizeQuantity(opts.quantity),
    notes: opts.notes,
    addedBy: opts.addedBy ?? opts.userId,
    io: opts.io,
});

exports.addCustomerItem = async (prisma, opts) => addCustomerItemAtomically(prisma, {
    tabId: opts.tabId,
    customerId: opts.customerId ?? opts.userId,
    productId: opts.productId,
    selection: opts.selection,
    quantity: normalizeQuantity(opts.quantity),
    io: opts.io,
});

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
    // Preserve the adapter's historical compatibility contract for service
    // implementations that expose only confirmTab. The durable replay recovery
    // path requires confirmAndPay + getTab and is intentionally opt-in.
    if (typeof svc.confirmAndPay !== 'function') {
        return svc.confirmTab(tabId, customerId);
    }

    try {
        const result = await svc.confirmAndPay(tabId, customerId, { tipUsdc });
        if (result?.payment?.alreadyPaid && result.tab?.status === 'FINALIZED') result.tab = await svc.confirmTab(tabId, customerId);
        if (!result?.payment?.alreadyPaid) {
            await notify(prisma, { io }, result, 'DINE_IN_TAB_PAID', { tabId, totalAmount: result?.tab?.grandTotalUsdc, metadata: { invoiceId: result?.invoice?.id || result?.payment?.invoice?.id } });
        }
        return result;
    } catch (error) {
        if (typeof svc.getTab !== 'function') throw error;
        const recovered = replayPaymentFromDurableState(await svc.getTab(tabId));
        if (!recovered || recovered.tab.customerId !== customerId) throw error;

        if (recovered.tab.status === 'FINALIZED') {
            try {
                recovered.tab = await svc.confirmTab(tabId, customerId);
                recovered.payment.invoice = recovered.tab?.invoice || recovered.invoice;
            } catch (recoveryError) {
                const reread = await svc.getTab(tabId);
                if (reread?.status !== 'CLOSED') throw recoveryError;
                recovered.tab = reread;
            }
        }
        if (recovered.tab.status !== 'CLOSED') throw error;
        await notifyRecoveredPayment(prisma, recovered.tab, io);
        return recovered;
    }
};

exports.cancelTab = async (prisma, opts) => service(prisma, opts).cancelTab(opts.tabId);
exports.reportDefault = exports.cancelTab;

// Kept as an internal adapter export for callers that historically invoked item
// removal through the service module; the HTTP business route currently does
// not expose it, but any future mutation must use the same row-lock boundary.
exports.removeItem = async (prisma, opts) => removeItemAtomically(prisma, {
    tabId: opts.tabId,
    itemId: opts.itemId,
});
