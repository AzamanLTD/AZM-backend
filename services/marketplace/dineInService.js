// services/marketplace/dineInService.js
'use strict';

const invoiceService = require('../businessInvoiceService');
const {
    validateConfiguredProduct,
    configuredUnitPrice,
    normalizedSelection,
} = require('../services/storefrontProductConfigurationService');

const selectionLabel = (selection) => {
    const entries = Object.entries(selection || {});
    if (!entries.length) return '';
    return entries.map(([group, value]) => `${group}: ${(Array.isArray(value) ? value : [value]).join(', ')}`).join(' · ');
};

class DineInService {
    constructor(prisma, io) { this.prisma = prisma; this.io = io; }

    async openTab({ businessProfileId, azamanId, tableId }) {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!azamanId) throw new Error('azamanId is required.');
        const customer = await this.prisma.user.findUnique({ where: { azamanId }, select: { id: true, username: true } });
        if (!customer) throw new Error(`No customer found with AZM-ID: ${azamanId}`);
        const existing = await this.prisma.dineInTab.findFirst({ where: { businessProfileId, customerId: customer.id, status: 'OPEN' } });
        if (existing) throw new Error('Customer already has an open tab at this business.');
        const tab = await this.prisma.dineInTab.create({ data: { businessProfileId, customerId: customer.id, tableId: tableId || null, status: 'OPEN' }, include: { items: true } });
        this.io?.to(`user_${customer.id}`).emit('dine_in_tab_opened', { tabId: tab.id, businessProfileId, tableId: tableId || null });
        return tab;
    }

    async addItem({ tabId, productId, name, price, quantity, notes, addedBy }) {
        if (!tabId) throw new Error('tabId is required.');
        if (!name) throw new Error('name is required.');
        const priceNum = Number(price);
        if (!Number.isFinite(priceNum) || priceNum <= 0) throw new Error('price must be positive.');
        const qty = Number(quantity || 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new Error('quantity must be an integer from 1 to 50.');
        const tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, select: { id: true, status: true, customerId: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status !== 'OPEN') throw new Error('Cannot add items to a tab that is not OPEN.');
        const item = await this.prisma.dineInTabItem.create({ data: { dineInTabId: tabId, productId: productId || null, name: String(name).slice(0, 200), unitPriceUsdc: priceNum, quantity: qty, lineTotalUsdc: priceNum * qty, addedBy: addedBy || tab.customerId } });
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
        const tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, include: { items: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status !== 'OPEN') throw new Error('Tab is not OPEN.');
        const total = tab.items.reduce((sum, item) => sum + Number(item.unitPriceUsdc) * item.quantity, 0);
        const finalized = await this.prisma.dineInTab.update({ where: { id: tabId }, data: { status: 'FINALIZED', closedAt: new Date(), grandTotalUsdc: total, subtotalUsdc: total }, include: { items: true } });
        this.io?.to(`user_${tab.customerId}`).emit('dine_in_tab_finalized', { tabId, totalAmount: finalized.grandTotalUsdc, items: finalized.items });
        return finalized;
    }

    async confirmAndPay(tabId, customerId, { tipUsdc } = {}) {
        let tab = await this.prisma.dineInTab.findUnique({ where: { id: tabId }, include: { items: true, invoice: true } });
        if (!tab) throw new Error('Tab not found.');
        if (tab.customerId !== customerId) throw new Error('Not authorized to pay this tab.');
        if (tab.status !== 'FINALIZED' && tab.status !== 'CLOSED') throw new Error('Tab must be FINALIZED before payment.');

        let invoice = tab.invoice;
        if (invoice?.status === 'PAID') {
            return { tab, invoice, payment: { invoice, customerPays: Number(invoice.customerPaidUsdc), businessReceives: null, fee: null, idempotent: true } };
        }
        if (!invoice) {
            if (!tab.items.length) throw new Error('Cannot pay an empty dine-in tab.');
            invoice = await invoiceService.createInvoice(this.prisma, {
                businessProfileId: tab.businessProfileId,
                customerId: tab.customerId,
                locationId: tab.locationId,
                tableId: tab.tableId,
                lineItems: tab.items.map(item => ({ description: item.name, quantity: item.quantity, unitPrice: Number(item.unitPriceUsdc) })),
                taxLines: [],
                businessNote: 'Dine-in tab settlement',
            });
            invoice = await invoiceService.sendInvoice(this.prisma, { invoiceId: invoice.id, businessProfileId: tab.businessProfileId });
            tab = await this.prisma.dineInTab.update({ where: { id: tabId }, data: { invoiceId: invoice.id }, include: { items: true, invoice: true } });
        } else if (invoice.status === 'DRAFT') {
            invoice = await invoiceService.sendInvoice(this.prisma, { invoiceId: invoice.id, businessProfileId: tab.businessProfileId });
        }

        const payment = await invoiceService.payInvoice(this.prisma, { invoiceId: invoice.id, customerId, tipUsdc });
        const tip = Math.max(0, Number(tipUsdc) || 0);
        const billTotal = Number(payment.invoice?.billTotalUsdc ?? invoice.billTotalUsdc);
        const grandTotal = billTotal + tip;
        const closed = await this.prisma.dineInTab.update({ where: { id: tabId }, data: { status: 'CLOSED', closedAt: new Date(), tipUsdc: tip, grandTotalUsdc: grandTotal, paymentMethod: 'AZAMAN_BALANCE' }, include: { items: true, invoice: true } });
        this.io?.to(`user_${customerId}`).emit('dine_in_tab_paid', { tabId, invoiceId: invoice.id, customerPays: payment.customerPays, businessReceives: payment.businessReceives, fee: payment.fee });
        return { tab: closed, invoice: payment.invoice, payment };
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
