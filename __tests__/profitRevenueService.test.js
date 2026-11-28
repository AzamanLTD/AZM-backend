'use strict';

// What counts as Azaman revenue in AdminProfitLog (services/profitRevenueService).
//   R1. The rules match the rows the app writes: each non-revenue rule's
//       prefix is the relatedTxId its writer uses, and every ARBITRAGE_SPREAD
//       writer is one of the known non-revenue kinds.
//   R2. The query classifies non-revenue rows before reversals, keeps a NULL
//       relatedTxId as revenue, and is bounded by [from, to).
//   R3. summarize: reversals net against their source, non-revenue rows are
//       reported apart, and the days add up to the total.

const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const profitRevenue = require('../services/profitRevenueService');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Every non-test .js file under the app folders. */
function appFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const rel = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '__tests__', 'tests', 'coverage'].includes(entry.name)) continue;
                walk(rel);
            } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
                out.push(rel);
            }
        }
    };
    ['controllers', 'services', 'src', 'workers', 'routes', 'utils'].forEach((d) => {
        if (fs.existsSync(path.join(root, d))) walk(d);
    });
    return out;
}

describe('R1 the rules match what the app writes', () => {
    const finance = read('services/finance.service.js');
    const rule = (key) => profitRevenue.NON_REVENUE_RULES.find((r) => r.key === key);

    test('a settled cash-out logs its principal under the WITHDRAWAL_PRINCIPAL prefix', () => {
        expect(rule('WITHDRAWAL_PRINCIPAL')).toMatchObject({ source: 'ARBITRAGE_SPREAD', prefix: 'arbitrage_capture_' });
        expect(finance).toMatch(/source: 'ARBITRAGE_SPREAD', relatedTxId: `arbitrage_capture_\$\{reference\}`/);
    });

    test('a profit liquidation logs under the PROFIT_LIQUIDATION prefix', () => {
        expect(rule('PROFIT_LIQUIDATION')).toMatchObject({ source: 'ARBITRAGE_SPREAD', prefix: 'liquidation_admin_' });
        expect(finance).toMatch(/source: 'ARBITRAGE_SPREAD', relatedTxId: `liquidation_admin_\$\{adminId\}_/);
    });

    test("the referrer's half of an exit fee logs under the REFERRER_PAYOUT prefix; Azaman's half does not", () => {
        expect(rule('REFERRER_PAYOUT')).toMatchObject({ source: 'EXIT_FEE', prefix: 'referral_split_referrer_' });
        expect(finance).toMatch(/source: 'EXIT_FEE', relatedTxId: `referral_split_referrer_\$\{referrerId\}_\$\{reference\}`/);
        expect(finance).toMatch(/source: 'EXIT_FEE', relatedTxId: `referral_split_system_\$\{reference\}`/);
        expect('referral_split_system_X'.startsWith(rule('REFERRER_PAYOUT').prefix)).toBe(false);
    });

    test('every ARBITRAGE_SPREAD writer in the app is a known non-revenue kind', () => {
        const known = profitRevenue.NON_REVENUE_RULES
            .filter((r) => r.source === 'ARBITRAGE_SPREAD' && r.prefix)
            .map((r) => r.prefix);
        const writers = [];
        for (const file of appFiles()) {
            const text = read(file);
            for (const m of text.matchAll(/source:\s*'ARBITRAGE_SPREAD'[^\n]*relatedTxId:\s*`([a-z_]+)/g)) {
                writers.push({ file, prefix: m[1] });
            }
        }
        expect(writers.length).toBeGreaterThanOrEqual(2);
        for (const w of writers) expect(known).toContain(w.prefix);
    });

    test('a positive isSubsidized row is only ever written as a refund', () => {
        for (const file of appFiles()) {
            const text = read(file);
            for (const m of text.matchAll(/isSubsidized:\s*true/g)) {
                const before = text.slice(Math.max(0, m.index - 600), m.index);
                expect({ file, refund: /relatedTxId:\s*`[a-z_]*refund/.test(before) }).toEqual({ file, refund: true });
            }
        }
    });
});

describe('R2 the query', () => {
    function capture() {
        let query;
        const db = { $queryRaw: jest.fn(async (strings, ...values) => { query = Prisma.sql(strings, ...values); return []; }) };
        return { db, get: () => query };
    }

    test('names non-revenue rows first, then reversals (a negative or isSubsidized row), else revenue', async () => {
        const { db, get } = capture();
        const from = new Date('2026-11-01T00:00:00.000Z');
        const to = new Date('2026-11-08T00:00:00.000Z');
        await profitRevenue.readRows(db, { from, to });
        const q = get();

        expect(q.sql).toContain('FROM "AdminProfitLog" l');
        expect(q.sql).toContain('l."createdAt" >= ? AND l."createdAt" < ?');
        expect(q.values.slice(-2)).toEqual([from, to]);
        // A NULL relatedTxId never matches a prefix (it stays revenue).
        expect(q.sql).toContain(`starts_with(COALESCE(l."relatedTxId", ''), ?::text)`);

        const kinds = q.values.filter((v) => typeof v === 'string' && /^[A-Z_]+$/.test(v));
        const order = kinds.filter((v) => ['WITHDRAWAL_PRINCIPAL', 'PROFIT_LIQUIDATION', 'ARBITRAGE_SPREAD_OTHER', 'REFERRER_PAYOUT', 'REVENUE'].includes(v));
        expect(order).toEqual(['WITHDRAWAL_PRINCIPAL', 'PROFIT_LIQUIDATION', 'ARBITRAGE_SPREAD_OTHER', 'REFERRER_PAYOUT', 'REVENUE']);
        expect(q.sql.indexOf('l."isSubsidized" OR l."amountUsdc" < 0')).toBeGreaterThan(q.sql.lastIndexOf('starts_with'));
        // A reversal subtracts its magnitude.
        expect(q.sql).toContain('CASE WHEN t.kind = ?::text THEN ABS(t.amt) ELSE t.amt END');
    });
});

describe('R3 summarize', () => {
    test('nets reversals per source, reports non-revenue apart, and the days add up', () => {
        const out = profitRevenue.summarize([
            { day: '2026-11-01', source: 'EXIT_FEE', kind: 'REVENUE', n: 3, amount: '6.00000001' },
            { day: '2026-11-01', source: 'EXIT_FEE', kind: 'REFERRER_PAYOUT', n: 1, amount: '2' },
            { day: '2026-11-02', source: 'EXIT_FEE', kind: 'REVERSAL', n: 1, amount: '1' },
            { day: '2026-11-02', source: 'ARBITRAGE_SPREAD', kind: 'ARBITRAGE_SPREAD_OTHER', n: 4, amount: '40' },
            { day: '2026-11-02', source: 'SUSU_FEE', kind: 'REVENUE', n: 1, amount: '0.1' },
            { day: '2026-11-02', source: 'SUSU_FEE', kind: 'REVENUE', n: 1, amount: '0.2' },
        ]);

        expect(out.sourceBreakdown).toEqual({
            EXIT_FEE: { totalUsdc: 5.00000001, count: 3, grossUsdc: 6.00000001, reversedUsdc: 1, reversalCount: 1 },
            SUSU_FEE: { totalUsdc: 0.3, count: 2, grossUsdc: 0.3, reversedUsdc: 0, reversalCount: 0 },
        });
        // Exact decimal sums: 0.1 + 0.2 is 0.3, not 0.30000000000000004.
        expect(out.totalUsdc).toBe(5.30000001);
        expect(out.count).toBe(5);
        expect(out.reversals).toEqual({ totalUsdc: 1, count: 1 });
        expect(out.excluded.totalUsdc).toBe(42);
        expect(out.excluded.items.map((i) => i.key)).toEqual(['ARBITRAGE_SPREAD_OTHER', 'REFERRER_PAYOUT']);
        expect(out.daily.get('2026-11-01')).toEqual({ profit: 6.00000001, bySource: { EXIT_FEE: 6.00000001 } });
        expect(out.daily.get('2026-11-02')).toEqual({ profit: -0.7, bySource: { EXIT_FEE: -1, SUSU_FEE: 0.3 } });
    });

    test('no rows: zeros and empty lists', () => {
        const out = profitRevenue.summarize([]);
        expect(out).toMatchObject({
            sourceBreakdown: {},
            totalUsdc: 0,
            count: 0,
            reversals: { totalUsdc: 0, count: 0 },
            excluded: { totalUsdc: 0, count: 0, items: [] },
        });
        expect(out.daily.size).toBe(0);
    });
});
