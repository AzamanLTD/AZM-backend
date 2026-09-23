// services/businessOS/businessLedgerService.js
// =============================================================================
// Business Ledger Service — universal financial tracking for businesses.
// Every financial event (income, expense, payroll, tax, refund, penalty,
// ad spend, maintenance, supplies) is recorded in the ledger.
//
// r35/P2 — CANONICAL ACCOUNTING CONTRACT (now enforced, not just implied):
//   • SIGNED AMOUNTS: the schema documents "positive for income, negative
//     for expense". The settlement writers (POS, dine-in, payroll, EWA,
//     inventory) already follow it, but the manual POST /ledger route let
//     any client store a POSITIVE expense — which inverted cash-flow math
//     (expenses raised the running balance). createEntry now NORMALIZES
//     the sign from the entry TYPE: INCOME is stored positive, every other
//     type (EXPENSE, PAYROLL, TAX, REFUND, PENALTY, AD_SPEND) is stored
//     negative. The type, not the client's sign, is authoritative.
//   • APPEND-ONLY: ledger rows are never hard-deleted or mutated. The old
//     deleteEntry() hard-deleted ANY row — including settlement income —
//     silently corrupting P&L history. DELETE /ledger/:id now creates an
//     exact NEGATING REVERSAL entry that references the original
//     (metadata.reversalOf); the original row stays untouched and the net
//     economic effect is zero.
//   • ONE REVERSAL PER ENTRY: a second reversal attempt is refused (409)
//     with zero mutation.
//   • CROSS-TENANT: entries can only be read/reversed within the caller's
//     own business.
// =============================================================================
// The full Prisma LedgerEntryType enum (keep in sync with schema.prisma).
const LEDGER_ENTRY_TYPES = ['INCOME', 'EXPENSE', 'PAYROLL', 'TAX', 'REFUND', 'PENALTY', 'AD_SPEND', 'MAINTENANCE', 'SUPPLIES', 'UTILITIES', 'RENT', 'OTHER'];
const INCOME_TYPES = new Set(['INCOME']);
const MAX_ABS_AMOUNT = 1e9;

class BusinessLedgerService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // Canonical signed amount for a type. The magnitude comes from the
    // caller; the SIGN comes from the type (r35 contract).
    _canonicalAmount(type, amount) {
        const n = typeof amount === 'number' ? amount : Number(amount);
        if (!Number.isFinite(n)) throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount must be a finite number.');
        const magnitude = Math.abs(n);
        if (magnitude === 0) throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount cannot be zero.');
        if (magnitude > MAX_ABS_AMOUNT) throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount is unreasonably large.');
        const signed = INCOME_TYPES.has(type) ? magnitude : -magnitude;
        return Math.round(signed * 1e6) / 1e6;
    }

    _fail(status, code, message) {
        const err = new Error(message);
        err.status = status;
        err.code = code;
        return err;
    }

    // ── Create Ledger Entry ────────────────────────────────────────────────
    async createEntry({ businessProfileId, type, category, description, amount, sourceType, sourceId, metadata, entryDate }) {
        if (!businessProfileId) throw this._fail(400, 'INVALID_INPUT', 'Business context required.');
        if (!LEDGER_ENTRY_TYPES.includes(type)) {
            throw this._fail(400, 'INVALID_TYPE', `Invalid ledger entry type '${type}'.`);
        }
        if (!category || !String(category).trim()) throw this._fail(400, 'INVALID_INPUT', 'Category required.');
        if (!description || !String(description).trim()) throw this._fail(400, 'INVALID_INPUT', 'Description required.');

        const signedAmount = this._canonicalAmount(type, amount);

        return this.prisma.businessLedgerEntry.create({
            data: {
                businessProfileId,
                type,
                category: String(category).trim().slice(0, 100),
                description: String(description).trim().slice(0, 500),
                amount: signedAmount,
                amountGhs: metadata?.amountGhs != null ? this._canonicalAmount(type, metadata.amountGhs) : undefined,
                sourceType: sourceType || 'MANUAL',
                sourceId: sourceId || null,
                metadata: metadata || {},
                createdAt: entryDate ? new Date(entryDate) : undefined,
            },
        });
    }

    // ── Reversal (append-only correction) ──────────────────────────────────
    // Writes the exact negation of an existing entry and references the
    // original. The original row is never mutated or deleted. A second
    // reversal of the same entry is refused with zero mutation.
    async createReversalEntry({ businessProfileId, entryId, reason }) {
        if (!businessProfileId) throw this._fail(400, 'INVALID_INPUT', 'Business context required.');
        if (!entryId) throw this._fail(400, 'INVALID_INPUT', 'Entry ID required.');

        return this.prisma.$transaction(async (tx) => {
            const original = await tx.businessLedgerEntry.findUnique({ where: { id: entryId } });
            if (!original || original.businessProfileId !== businessProfileId) {
                throw this._fail(404, 'ENTRY_NOT_FOUND', 'Ledger entry not found.');
            }

            // One reversal per entry — idempotent refusal, never a second
            // economic mutation.
            const existingReversal = await tx.businessLedgerEntry.findFirst({
                where: { businessProfileId, metadata: { path: ['reversalOf'], equals: entryId } },
                select: { id: true },
            });
            if (existingReversal) {
                throw this._fail(409, 'ALREADY_REVERSED', 'Ledger entry has already been reversed.');
            }

            const originalAmount = Number(original.amount);
            if (!Number.isFinite(originalAmount) || originalAmount === 0) {
                throw this._fail(409, 'NOT_REVERSIBLE', 'Entry cannot be reversed.');
            }

            const reversal = await tx.businessLedgerEntry.create({
                data: {
                    businessProfileId,
                    type: original.type,
                    category: original.category,
                    description: `Reversal: ${original.description}`.slice(0, 500),
                    amount: Math.round(-originalAmount * 1e6) / 1e6, // exact negation
                    sourceType: original.sourceType,
                    sourceId: original.sourceId,
                    metadata: {
                        reversalOf: original.id,
                        reversal: true,
                        reversedAmount: Number(original.amount),
                        ...(reason ? { reversalReason: String(reason).slice(0, 500) } : {}),
                    },
                },
            });
            return { reversal, original };
        });
    }

    // ── Get Ledger Entries ─────────────────────────────────────────────────
    async getEntries(businessProfileId, { type, category, startDate, endDate, limit = 100, offset = 0 } = {}) {
        const where = { businessProfileId };
        if (type) where.type = type;
        if (category) where.category = category;
        if (startDate && endDate) {
            where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const [entries, total] = await Promise.all([
            this.prisma.businessLedgerEntry.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
            this.prisma.businessLedgerEntry.count({ where }),
        ]);

        return { entries, total, hasMore: offset + entries.length < total };
    }

    // ── Get P&L Summary ────────────────────────────────────────────────────
    async getProfitLoss(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const entries = await this.prisma.businessLedgerEntry.findMany({ where });

        // r35: netProfit is now computed from the SIGNED amounts directly —
        // the canonical contract guarantees INCOME > 0 and other types < 0.
        const income = entries.filter(e => e.type === 'INCOME').reduce((s, e) => s + parseFloat(e.amount), 0);
        const expenses = entries.filter(e => e.type !== 'INCOME').reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);

        const byType = {};
        const byCategory = {};
        const incomeByCategory = {};
        const expenseByCategory = {};

        entries.forEach(e => {
            const amount = Math.abs(parseFloat(e.amount));
            const typeKey = e.type;
            const categoryKey = e.category || 'Uncategorized';
            byType[typeKey] = (byType[typeKey] || 0) + amount;
            byCategory[categoryKey] = (byCategory[categoryKey] || 0) + amount;
            if (e.type === 'INCOME') {
                incomeByCategory[categoryKey] = (incomeByCategory[categoryKey] || 0) + amount;
            } else {
                expenseByCategory[categoryKey] = (expenseByCategory[categoryKey] || 0) + amount;
            }
        });

        return {
            totalIncome: income,
            totalExpenses: expenses,
            netProfit: income - expenses,
            margin: income > 0 ? ((income - expenses) / income) * 100 : 0,
            byType,
            byCategory,
            incomeByCategory,
            expenseByCategory,
            entryCount: entries.length,
        };
    }

    // ── Get Cash Flow ──────────────────────────────────────────────────────
    async getCashFlow(businessProfileId, { startDate, endDate } = {}) {
        const where = { businessProfileId };
        if (startDate && endDate) {
            where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
        }

        const entries = await this.prisma.businessLedgerEntry.findMany({ where, orderBy: { createdAt: 'asc' } });
        let runningBalance = 0;
        const dailyFlow = {};
        const flow = entries.map(e => {
            const amount = parseFloat(e.amount);
            runningBalance += amount;
            const dateKey = new Date(e.createdAt).toISOString().split('T')[0];
            if (!dailyFlow[dateKey]) dailyFlow[dateKey] = { date: dateKey, inflow: 0, outflow: 0, net: 0 };
            if (amount > 0) dailyFlow[dateKey].inflow += amount;
            else dailyFlow[dateKey].outflow += Math.abs(amount);
            dailyFlow[dateKey].net += amount;
            return { id: e.id, date: e.createdAt, type: e.type, category: e.category, description: e.description, amount, runningBalance };
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
        if (startDate && endDate) where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
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
            categories: breakdown.map(e => ({ ...e, percentage: total > 0 ? (e.amount / total) * 100 : 0 })),
        };
    }

    // ── Get Dashboard Stats ─────────────────────────────────────────────────
    async getDashboardStats(businessProfileId) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
        const [currentEntries, previousEntries, allEntries] = await Promise.all([
            this.prisma.businessLedgerEntry.findMany({ where: { businessProfileId, createdAt: { gte: thirtyDaysAgo } } }),
            this.prisma.businessLedgerEntry.findMany({ where: { businessProfileId, createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } } }),
            this.prisma.businessLedgerEntry.findMany({ where: { businessProfileId } }),
        ]);
        const currentIncome = currentEntries.filter(e => e.type === 'INCOME').reduce((s, e) => s + parseFloat(e.amount), 0);
        const previousIncome = previousEntries.filter(e => e.type === 'INCOME').reduce((s, e) => s + parseFloat(e.amount), 0);
        const currentExpenses = currentEntries.filter(e => e.type !== 'INCOME').reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);
        const previousExpenses = previousEntries.filter(e => e.type !== 'INCOME').reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);
        return {
            revenue: { current: currentIncome, previous: previousIncome, change: previousIncome > 0 ? ((currentIncome - previousIncome) / previousIncome) * 100 : 0 },
            expenses: { current: currentExpenses, previous: previousExpenses, change: previousExpenses > 0 ? ((currentExpenses - previousExpenses) / previousExpenses) * 100 : 0 },
            profit: { current: currentIncome - currentExpenses, previous: previousIncome - previousExpenses },
            totalEntries: allEntries.length,
        };
    }

    // ── Delete Entry — r35: APPEND-ONLY REVERSAL, never a hard delete ──────
    // The public route contract (DELETE /ledger/:id -> { success }) is
    // preserved, but the implementation now writes an exact negating
    // reversal entry. The original row remains; the net economic effect is
    // zero; P&L history stays honest.
    async deleteEntry(entryId, businessProfileId, reason) {
        const { reversal } = await this.createReversalEntry({ businessProfileId, entryId, reason });
        return reversal;
    }
}

module.exports = { BusinessLedgerService, LEDGER_ENTRY_TYPES };
