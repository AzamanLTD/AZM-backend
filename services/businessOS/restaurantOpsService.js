// 📁 services/businessOS/restaurantOpsService.js
// services/businessOS/restaurantOpsService.js
// =============================================================================
// Restaurant Operations Service — Kitchen Display System (KDS),
// table management, and menu engineering (station routing, 86'd items).
// =============================================================================

class RestaurantOpsService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ═══ KITCHEN DISPLAY SYSTEM (KDS) ═══════════════════════════════════════

    // Create a kitchen order from a BusinessOrder
    async createKitchenOrder({ businessProfileId, locationId, businessOrderId, tableNumber, serverName, items, station, specialInstructions, isRush }) {
        // Generate ticket number (sequential per location per day)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todayCount = await this.prisma.kitchenOrder.count({
            where: {
                businessProfileId,
                locationId,
                sentAt: { gte: today, lt: tomorrow },
            },
        });

        // Collect allergy alerts from items
        const allergyAlerts = [];
        const orderItems = [];

        for (const item of items) {
            // Fetch product to check for allergens
            const product = await this.prisma.businessProduct.findUnique({
                where: { id: item.productId },
            });
            if (product) {
                // Check product metadata for allergen info
                const allergens = product.metadata?.allergens || [];
                if (allergens.length > 0) {
                    allergyAlerts.push(...allergens);
                }

                // Determine station from product category or metadata
                const itemStation = item.station || product.metadata?.station || station || 'HOT';

                orderItems.push({
                    productId: item.productId,
                    name: product.name,
                    quantity: item.quantity,
                    station: itemStation,
                    modifiers: item.modifiers || [],
                    notes: item.notes || '',
                    status: 'NEW',
                });
            }
        }

        // Dedupe allergy alerts
        const uniqueAllergies = [...new Set(allergyAlerts)];

        const kitchenOrder = await this.prisma.kitchenOrder.create({
            data: {
                businessProfileId,
                locationId,
                businessOrderId,
                ticketNumber: todayCount + 1,
                tableNumber,
                serverName,
                station: station || 'HOT',
                allergyAlerts: uniqueAllergies,
                specialInstructions,
                isRush: isRush || false,
                orderItems: orderItems,
            },
            include: {
                businessOrder: true,
            },
        });

        return kitchenOrder;
    }

    // Get KDS board (grouped by station)
    async getKDSBoard(businessProfileId, { locationId, status } = {}) {
        const where = {
            businessProfileId,
            status: status || { in: ['NEW', 'PREPARING'] },
        };
        if (locationId) where.locationId = locationId;

        const orders = await this.prisma.kitchenOrder.findMany({
            where,
            orderBy: { ticketNumber: 'asc' },
        });

        // Sort: rush orders first, then by ticket number
        orders.sort((a, b) => {
            if (a.isRush && !b.isRush) return -1;
            if (!a.isRush && b.isRush) return 1;
            return a.ticketNumber - b.ticketNumber;
        });

        // Group by station
        const byStation = {};
        orders.forEach(order => {
            const items = order.orderItems || [];
            items.forEach(item => {
                const station = item.station || order.station || 'HOT';
                if (!byStation[station]) byStation[station] = [];
                if (!byStation[station].find(o => o.id === order.id)) {
                    byStation[station].push({
                        ...order,
                        stationItems: items.filter(i => (i.station || order.station) === station),
                    });
                }
            });
        });

        return {
            allOrders: orders,
            byStation,
            totalActive: orders.length,
            rushCount: orders.filter(o => o.isRush).length,
        };
    }

    // Update order status (KDS bump bar)
    async updateOrderStatus(orderId, status) {
        const order = await this.prisma.kitchenOrder.findUnique({
            where: { id: orderId },
        });
        if (!order) throw new Error('Kitchen order not found.');

        const updates = { status };
        if (status === 'PREPARING' && !order.startedAt) updates.startedAt = new Date();
        if (status === 'READY') updates.readyAt = new Date();
        if (status === 'SERVED') updates.servedAt = new Date();

        return this.prisma.kitchenOrder.update({
            where: { id: orderId },
            data: updates,
        });
    }

    // Update individual item status
    async updateItemStatus(orderId, itemIndex, status) {
        const order = await this.prisma.kitchenOrder.findUnique({
            where: { id: orderId },
        });
        if (!order) throw new Error('Order not found.');

        const items = [...order.orderItems];
        if (itemIndex >= 0 && itemIndex < items.length) {
            items[itemIndex] = { ...items[itemIndex], status };
        }

        // If all items are ready/served, update the order status too
        const allReady = items.every(i => i.status === 'READY' || i.status === 'SERVED');
        const allServed = items.every(i => i.status === 'SERVED');

        const updates = { orderItems: items };
        if (allServed) {
            updates.status = 'SERVED';
            updates.servedAt = new Date();
        } else if (allReady) {
            updates.status = 'READY';
            updates.readyAt = new Date();
        }

        return this.prisma.kitchenOrder.update({
            where: { id: orderId },
            data: updates,
        });
    }

    // Assign chef to order
    async assignChef(orderId, employeeId) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.role !== 'CHEF' && employee.role !== 'MANAGER') {
            throw new Error('Only chefs or managers can be assigned to orders.');
        }

        return this.prisma.kitchenOrder.update({
            where: { id: orderId },
            data: { employeeId, status: 'PREPARING', startedAt: new Date() },
        });
    }

    // Get KDS stats
    async getKDSStats(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.sentAt = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const orders = await this.prisma.kitchenOrder.findMany({ where });

        const total = orders.length;
        const avgPrepTime = orders
            .filter(o => o.readyAt && o.sentAt)
            .reduce((sum, o) => {
                const prepTime = (new Date(o.readyAt) - new Date(o.sentAt)) / (1000 * 60);
                return sum + prepTime;
            }, 0) / (orders.filter(o => o.readyAt && o.sentAt).length || 1);

        return {
            totalOrders: total,
            newCount: orders.filter(o => o.status === 'NEW').length,
            preparingCount: orders.filter(o => o.status === 'PREPARING').length,
            readyCount: orders.filter(o => o.status === 'READY').length,
            servedCount: orders.filter(o => o.status === 'SERVED').length,
            cancelledCount: orders.filter(o => o.status === 'CANCELLED').length,
            rushCount: orders.filter(o => o.isRush).length,
            avgPrepTimeMinutes: Math.round(avgPrepTime * 10) / 10,
        };
    }

    // ═══ TABLE MANAGEMENT ═════════════════════════════════════════════════════
    // Note: Table management uses DineInTab model which already exists in the schema.
    // This provides a floor-plan view of all active tables.

    async getTableFloor(businessProfileId, { locationId } = {}) {
        const where = { businessProfileId, status: { in: ['OPEN', 'SEATED', 'ORDERED'] } };
        if (locationId) where.locationId = locationId;

        const tabs = await this.prisma.dineInTab.findMany({
            where,
            include: {
                items: true,
                customer: { select: { username: true } },
            },
            orderBy: { tableNumber: 'asc' },
        });

        return tabs.map(tab => ({
            id: tab.id,
            tableNumber: tab.tableNumber,
            status: tab.status,
            customerName: tab.customer?.username || 'Walk-in',
            serverName: tab.serverName,
            itemCount: tab.items.length,
            totalAmount: tab.items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0),
            openedAt: tab.openedAt,
            durationMinutes: Math.round((new Date() - new Date(tab.openedAt)) / (1000 * 60)),
        }));
    }

    // ═══ MENU ENGINEERING ═════════════════════════════════════════════════════
    // 86'd items management (items that are unavailable)

    async toggleItem86({ businessProfileId, productId, is86ed, reason }) {
        // Toggle the "86'd" status of a product
        const product = await this.prisma.businessProduct.findUnique({
            where: { id: productId },
        });
        if (!product) throw new Error('Product not found.');
        if (product.businessProfileId !== businessProfileId) {
            throw new Error('Product does not belong to this business.');
        }

        // Store 86 status in metadata
        const metadata = product.metadata || {};
        metadata.is86ed = is86ed;
        metadata.eightySixReason = is86ed ? (reason || 'Out of stock') : null;
        metadata.eightySixAt = is86ed ? new Date().toISOString() : null;

        return this.prisma.businessProduct.update({
            where: { id: productId },
            data: { metadata },
        });
    }

    async get86edItems(businessProfileId) {
        const products = await this.prisma.businessProduct.findMany({
            where: { businessProfileId },
        });
        return products.filter(p => p.metadata?.is86ed);
    }
}

module.exports = { RestaurantOpsService };
