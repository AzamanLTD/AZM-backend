// 📁 services/businessOS/businessLedgerService.js
// services/businessOS/businessLedgerService.js
// =============================================================================
// Business Ledger Service — universal financial tracking for businesses.
// Every financial event (income, expense, payroll, tax, refund, penalty,
// ad spend, maintenance, supplies) is recorded as a ledger entry.
// =============================================================================

class BusinessLedgerService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Create Ledger Entry ────────────────────────────────────────────────
    async createEntry({ businessProfileId, type, category, description, amount, sourceType, sourceId, metadata, entryDate }) {
        return this.prisma.businessLedgerEntry.create({
            data: {
                businessProfileId,
                type,
                category,
                description,
                amount: parseFloat(amount),
                sourceType: sourceType || null,
                sourceId: sourceId || null,
                metadata: metadata || {},
                createdAt: entryDate ? new Date(entryDate) : undefined,
            },
        });
    }

    // ── Get Ledger Entries ─────────────────────────────────────────────────
    async getEntries(businessProfileId, { type, category, startDate, endDate, limit = 100, offset = 0 } = {}) {
        const where = { businessProfileId };
        if (type) where.type = type;
        if (category) where.category = category;
        if (startDate && endDate) {
            where.entryDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const [entries, total] = await Promise.all([
            this.prisma.businessLedgerEntry.findMany({
                where,
                orderBy: { entryDate: 'desc' },
                take: limit,
                skip: offset,
            }),
            this.prisma.businessLedgerEntry.count({ where }),
        ]);

        return { entries, total, hasMore: offset + entries.length < total };
    }

    // ── Get P&L Summary ────────────────────────────────────────────────────
    async getProfitLoss(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.entryDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const entries = await this.prisma.businessLedgerEntry.findMany({ where });

        const income = entries
            .filter(e => e.type === 'INCOME')
            .reduce((s, e) => s + parseFloat(e.amount), 0);
        const expenses = entries
            .filter(e => e.type !== 'INCOME')
            .reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);

        // Breakdown by type
        const byType = {};
        entries.forEach(e => {
            const key = e.type;
            if (!byType[key]) byType[key] = 0;
            byType[key] += Math.abs(parseFloat(e.amount));
        });

        // Breakdown by category
        const byCategory = {};
        entries.forEach(e => {
            const key = e.category || 'Uncategorized';
            if (!byCategory[key]) byCategory[key] = 0;
            byCategory[key] += Math.abs(parseFloat(e.amount));
        });

        return {
            totalIncome: income,
            totalExpenses: expenses,
            netProfit: income - expenses,
            margin: income > 0 ? ((income - expenses) / income) * 100 : 0,
            byType,
            byCategory,
            entryCount: entries.length,
        };
    }

    // ── Get Cash Flow ──────────────────────────────────────────────────────
    async getCashFlow(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.entryDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const entries = await this.prisma.businessLedgerEntry.findMany({
            where,
            orderBy: { entryDate: 'asc' },
        });

        let runningBalance = 0;
        const dailyFlow = {};
        const flow = entries.map(e => {
            const amount = parseFloat(e.amount);
            runningBalance += amount;
            const dateKey = new Date(e.entryDate).toISOString().split('T')[0];
            if (!dailyFlow[dateKey]) {
                dailyFlow[dateKey] = { date: dateKey, inflow: 0, outflow: 0, net: 0 };
            }
            if (amount > 0) dailyFlow[dateKey].inflow += amount;
            else dailyFlow[dateKey].outflow += Math.abs(amount);
            dailyFlow[dateKey].net += amount;

            return {
                id: e.id,
                date: e.entryDate,
                type: e.type,
                category: e.category,
                description: e.description,
                amount,
                runningBalance,
            };
        });

        return {
            entries: flow,
            dailyFlow: Object.values(dailyFlow),
            totalInflow: entries.filter(e => parseFloat(e.amount) > 0).reduce((s, e) => s + parseFloat(e.amount), 0),
            totalOutflow: entries.filter(e => parseFloat(e.amount) < 0).reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0),
            netFlow: runningBalance,
            startingBalance: 0,
            endingBalance: runningBalance,
        };
    }

    // ── Get Expense Breakdown ──────────────────────────────────────────────
    async getExpenseBreakdown(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId, type: { not: 'INCOME' } };
        if (startDate && endDate) {
            where.entryDate = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const entries = await this.prisma.businessLedgerEntry.findMany({ where });

        const byCategory = {};
        entries.forEach(e => {
            const key = e.category || 'Uncategorized';
            if (!byCategory[key]) byCategory[key] = { category: key, amount: 0, count: 0 };
            byCategory[key].amount += Math.abs(parseFloat(e.amount));
            byCategory[key].count += 1;
        });

        const breakdown = Object.values(byCategory).sort((a, b) => b.amount - a.amount);
        const total = breakdown.reduce((s, e) => s + e.amount, 0);

        return {
            totalExpenses: total,
            categories: breakdown.map(e => ({
                ...e,
                percentage: total > 0 ? (e.amount / total) * 100 : 0,
            })),
        };
    }

    // ── Get Dashboard Stats ────────────────────────────────────────────────
    async getDashboardStats(businessProfileId) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

        const [currentEntries, previousEntries, allEntries] = await Promise.all([
            this.prisma.businessLedgerEntry.findMany({
                where: { businessProfileId, entryDate: { gte: thirtyDaysAgo } },
            }),
            this.prisma.businessLedgerEntry.findMany({
                where: { businessProfileId, entryDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
            }),
            this.prisma.businessLedgerEntry.findMany({
                where: { businessProfileId },
            }),
        ]);

        const currentIncome = currentEntries.filter(e => e.type === 'INCOME').reduce((s, e) => s + parseFloat(e.amount), 0);
        const previousIncome = previousEntries.filter(e => e.type === 'INCOME').reduce((s, e) => s + parseFloat(e.amount), 0);
        const currentExpenses = currentEntries.filter(e => e.type !== 'INCOME').reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);
        const previousExpenses = previousEntries.filter(e => e.type !== 'INCOME').reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);

        const incomeChange = previousIncome > 0 ? ((currentIncome - previousIncome) / previousIncome) * 100 : 0;
        const expenseChange = previousExpenses > 0 ? ((currentExpenses - previousExpenses) / previousExpenses) * 100 : 0;

        return {
            revenue: {
                current: currentIncome,
                previous: previousIncome,
                change: incomeChange,
            },
            expenses: {
                current: currentExpenses,
                previous: previousExpenses,
                change: expenseChange,
            },
            profit: {
                current: currentIncome - currentExpenses,
                previous: previousIncome - previousExpenses,
            },
            totalEntries: allEntries.length,
        };
    }

    // ── Delete Entry ───────────────────────────────────────────────────────
    async deleteEntry(entryId, businessProfileId) {
        const entry = await this.prisma.businessLedgerEntry.findUnique({
            where: { id: entryId },
        });
        if (!entry) throw new Error('Entry not found.');
        if (entry.businessProfileId !== businessProfileId) {
            throw new Error('Entry does not belong to this business.');
        }
        return this.prisma.businessLedgerEntry.delete({ where: { id: entryId } });
    }
}

module.exports = { BusinessLedgerService };
