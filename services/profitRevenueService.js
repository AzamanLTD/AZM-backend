'use strict';

// =============================================================================
// AZAMAN — what counts as revenue in AdminProfitLog.
//
// AdminProfitLog is an audit trail, not a revenue ledger. Besides real fees it
// holds rows that are not Azaman's money:
//   • every settled fiat withdrawal logs its full principal as
//     ARBITRAGE_SPREAD (arbitrage_capture_<ref>, services/finance.service.js);
//     that money was paid out to the customer;
//   • a profit liquidation logs the liquidated amount as ARBITRAGE_SPREAD
//     (liquidation_admin_<id>_<ts>); it moves profit that was already booked
//     into the fiat pool, so counting it books the same money twice;
//   • the referrer's half of a referred customer's exit fee is logged as
//     EXIT_FEE (referral_split_referrer_<id>_<ref>); it is paid to the
//     referrer.
// No code books a real FX spread as ARBITRAGE_SPREAD, so every row of that
// source is left out of revenue. Rows not written by the two paths above are
// kept visible as their own line instead of being counted.
//
// Reversals reach the log in three forms, and each nets against the source it
// reverses:
//   • a negative row of the same source (booking fee refunds);
//   • a positive row with isSubsidized = true (crypto withdrawal refunds: the
//     CHECK constraint APL_amountUsdc_nonneg forbids negative rows there);
//   • deleted rows (legacy fiat withdrawal reversals): nothing left to count.
//
// Days are UTC calendar days (Ghana is UTC+0).
// =============================================================================

const { Prisma } = require('@prisma/client');

const KIND = Object.freeze({
    REVENUE: 'REVENUE',
    REVERSAL: 'REVERSAL',
});

/**
 * Rows that are not Azaman revenue, matched in order. A row matching a rule is
 * reported under that rule's key and never counted as revenue.
 * `prefix: null` matches every remaining row of the source.
 */
const NON_REVENUE_RULES = Object.freeze([
    Object.freeze({
        key: 'WITHDRAWAL_PRINCIPAL',
        source: 'ARBITRAGE_SPREAD',
        prefix: 'arbitrage_capture_',
        label: 'Cash-out principal',
        reason: 'The full amount of each settled MoMo cash-out. It is paid out to the customer.',
    }),
    Object.freeze({
        key: 'PROFIT_LIQUIDATION',
        source: 'ARBITRAGE_SPREAD',
        prefix: 'liquidation_admin_',
        label: 'Profit moved to the fiat pool',
        reason: 'Profit that was already counted when it was earned, moved into the fiat pool.',
    }),
    Object.freeze({
        key: 'ARBITRAGE_SPREAD_OTHER',
        source: 'ARBITRAGE_SPREAD',
        prefix: null,
        label: 'Other ARBITRAGE_SPREAD rows',
        reason: 'No code books a real FX spread under this source; these rows are left out until someone checks them.',
    }),
    Object.freeze({
        key: 'REFERRER_PAYOUT',
        source: 'EXIT_FEE',
        prefix: 'referral_split_referrer_',
        label: "Referrer's half of the exit fee",
        reason: 'Paid to the customer who referred the user, not kept by Azaman.',
    }),
]);

const RULE_BY_KEY = new Map(NON_REVENUE_RULES.map((rule) => [rule.key, rule]));

const ZERO = new Prisma.Decimal(0);
const dec = (value) => new Prisma.Decimal(value == null ? 0 : String(value));
const toNumber = (decimal) => Number(decimal.toDecimalPlaces(8).toString());

/** The SQL CASE that names each row's kind (a rule key, REVERSAL or REVENUE). */
function kindSql() {
    const whens = NON_REVENUE_RULES.map((rule) => (rule.prefix == null
        ? Prisma.sql`WHEN l.source::text = ${rule.source}::text THEN ${rule.key}::text`
        : Prisma.sql`WHEN l.source::text = ${rule.source}::text AND starts_with(COALESCE(l."relatedTxId", ''), ${rule.prefix}::text) THEN ${rule.key}::text`));
    return Prisma.sql`CASE ${Prisma.join(whens, ' ')}
        WHEN l."isSubsidized" OR l."amountUsdc" < 0 THEN ${KIND.REVERSAL}::text
        ELSE ${KIND.REVENUE}::text END`;
}

/**
 * AdminProfitLog in [from, to) grouped by UTC day, source and kind.
 * A reversal's amount is its magnitude (it is subtracted); every other amount
 * keeps its sign.
 * @returns {Promise<Array<{day: string, source: string, kind: string, n: number, amount: string}>>}
 */
async function readRows(db, { from, to }) {
    return db.$queryRaw`
        SELECT t.day, t.source, t.kind, COUNT(*)::int AS n,
               COALESCE(SUM(CASE WHEN t.kind = ${KIND.REVERSAL}::text THEN ABS(t.amt) ELSE t.amt END), 0)::text AS amount
        FROM (
            SELECT to_char(l."createdAt", 'YYYY-MM-DD') AS day,
                   l.source::text AS source,
                   l."amountUsdc" AS amt,
                   ${kindSql()} AS kind
            FROM "AdminProfitLog" l
            WHERE l."createdAt" >= ${from} AND l."createdAt" < ${to}
        ) t
        GROUP BY t.day, t.source, t.kind
        ORDER BY t.day, t.source, t.kind`;
}

/**
 * Totals from readRows' output.
 * bySource holds revenue sources only: totalUsdc is net of reversals, count is
 * the number of charges, and the reversed amount is shown beside it.
 * excluded holds the non-revenue rows by rule.
 */
function summarize(rows) {
    const bySource = new Map();
    const excluded = new Map();
    const days = new Map();
    let revenue = ZERO;
    let reversed = ZERO;
    let revenueCount = 0;
    let reversalCount = 0;

    for (const row of rows || []) {
        const amount = dec(row.amount);
        const n = Number(row.n || 0);
        const rule = RULE_BY_KEY.get(row.kind);
        if (rule) {
            const entry = excluded.get(rule.key) || { amount: ZERO, count: 0 };
            entry.amount = entry.amount.plus(amount);
            entry.count += n;
            excluded.set(rule.key, entry);
            continue;
        }
        const signed = row.kind === KIND.REVERSAL ? amount.negated() : amount;
        const source = bySource.get(row.source) || { gross: ZERO, reversed: ZERO, count: 0, reversalCount: 0 };
        if (row.kind === KIND.REVERSAL) {
            source.reversed = source.reversed.plus(amount);
            source.reversalCount += n;
            reversed = reversed.plus(amount);
            reversalCount += n;
        } else {
            source.gross = source.gross.plus(amount);
            source.count += n;
            revenue = revenue.plus(amount);
            revenueCount += n;
        }
        bySource.set(row.source, source);

        const day = days.get(row.day) || { profit: ZERO, bySource: new Map() };
        day.profit = day.profit.plus(signed);
        day.bySource.set(row.source, (day.bySource.get(row.source) || ZERO).plus(signed));
        days.set(row.day, day);
    }

    const sourceBreakdown = {};
    for (const [source, s] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        sourceBreakdown[source] = {
            totalUsdc: toNumber(s.gross.minus(s.reversed)),
            count: s.count,
            grossUsdc: toNumber(s.gross),
            reversedUsdc: toNumber(s.reversed),
            reversalCount: s.reversalCount,
        };
    }

    let excludedTotal = ZERO;
    let excludedCount = 0;
    const excludedItems = [];
    for (const rule of NON_REVENUE_RULES) {
        const entry = excluded.get(rule.key);
        if (!entry) continue;
        excludedTotal = excludedTotal.plus(entry.amount);
        excludedCount += entry.count;
        excludedItems.push({
            key: rule.key,
            source: rule.source,
            label: rule.label,
            reason: rule.reason,
            totalUsdc: toNumber(entry.amount),
            count: entry.count,
        });
    }

    const daily = new Map();
    for (const [day, d] of days) {
        const daySources = {};
        for (const [source, amount] of d.bySource) daySources[source] = toNumber(amount);
        daily.set(day, { profit: toNumber(d.profit), bySource: daySources });
    }

    return {
        sourceBreakdown,
        totalUsdc: toNumber(revenue.minus(reversed)),
        count: revenueCount,
        reversals: { totalUsdc: toNumber(reversed), count: reversalCount },
        excluded: { totalUsdc: toNumber(excludedTotal), count: excludedCount, items: excludedItems },
        daily,
    };
}

/** Revenue in [from, to): readRows then summarize. */
async function readRevenue(db, range) {
    return summarize(await readRows(db, range));
}

module.exports = {
    KIND,
    NON_REVENUE_RULES,
    readRows,
    summarize,
    readRevenue,
};
