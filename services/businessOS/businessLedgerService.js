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
const { Prisma } = require('@prisma/client');

const LEDGER_ENTRY_TYPES = ['INCOME', 'EXPENSE', 'PAYROLL', 'TAX', 'REFUND', 'PENALTY', 'AD_SPEND', 'MAINTENANCE', 'SUPPLIES', 'UTILITIES', 'RENT', 'OTHER'];

// Exact 8-decimal string of a stored Decimal — used in metadata so reversal
// payloads never lose precision through JS number coercion.
const _fixed = (d) => new Prisma.Decimal(d).toFixed(8);
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

    // r37/P1 — CANONICAL AGGREGATION FORMULA (signed semantics preserved).
    // Entries are SIGNED by type (INCOME > 0, everything else < 0) and a
    // reversal is the exact NEGATION of its original with the SAME type.
    // Aggregating Math.abs(amount) per row breaks that contract for expense
    // reversals: an EXPENSE of -50 plus its reversal of +50 would report
    // 100 of expense instead of 0. The canonical rule:
    //   • income bucket  = signed sum of INCOME rows
    //   • expense bucket = abs(signed sum of non-INCOME rows)
    //                     (reversals net to zero INSIDE the sum)
    // Per-type and per-category buckets follow the same rule. Decimal
    // accumulation keeps the arithmetic exact to the stored precision.
    _sumSigned(entries) {
        return entries.reduce((acc, e) => acc.plus(new Prisma.Decimal(e.amount)), new Prisma.Decimal(0));
    }

    _num(dec) {
        return Number(dec.toFixed(8));
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

            // r37/P1: a reversal row may never itself be reversed — chains
            // would double-apply economics. The durable reversalOfId column
            // (and the legacy metadata flag) identify reversal rows.
            if (original.reversalOfId != null || original.metadata?.reversal === true) {
                throw this._fail(409, 'NOT_REVERSIBLE', 'Reversal entries cannot be reversed.');
            }

            const originalAmount = new Prisma.Decimal(original.amount);
            if (!originalAmount.isFinite() || originalAmount.isZero()) {
                throw this._fail(409, 'NOT_REVERSIBLE', 'Entry cannot be reversed.');
            }

            let reversal;
            try {
                // r37/P1 — THE INVARIANT: reversalOfId carries a database
                // UNIQUE index. Two simultaneous reversal requests both pass
                // any serial pre-check; exactly one INSERT wins — the loser
                // fails on the unique index (P2002) and fails closed with
                // zero mutation. The original row is never mutated; one
                // entry gets exactly one reversal, durably.
                reversal = await tx.businessLedgerEntry.create({
                    data: {
                        businessProfileId,
                        type: original.type,
                        category: original.category,
                        description: `Reversal: ${original.description}`.slice(0, 500),
                        amount: originalAmount.neg(), // exact negation, full Decimal precision
                        sourceType: original.sourceType,
                        sourceId: original.sourceId,
                        reversalOfId: original.id,
                        metadata: {
                            reversalOf: original.id,
                            reversal: true,
                            reversedAmount: _fixed(original.amount),
                            ...(reason ? { reversalReason: String(reason).slice(0, 500) } : {}),
                        },
                    },
                });
            } catch (e) {
                if (e.code === 'P2002' && String(e.meta?.target || '').includes('reversalOfId')) {
                    throw this._fail(409, 'ALREADY_REVERSED', 'Ledger entry has already been reversed.');
                }
                throw e;
            }
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

        // r37: canonical SIGNED aggregation — reversals net to zero inside
        // their bucket instead of inflating gross amounts (see _sumSigned).
        const income = this._num(this._sumSigned(entries.filter(e => e.type === 'INCOME')));
        const expenses = this._num(this._sumSigned(entries.filter(e => e.type !== 'INCOME')).abs());

        const byTypeDec = {};
        const byCategoryDec = {};
        const incomeByCategoryDec = {};
        const expenseByCategoryDec = {};

        entries.forEach(e => {
            const amount = new Prisma.Decimal(e.amount);
            const typeKey = e.type;
            const categoryKey = e.category || 'Uncategorized';
            byTypeDec[typeKey] = (byTypeDec[typeKey] || new Prisma.Decimal(0)).plus(amount);
            byCategoryDec[categoryKey] = (byCategoryDec[categoryKey] || new Prisma.Decimal(0)).plus(amount);
            if (e.type === 'INCOME') {
                incomeByCategoryDec[categoryKey] = (incomeByCategoryDec[categoryKey] || new Prisma.Decimal(0)).plus(amount);
            } else {
                expenseByCategoryDec[categoryKey] = (expenseByCategoryDec[categoryKey] || new Prisma.Decimal(0)).plus(amount);
            }
        });

        // INCOME buckets report the signed sum as-is; every other bucket
        // reports the abs of its signed NET (a reversal of EXPENSE -50 is
        // +50, so the bucket nets to 0 — never double-counted as gross).
        const report = (map, absNet) => {
            const out = {};
            for (const k of Object.keys(map)) out[k] = this._num(absNet ? map[k].abs() : map[k]);
            return out;
        };

        return {
            totalIncome: income,
            totalExpenses: expenses,
            netProfit: this._num(new Prisma.Decimal(income).minus(new Prisma.Decimal(expenses))),
            margin: income > 0 ? ((income - expenses) / income) * 100 : 0,
            byType: Object.keys(byTypeDec).reduce((o, k) => {
                o[k] = this._num(k === 'INCOME' ? byTypeDec[k] : byTypeDec[k].abs());
                return o;
            }, {}),
            byCategory: report(byCategoryDec, true), // magnitude, reversal-netted
            incomeByCategory: report(incomeByCategoryDec, false),
            expenseByCategory: report(expenseByCategoryDec, true),
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
            if (!byCategory[key]) byCategory[key] = { category: key, sum: new Prisma.Decimal(0), count: 0 };
            // r37: signed net per category — an expense reversal cancels its
            // original instead of adding another gross expense.
            byCategory[key].sum = byCategory[key].sum.plus(new Prisma.Decimal(e.amount));
            byCategory[key].count += 1;
        });
        const breakdown = Object.values(byCategory)
            .map(({ category, sum, count }) => ({ category, amount: this._num(sum.abs()), count }))
            .sort((a, b) => b.amount - a.amount);
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
        // r37: canonical signed aggregation (reversals net inside the sum).
        const currentIncome = this._num(this._sumSigned(currentEntries.filter(e => e.type === 'INCOME')));
        const previousIncome = this._num(this._sumSigned(previousEntries.filter(e => e.type === 'INCOME')));
        const currentExpenses = this._num(this._sumSigned(currentEntries.filter(e => e.type !== 'INCOME')).abs());
        const previousExpenses = this._num(this._sumSigned(previousEntries.filter(e => e.type !== 'INCOME')).abs());
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
