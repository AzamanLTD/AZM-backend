// services/marketplace/dineInService.js
// =============================================================================
// AZAMAN — DINE-IN TAB SERVICE (2026-07-03)
// Restaurant open-tab system: waiter opens tab via AZM-ID, adds items,
// finalizes bill, customer confirms on phone before payment.
//
// Flow:
//   1. WAITER opens tab (searchByAzamanId → create DineInTab OPEN)
//   2. WAITER adds items (DineInTabItem rows)
//   3. WAITER finalizes (status → FINALIZED, totalAmount computed)
//   4. CUSTOMER confirms (status → CLOSED, escrow created via bookingEscrowService)
// =============================================================================

class DineInService {
    constructor(prisma, io) {
        this.prisma = prisma;
        this.io = io;
    }

    /**
     * Open a dine-in tab for a customer identified by AZM-ID.
     * @param {string} businessProfileId
     * @param {string} azamanId - Customer's AZM-ID
     * @param {string} tableLabel - e.g. "Table 5"
     * @returns {Promise<object>} The new DineInTab
     */
    async openTab({ businessProfileId, azamanId, tableId }) {
        if (!businessProfileId) throw new Error('businessProfileId is required.');
        if (!azamanId) throw new Error('azamanId is required.');

        // Find customer by AZM-ID
        const customer = await this.prisma.user.findUnique({
            where: { azamanId },
            select: { id: true, username: true },
        });
        if (!customer) throw new Error(`No customer found with AZM-ID: ${azamanId}`);

        // Check no existing OPEN tab for this customer at this business
        const existing = await this.prisma.dineInTab.findFirst({
            where: { businessProfileId, customerId: customer.id, status: 'OPEN' },
        });
        if (existing) throw new Error('Customer already has an open tab at this business.');

        const tab = await this.prisma.dineInTab.create({
            data: {
                businessProfileId,
                customerId: customer.id,
                tableId: tableId || null,
                status: 'OPEN',
            },
            include: { items: true },
        });

        // Notify customer in real-time
        this.io?.to(`user_${customer.id}`).emit('dine_in_tab_opened', {
            tabId: tab.id,
            businessProfileId,
            tableLabel,
        });

        return tab;
    }

    /**
     * Add an item to an open tab.
     */
    async addItem({ tabId, name, price, quantity, notes, addedBy }) {
        if (!tabId) throw new Error('tabId is required.');
        if (!name) throw new Error('name is required.');
        const priceNum = Number(price);
        if (!Number.isFinite(priceNum) || priceNum <= 0) throw new Error('price must be positive.');
        const qty = quantity || 1;

        const tab = await this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            select: { id: true, status: true, customerId: true },
        });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status !== 'OPEN') throw new Error('Cannot add items to a tab that is not OPEN.');

        const item = await this.prisma.dineInTabItem.create({
            data: { 
                dineInTabId: tabId, 
                name, 
                unitPriceUsdc: priceNum, 
                quantity: qty, 
                lineTotalUsdc: priceNum * qty,
                addedBy: addedBy || tab.customerId,
            },
        });

        // Notify customer
        this.io?.to(`user_${tab.customerId}`).emit('dine_in_item_added', {
            tabId, item: { name, price: priceNum, quantity: qty },
        });

        return item;
    }

    /**
     * Remove an item from an open tab.
     */
    async removeItem({ tabId, itemId }) {
        const item = await this.prisma.dineInTabItem.findUnique({
            where: { id: itemId },
            include: { dineInTab: { select: { status: true } } },
        });
        if (!item || item.dineInTabId !== tabId) throw new Error('Item not found on this tab.');
        if (item.dineInTab.status !== 'OPEN') throw new Error('Cannot remove items from a finalized tab.');

        await this.prisma.dineInTabItem.delete({ where: { id: itemId } });
        return { success: true };
    }

    /**
     * Finalize a tab — compute total, set status to FINALIZED.
     * Customer must confirm before payment is processed.
     */
    async finalizeTab(tabId) {
        const tab = await this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            include: { items: true },
        });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status !== 'OPEN') throw new Error('Tab is not OPEN.');

        const total = tab.items.reduce((sum, item) => sum + Number(item.unitPriceUsdc) * item.quantity, 0);

        const finalized = await this.prisma.dineInTab.update({
            where: { id: tabId },
            data: {
                status: 'FINALIZED',
                closedAt: new Date(),
                grandTotalUsdc: total,
                subtotalUsdc: total,
            },
            include: { items: true },
        });

        // Notify customer to review and confirm
        this.io?.to(`user_${tab.customerId}`).emit('dine_in_tab_finalized', {
            tabId,
            totalAmount: finalized.totalAmount,
            items: finalized.items,
        });

        return finalized;
    }

    /**
     * Customer confirms the finalized tab — status → CLOSED.
     * The escrow creation is handled by the caller (route/controller) which
     * has access to bookingEscrowService.
     */
    async confirmTab(tabId, customerId) {
        const tab = await this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            include: { items: true },
        });
        if (!tab) throw new Error('Tab not found.');
        if (tab.customerId !== customerId) throw new Error('Not authorized to confirm this tab.');
        if (tab.status !== 'FINALIZED') throw new Error('Tab must be FINALIZED before confirming.');

        const closed = await this.prisma.dineInTab.update({
            where: { id: tabId },
            data: {
                status: 'CLOSED',
                closedAt: new Date(),
            },
            include: { items: true },
        });

        return closed;
    }

    /**
     * Cancel a tab (only if OPEN or FINALIZED, not CLOSED).
     */
    async cancelTab(tabId) {
        const tab = await this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            select: { status: true, customerId: true },
        });
        if (!tab) throw new Error('Tab not found.');
        if (tab.status === 'CLOSED') throw new Error('Cannot cancel a closed tab.');

        await this.prisma.dineInTab.update({
            where: { id: tabId },
            data: { status: 'CANCELLED' },
        });

        this.io?.to(`user_${tab.customerId}`).emit('dine_in_tab_cancelled', { tabId });
        return { success: true };
    }

    /**
     * Get all tabs for a business (portal view).
     */
    async getBusinessTabs(businessProfileId, status) {
        const where = { businessProfileId };
        if (status) where.status = status;
        return this.prisma.dineInTab.findMany({
            where,
            include: {
                items: true,
                customer: { select: { id: true, username: true, azamanId: true } },
            },
            orderBy: { openedAt: 'desc' },
        });
    }

    /**
     * Get a single tab by ID.
     */
    async getTab(tabId) {
        return this.prisma.dineInTab.findUnique({
            where: { id: tabId },
            include: {
                items: true,
                customer: { select: { id: true, username: true, azamanId: true } },
                businessProfile: { select: { id: true, businessName: true, logoUrl: true } },
            },
        });
    }

    /**
     * Get all open/active tabs for a customer.
     */
    async getCustomerTabs(userId, status) {
        const where = { customerId: userId };
        if (status) where.status = status;
        return this.prisma.dineInTab.findMany({
            where,
            include: {
                items: true,
                businessProfile: { select: { id: true, businessName: true, logoUrl: true } },
            },
            orderBy: { openedAt: 'desc' },
        });
    }
}

module.exports = DineInService;
