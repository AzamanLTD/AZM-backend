// services/marketplace/dineInService.js
'use strict';

const invoiceService = require('../businessInvoiceService');
const {
    validateConfiguredProduct,
    configuredUnitPrice,
    normalizedSelection,
} = require('../storefrontProductConfigurationService');

const selectionLabel = (selection) => {
    const entries = Object.entries(selection || {});
    if (!entries.length) return '';
    return entries.map(([group, value]) => `${group}: ${(Array.isArray(value) ? value : [value]).join(', ')}`).join(' · ');
};

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;

const isSerializableConflict = (error) => error?.code === 'P2034';

const waitForSerializableRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt));
});

// Keep the canonical invoice service authoritative while allowing its payment
// transaction to participate in a larger interactive transaction. The proxy
// delegates all Prisma model access to the transaction client and replaces only
// $transaction so invoiceService.payInvoice executes on the existing transaction
// instead of opening a nested transaction.
const transactionScopedPrisma = (prisma, tx) => new Proxy(prisma, {
    get(target, property, receiver) {
        if (property === '$transaction') return async (callback) => callback(tx);
        if (property in tx) return tx[property];
        return Reflect.get(target, property, receiver);
    },
});

class DineInService {
    constructor(prisma, io) { this.prisma = prisma; this.io = io; }

    async openTab({ businessProfileId, azamanId, tableId }) {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!azamanId) throw new Error('azamanId is required.');
        const customer = await this.prisma.user.findUnique({ where: { azamanId }, select: { id: true, username: true } });
        if (!customer) throw new Error(`No customer found with AZM-ID: ${azamanId}`);

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                const tab = await this.prisma.$transaction(async (tx) => {
                    const existing = await tx.dineInTab.findFirst({
                        where: { businessProfileId, customerId: customer.id, status: 'OPEN' },
                    });
                    if (existing) throw new Error('Customer already has an open tab at this business.');
                    return tx.dineInTab.create({
                        data: { businessProfileId, customerId: customer.id, tableId: tableId || null, status: 'OPEN' },
                        include: { items: true },
                    });
                }, { isolationLevel: 'Serializable' });
                this.io?.to(`user_${customer.id}`).emit('dine_in_tab_opened', { tabId: tab.id, businessProfileId, tableId: tableId || null });
                return tab;
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForSerializableRetry(attempt);
            }
        }
        throw new Error('Could not open dine-in tab after retries.');
    }

    async addItem({ tabId, productId, name, price, quantity, addedBy }) {
        if (!tabId) throw new Error('tabId is required.');
        const priceNum = Number(price);
        const qty = Number(quantity || 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new Error('quantity must be an integer from 1 to 50.');

        const tab = await this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            select: { id: true, businessProfileId: true, status: true, customerId: true },
        });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status !== 'OPEN') throw new Error('Cannot add items to a tab that is not OPEN.');

        // Business-side additions must resolve price from the authoritative catalog.
        // Never trust a caller-supplied monetary amount for a persisted tab item.
        let itemName = name;
        let authoritativePrice = priceNum;
        if (productId) {
            const product = await this.prisma.businessProduct.findFirst({
                where: { id: productId, businessProfileId: tab.businessProfileId, isActive: true, isAvailable: true },
                select: { id: true, name: true, priceUsdc: true },
            });
            if (!product) throw new Error('Product is unavailable for this restaurant.');
            authoritativePrice = Number(product.priceUsdc);
            itemName = product.name;
        }
        if (!itemName) throw new Error('name is required.');
        if (!Number.isFinite(authoritativePrice) || authoritativePrice <= 0) throw new Error('price must be positive.');
        if (productId && Number.isFinite(priceNum) && priceNum > 0 && Math.abs(priceNum - authoritativePrice) > 1e-8) {
            throw new Error('Product price does not match the current catalog price.');
        }

        const item = await this.prisma.dineInTabItem.create({
            data: {
                dineInTabId: tabId,
                productId: productId || null,
                name: String(itemName).slice(0, 200),
                unitPriceUsdc: authoritativePrice,
                quantity: qty,
                lineTotalUsdc: authoritativePrice * qty,
                addedBy: addedBy || tab.customerId,
            },
        });
        this.io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', { tabId, item });
        return item;
    }

    async addCustomerItem({ tabId, customerId, productId, selection, quantity }) {
        if (!tabId) throw new Error('tabId is required.');
        if (!productId) throw new Error('productId is required.');
        if (!customerId) throw new Error('customerId is required.');
        const tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, select: { id: true, businessProfileId: true, customerId: true, status: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.customerId !== customerId) throw new Error('Not authorized to add items to this tab.');
        if (tab.status !== 'OPEN') throw new Error('Cannot add items to a tab that is not OPEN.');
        const product = await this.prisma.businessProduct.findFirst({ where: { id: productId, businessProfileId: tab.businessProfileId, isActive: true, isAvailable: true }, select: { id: true, name: true, priceUsdc: true, variants: true, modifierGroups: true } });
        if (!product) throw new Error('Product is unavailable for this restaurant.');
        const validation = validateConfiguredProduct(product, selection);
        if (validation.error) throw new Error(validation.error);
        const normalized = normalizedSelection(product, selection);
        const unitPrice = configuredUnitPrice(product, normalized);
        if (!(unitPrice > 0)) throw new Error('Product price must be positive.');
        const label = selectionLabel(normalized);
        return this.addItem({ tabId, productId: product.id, name: label ? `${product.name} — ${label}` : product.name, price: unitPrice, quantity, addedBy: customerId });
    }

    async removeItem({ tabId, itemId }) {
        const item = await this.prisma.dineInTabItem.findUnique({ where: { id: itemId }, include: { dineInTab: { select: { status: true } } } });
        if (!item || item.dineInTabId !== tabId) throw new Error('Item not found on this tab.');
        if (item.dineInTab.status !== 'OPEN') throw new Error('Cannot remove items from a finalized tab.');
        await this.prisma.dineInTabItem.delete({ where: { id: itemId } });
        return { success: true };
    }

    async finalizeTab(tabId) {
        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                const finalized = await this.prisma.$transaction(async (tx) => {
                    const tab = await tx.dineInTab.findUnique({ where: { id: tabId }, include: { items: true } });
                    if (!tab) throw new Error('Tab not found.');
                    if (tab.status !== 'OPEN') throw new Error('Tab is not OPEN.');
                    const total = tab.items.reduce((sum, item) => sum + Number(item.unitPriceUsdc) * item.quantity, 0);
                    const claimed = await tx.dineInTab.updateMany({
                        where: { id: tabId, status: 'OPEN' },
                        data: { status: 'FINALIZED', closedAt: new Date(), grandTotalUsdc: total, subtotalUsdc: total },
                    });
                    if (claimed.count !== 1) throw new Error('Tab was finalized by another request.');
                    return tx.dineInTab.findUnique({ where: { id: tabId }, include: { items: true } });
                }, { isolationLevel: 'Serializable' });
                this.io?.to(`user_${finalized.customerId}`).emit('dine_in_tab_finalized', { tabId, totalAmount: finalized.grandTotalUsdc, items: finalized.items });
                return finalized;
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForSerializableRetry(attempt);
            }
        }
        throw new Error('Could not finalize dine-in tab after retries.');
    }

    async confirmAndPay(tabId, customerId, { tipUsdc } = {}) {
        let tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, include: { items: true, invoice: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.customerId !== customerId) throw new Error('Not authorized to pay this tab.');
        if (tab.status !== 'FINALIZED' && tab.status !== 'CLOSED') throw new Error('Tab must be FINALIZED before payment.');
        let invoice = tab.invoice;

        if (invoice?.status === 'PAID') {
            return { tab, invoice, payment: { invoice, customerPays: Number(invoice.customerPaidUsdc), alreadyPaid: true } };
        }

        // Invoice creation/sending is non-financial preparation. Keep it on the
        // canonical invoice service, then make the actual debit/credit AND the
        // final tab close one atomic transaction below. A failed payment leaves
        // the SENT invoice and FINALIZED tab intact and safely retryable.
        if (!invoice) {
            if (!tab.items.length) throw new Error('Cannot pay an empty dine-in tab.');
            const idempotencyKey = `DINE_IN_TAB:${tabId}`;
            try {
                invoice = await invoiceService.createInvoice(this.prisma, {
                    businessProfileId: tab.businessProfileId, customerId: tab.customerId,
                    locationId: tab.locationId, tableId: tab.tableId,
                    lineItems: tab.items.map(item => ({ description: item.name, quantity: item.quantity, unitPrice: Number(item.unitPriceUsdc) })),
                    taxLines: [], businessNote: 'Dine-in tab settlement', idempotencyKey,
                });
            } catch (error) {
                if (error?.code !== 'P2002') throw error;
                invoice = await this.prisma.businessInvoice.findUnique({ where: { idempotencyKey } });
                if (!invoice) throw error;
            }
            await this.prisma.dineInTab.updateMany({
                where: { id: tabId, invoiceId: null }, data: { invoiceId: invoice.id },
            });
            tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, include: { items: true, invoice: true } });
            invoice = tab.invoice;
        } else if (invoice.status === 'DRAFT') {
            try { invoice = await invoiceService.sendInvoice(this.prisma, { invoiceId: invoice.id, businessProfileId: tab.businessProfileId }); }
            catch (error) {
                invoice = await this.prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
                if (!invoice || invoice.status === 'DRAFT') throw error;
            }
        }

        if (invoice.status === 'DRAFT') invoice = await invoiceService.sendInvoice(this.prisma, { invoiceId: invoice.id, businessProfileId: tab.businessProfileId });

        const settlement = await this.prisma.$transaction(async (tx) => {
            const scopedPrisma = transactionScopedPrisma(this.prisma, tx);
            const payment = await invoiceService.payInvoice(scopedPrisma, { invoiceId: invoice.id, customerId, tipUsdc });
            const settledInvoice = payment.invoice;
            const tip = Math.max(0, Number(settledInvoice?.tipUsdc ?? invoice.tipUsdc) || 0);
            const billTotal = Number(settledInvoice?.billTotalUsdc ?? invoice.billTotalUsdc);
            const grandTotal = billTotal + tip;
            await tx.dineInTab.updateMany({
                where: { id: tabId, status: 'FINALIZED', invoiceId: invoice.id },
                data: {
                    status: 'CLOSED',
                    closedAt: new Date(),
                    tipUsdc: tip,
                    grandTotalUsdc: grandTotal,
                    paymentMethod: 'AZAMAN_BALANCE',
                },
            });
            const closed = await tx.dineInTab.findUnique({ where: { id: tabId }, include: { items: true, invoice: true } });
            return { closed, payment };
        });

        this.io?.to(`user_${customerId}`).emit('dine_in_tab_paid', {
            tabId,
            invoiceId: invoice.id,
            customerPays: settlement.payment.customerPays,
            businessReceives: settlement.payment.businessReceives,
            fee: settlement.payment.fee,
        });
        return { tab: settlement.closed, invoice: settlement.payment.invoice, payment: settlement.payment };
    }

    async confirmTab(tabId, customerId) {
        const tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.customerId !== customerId) throw new Error('Not authorized.');
        if (tab.status !== 'FINALIZED') throw new Error('Tab must be FINALIZED before confirmation.');
        return this.prisma.dineInTab.update({ where: { id: tabId }, data: { status: 'CLOSED', closedAt: new Date() }, include: { items: true } });
    }

    async cancelTab(tabId) {
        const tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, select: { status: true, customerId: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status === 'CLOSED') throw new Error('Cannot cancel a closed tab.');
        await this.prisma.dineInTab.update({ where: { id: tabId }, data: { status: 'CANCELLED' } });
        this.io?.to(`user_${tab.customerId}`).emit('dine_in_tab_cancelled', { tabId });
        return { success: true };
    }

    async getBusinessTabs(businessProfileId, status) {
        const where = { businessProfileId }; if (status) where.status = status;
        return this.prisma.dineInTab.findMany({ where, include: { items: true, customer: { select: { id: true, username: true, azamanId: true } }, invoice: true }, orderBy: { openedAt: 'desc' } });
    }

    async getTab(tabId) {
        return this.prisma.dineInTab.findUnique({ where: { id: tabId }, include: { items: true, invoice: true, customer: { select: { id: true, username: true, azamanId: true } }, businessProfile: { select: { id: true, businessName: true, logoUrl: true } } } });
    }

    async getCustomerTabs(userId, status) {
        const where = { customerId: userId }; if (status) where.status = status;
        return this.prisma.dineInTab.findMany({ where, include: { items: true, invoice: true, businessProfile: { select: { id: true, businessName: true, logoUrl: true } } }, orderBy: { openedAt: 'desc' } });
    }
}

module.exports = DineInService;
