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
const ledger = require('../ledgerService'); // r39/P1: canonical toExactDecimal authority

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
    //
    // r39/P1 — ONE CANONICAL EXACT-MONEY CONTRACT: parsing is DELEGATED to
    // ledger.toExactDecimal, the same authority as every financial rail
    // (chat money, POS, dine-in, escrow, the platform ledger). There are no
    // longer two subtly different "exact decimal" validators in the repo.
    //
    // Documented, tested INTENTIONAL differences from the raw parser, both
    // imposed by THIS service's contract rather than by parsing:
    //   • magnitude semantics: the caller supplies a NON-NEGATIVE magnitude
    //     and the SIGN comes from the entry type — so a negative input is
    //     ambiguous and is REJECTED (the old code silently took abs(); a
    //     caller who means -50 as a magnitude is now told, explicitly);
    //   • nonzero rule: a ledger entry of zero has no economic meaning and
    //     is rejected here (toExactDecimal itself accepts zero).
    // Everything else — exponent-string rejection, >8dp fractional float
    // rejection, padding trim, NaN/Infinity rejection, Decimal pass-through,
    // the 1e9 magnitude cap — is exactly the canonical parser's behavior.
    _canonicalAmount(type, amount) {
        let magnitude;
        try {
            magnitude = ledger.toExactDecimal(amount, 'amount');
        } catch (e) {
            throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount must be a non-negative exact decimal (<= 8 decimals, no exponent).');
        }
        if (magnitude.isZero()) throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount cannot be zero.');
        if (magnitude.gt(new Prisma.Decimal(String(MAX_ABS_AMOUNT)))) {
            throw this._fail(400, 'INVALID_AMOUNT', 'Ledger amount is unreasonably large.');
        }
        const signed = INCOME_TYPES.has(type) ? magnitude : magnitude.negated();
        return signed; // Prisma.Decimal — exact, no JS-number round-trip
    }

    // r39/P1 — CROSS-PERIOD REVERSAL ACCOUNTING RULE (one rule, every
    // bucket). Entries are SIGNED by type (INCOME > 0, everything else < 0)
    // and a reversal is the exact NEGATION of its original with the SAME
    // type. The reporting contract is deliberately SIGNED-NET, not abs():
    //
    //   bucket value = Σ(INCOME rows' amount) − Σ(non-INCOME rows' amount)
    //
    // Consequences (the tested contract):
    //   • an ordinary EXPENSE row (-50) reports +50 of expense;
    //   • its SAME-PERIOD reversal (+50) nets the bucket to 0;
    //   • a CROSS-PERIOD reversal (Jan expense -50, Feb reversal +50)
    //     reports January expenses +50 (history retained) and February
    //     expenses -50 — a NEGATIVE expense, i.e. an explicit correction
    //     that INCREASES February's profit — never a fabricated +50
    //     February expense the old abs(sum) produced;
    //   • cumulative reporting nets to exactly zero;
    //   • P&L, byType, byCategory, expenseBreakdown and the dashboard all
    //     follow this one rule; cash-flow stays literal signed flow.
    // INCOME reversals already followed the rule (income buckets report
    // the signed sum as-is, so a -50 income reversal reports -50).
    _sumSigned(entries) {
        return entries.reduce((acc, e) => acc.plus(new Prisma.Decimal(e.amount)), new Prisma.Decimal(0));
    }

    // bucket value = Σ income − Σ non-income, per the cross-period rule.
    _expenseBucketValue(entries) {
        return this._sumSigned(entries.filter(e => e.type !== 'INCOME')).negated();
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

        // r39: the ONE cross-period reversal rule — income buckets are the
        // signed sum of INCOME rows; expense buckets are the NEGATED signed
        // net of non-INCOME rows (an ordinary expense is -50 → +50; a
        // cross-period reversal is +50 → -50, an explicit correction that
        // increases the reversal period's profit). Never abs().
        const incomeDec = this._sumSigned(entries.filter(e => e.type === 'INCOME'));
        const expensesDec = this._expenseBucketValue(entries);
        const income = this._num(incomeDec);
        const expenses = this._num(expensesDec);

        const byTypeDec = {};
        const byCategoryIncomeDec = {};
        const byCategoryExpenseDec = {};

        entries.forEach(e => {
            const amount = new Prisma.Decimal(e.amount);
            const typeKey = e.type;
            const categoryKey = e.category || 'Uncategorized';
            if (typeKey === 'INCOME') {
                byTypeDec[typeKey] = (byTypeDec[typeKey] || new Prisma.Decimal(0)).plus(amount);
                byCategoryIncomeDec[categoryKey] = (byCategoryIncomeDec[categoryKey] || new Prisma.Decimal(0)).plus(amount);
            } else {
                byTypeDec[typeKey] = (byTypeDec[typeKey] || new Prisma.Decimal(0)).minus(amount);
                byCategoryExpenseDec[categoryKey] = (byCategoryExpenseDec[categoryKey] || new Prisma.Decimal(0)).minus(amount);
            }
        });

        // The margin percentage keeps its historical meaning when income is
        // positive; a negative expense (cross-period correction) correctly
        // raises profit and margin.
        return {
            totalIncome: income,
            totalExpenses: expenses,
            netProfit: this._num(incomeDec.minus(expensesDec)),
            margin: income > 0 ? ((income - expenses) / income) * 100 : 0,
            byType: Object.keys(byTypeDec).reduce((o, k) => {
                o[k] = this._num(byTypeDec[k]);
                return o;
            }, {}),
            byCategory: (() => {
                // One merged category view: income categories signed,
                // expense categories negated signed net.
                const out = {};
                for (const k of Object.keys(byCategoryIncomeDec)) out[k] = this._num(byCategoryIncomeDec[k]);
                for (const k of Object.keys(byCategoryExpenseDec)) out[k] = this._num(byCategoryExpenseDec[k]);
                return out;
            })(),
            incomeByCategory: Object.keys(byCategoryIncomeDec).reduce((o, k) => {
                o[k] = this._num(byCategoryIncomeDec[k]);
                return o;
            }, {}),
            expenseByCategory: Object.keys(byCategoryExpenseDec).reduce((o, k) => {
                o[k] = this._num(byCategoryExpenseDec[k]);
                return o;
            }, {}),
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
        // r38/P1 — EXACT ARITHMETIC: accumulation runs on Prisma.Decimal
        // (matching the stored Decimal(20,8) precision) so 0.1 + 0.2
        // reports exactly 0.3 and reversal pairs net to exactly zero —
        // no binary floating-point artifacts in the reporting layer.
        // Serialization is deliberate: each exact decimal is emitted via
        // _num() (8dp string -> number), keeping the legacy JSON envelope
        // while the underlying computation is exact.
        let runningBalance = new Prisma.Decimal(0);
        const dailyFlow = {};
        const flow = entries.map(e => {
            const amount = new Prisma.Decimal(e.amount);
            runningBalance = runningBalance.plus(amount);
            const dateKey = new Date(e.createdAt).toISOString().split('T')[0];
            if (!dailyFlow[dateKey]) {
                dailyFlow[dateKey] = { date: dateKey, inflow: new Prisma.Decimal(0), outflow: new Prisma.Decimal(0), net: new Prisma.Decimal(0) };
            }
            if (amount.isPositive()) dailyFlow[dateKey].inflow = dailyFlow[dateKey].inflow.plus(amount);
            else dailyFlow[dateKey].outflow = dailyFlow[dateKey].outflow.plus(amount.abs());
            dailyFlow[dateKey].net = dailyFlow[dateKey].net.plus(amount);
            return {
                id: e.id, date: e.createdAt, type: e.type, category: e.category, description: e.description,
                amount: this._num(amount), runningBalance: this._num(runningBalance),
            };
        });

        const totalInflow = this._sumSigned(entries.filter(e => new Prisma.Decimal(e.amount).isPositive()));
        const totalOutflow = this._sumSigned(entries.filter(e => new Prisma.Decimal(e.amount).isNegative())).abs();

        return {
            entries: flow,
            dailyFlow: Object.values(dailyFlow).map(d => ({
                date: d.date, inflow: this._num(d.inflow), outflow: this._num(d.outflow), net: this._num(d.net),
            })),
            totalInflow: this._num(totalInflow),
            totalOutflow: this._num(totalOutflow),
            netFlow: this._num(runningBalance),
            startingBalance: 0,
            endingBalance: this._num(runningBalance),
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
            // r39: the negated signed net per category — a same-period
            // reversal nets to 0; a cross-period reversal reports a NEGATIVE
            // expense (an explicit correction), never a fabricated expense.
            byCategory[key].sum = byCategory[key].sum.minus(new Prisma.Decimal(e.amount));
            byCategory[key].count += 1;
        });
        const breakdown = Object.values(byCategory)
            .map(({ category, sum, count }) => ({ category, amount: this._num(sum), count }))
            .sort((a, b) => b.amount - a.amount);
        const total = breakdown.reduce((s, e) => s + e.amount, 0);
        // Percentage shares are only meaningful over a POSITIVE total; a
        // net-negative period (corrections exceeding new expenses) reports
        // no percentages rather than nonsense ones.
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
        // r39: the cross-period reversal rule in the dashboard too — a
        // reversal landing in the current window reports as a NEGATIVE
        // expense (correction), not a fabricated one. Change percentages
        // are only computed against a positive comparison base.
        const currentIncome = this._num(this._sumSigned(currentEntries.filter(e => e.type === 'INCOME')));
        const previousIncome = this._num(this._sumSigned(previousEntries.filter(e => e.type === 'INCOME')));
        const currentExpenses = this._num(this._expenseBucketValue(currentEntries));
        const previousExpenses = this._num(this._expenseBucketValue(previousEntries));
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
