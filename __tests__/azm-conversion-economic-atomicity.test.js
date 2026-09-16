// =============================================================================
// AZM→USDC Conversion Economic Atomicity (real PostgreSQL)
// =============================================================================
// Reproduces and locks the concurrency defects of POST /api/azm-convert:
//
//   1. User AZM overdraft: the transaction did read-then-decrement
//      (`findUnique` → JS check → unconditional `update`), so two racing
//      conversions both passed the check from the same stale read and drove
//      azmBalance negative, each crediting full USDC (double spend).
//   2. Conversion pool overdraft: the SystemProfitFees balance check ran
//      OUTSIDE the transaction and the in-tx decrement was unconditional,
//      so racing conversions overdraw the platform's USDC pool.
//   3. Evidence drift: newAzmBalance/newUsdcBalance were computed from the
//      stale pre-read, so the ledger recorded balances that never existed.
//
// The fix authorizes at the database boundary: conditional (gte) mutations
// for both the user debit+credit and the pool debit. This suite forces the
// OLD implementation's interleaving deterministically: a barrier hooks the
// old write statement (`user.update` with an azmBalance decrement payload)
// BEFORE the SQL executes (so no row locks are held while waiting) and holds
// the first writer until every expected writer has issued its write — all
// stale reads are then guaranteed committed. The fixed implementation uses
// conditional `updateMany` and never trips the barrier.
//
// Test DB parity: run against a plain `prisma db push` schema — NO SQL CHECK
// constraints. The application-level conditional mutations are the only gate,
// exactly like production.
// =============================================================================

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const hasDb = Boolean(TEST_DATABASE_URL);
const describeOrSkip = hasDb ? describe : describe.skip;

if (hasDb) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
}

const { PrismaClient: RealPrismaClient } = jest.requireActual('@prisma/client');
const base = hasDb
    ? new RealPrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } })
    : null;

// ── Deterministic interleaving barrier ──────────────────────────────────────
// Engages ONLY on the old implementation's unconditional write signature
// (user.update carrying an azmBalance decrement). The writer is held BEFORE
// its SQL executes, so no DB locks are held while waiting; once the final
// expected writer arrives, everyone releases and each stale-authorized
// decrement applies. The fixed implementation (updateMany) never triggers it.
const BARRIER_TIMEOUT_MS = 8000; // safety net: never hang CI
let barrierMode = null;
let expectedWriters = 2;
let writeCount = 0;
let releaseBarrier = () => {};
let barrierGate = Promise.resolve();

function armBarrier(mode, writers) {
    barrierMode = mode;
    expectedWriters = writers;
    writeCount = 0;
    barrierGate = new Promise((resolve) => {
        releaseBarrier = resolve;
        setTimeout(resolve, BARRIER_TIMEOUT_MS);
    });
}

function disarmBarrier() {
    barrierMode = null;
    releaseBarrier();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prisma = hasDb
    ? base.$extends({
          query: {
              user: {
                  async update({ args, query }) {
                      const isAzmDebit =
                          barrierMode === 'user-debit' &&
                          args.data &&
                          args.data.azmBalance &&
                          args.data.azmBalance.decrement !== undefined;
                      if (isAzmDebit) {
                          writeCount += 1;
                          if (writeCount < expectedWriters) {
                              await barrierGate; // hold before the SQL — no locks held
                          } else {
                              releaseBarrier(); // last writer releases everyone
                          }
                      }
                      return query(args);
                  },
              },
          },
      })
    : null;

// Route the controller's module-level `new PrismaClient()` to the extended
// (barrier-instrumented) client so the forced interleaving is deterministic.
// The variable must carry the `mock` prefix (jest.mock hoisting rule); the
// factory executes lazily at require time, after the assignment below.
let mockPrisma = null;
jest.mock('@prisma/client', () => ({
    PrismaClient: function BarrierRoutedClient() {
        return mockPrisma;
    },
}));
mockPrisma = prisma;

const controller = require('../controllers/azmConversionController');

// ── Helpers ─────────────────────────────────────────────────────────────────
const dec = (x) => parseFloat(x.toString());
const uniq = () => `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

async function callConvert(userId, azmAmount) {
    const out = { statusCode: null, body: null };
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return { json: (b) => this.json(b) }; },
        json(b) { out.statusCode = this.statusCode; out.body = b; },
    };
    const req = {
        user: { id: userId },
        body: { azmAmount },
        headers: {},
        app: { get: () => null },
    };
    try {
        await controller.convertAzmToUsdc(req, res);
    } catch (e) {
        out.throw = e.message;
    }
    return out;
}

async function seedUser(azmBalance, availableBalance = 0) {
    const id = uniq();
    return base.user.create({
        data: {
            username: `u_${id}`,
            email: `${id}@test.example.com`,
            password: 'seed',
            azmBalance,
            availableBalance,
        },
    });
}

// Exact-id bookkeeping — never truncate shared tables.
const createdUserIds = [];
const swept = { spend: [], conversion: [], history: [] };

async function sweepUserArtefacts(userId) {
    const spendLogs = await base.azmSpendLog.findMany({ where: { userId }, select: { id: true } });
    for (const l of spendLogs) swept.spend.push(l.id);
    const histories = await base.transactionHistory.findMany({ where: { userId }, select: { id: true } });
    for (const h of histories) swept.history.push(h.id);
    const conversions = await base.azmConversionLog.findMany({ where: { userId }, select: { id: true } });
    for (const c of conversions) swept.conversion.push(c.id);
    await base.transactionHistory.deleteMany({ where: { userId, id: { in: swept.history } } });
    await base.azmConversionLog.deleteMany({ where: { userId, id: { in: swept.conversion } } });
    await base.azmSpendLog.deleteMany({ where: { userId, id: { in: swept.spend } } });
}

let poolBalanceBefore;

beforeAll(async () => {
    if (!hasDb) return;
    // The pool row (id: 1) is shared state across the whole battery — snapshot
    // its balance and restore it on teardown so this suite leaks nothing.
    let pool = await base.systemProfitFees.findUnique({ where: { id: 1 } });
    if (!pool) {
        pool = await base.systemProfitFees.create({ data: { id: 1, balance: 0 } });
    }
    poolBalanceBefore = dec(pool.balance);
});

afterAll(async () => {
    if (!hasDb) return;
    for (const userId of createdUserIds) {
        await sweepUserArtefacts(userId);
        await base.user.delete({ where: { id: userId } }).catch(() => {});
    }
    const idemKeys = await base.idempotencyKey.findMany({ select: { key: true } });
    const ours = idemKeys.filter((k) => k.key.startsWith('conv-test-')).map((k) => k.key);
    await base.idempotencyKey.deleteMany({ where: { key: { in: ours } } }).catch(() => {});
    // Restore the shared pool to whatever it was before this suite ran.
    await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: poolBalanceBefore } });
    await base.$disconnect();
});

describeOrSkip('AZM→USDC conversion economic atomicity (real PostgreSQL)', () => {
    // ── 1. Concurrent conversions cannot overdraw azmBalance ────────────────
    test('1 — two racing full-balance conversions: exactly one commits, balance never negative, USDC credited once', async () => {
        const AZM = 2000;
        const user = await seedUser(AZM);
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 1000 } });

        armBarrier('user-debit', 2);
        const [a, b] = await Promise.all([callConvert(user.id, AZM), callConvert(user.id, AZM)]);
        disarmBarrier();

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([200, 400]);

        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(0);
        expect(dec(after.azmBalance)).toBeGreaterThanOrEqual(0); // never overdrawn

        // Exactly one USDC credit.
        const conversions = await base.azmConversionLog.findMany({ where: { userId: user.id } });
        expect(conversions.length).toBe(1);
        expect(dec(after.availableBalance)).toBeCloseTo(dec(conversions[0].usdcAmount), 8);
    });

    // ── 2. Four-way race with headroom for exactly two ───────────────────────
    test('2 — four racing conversions, balance covers exactly two: exactly two commit, no overdraft', async () => {
        const AZM = 500;
        const user = await seedUser(2 * AZM); // covers exactly two conversions
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 1000 } });

        armBarrier('user-debit', 4);
        const results = await Promise.all([
            callConvert(user.id, AZM), callConvert(user.id, AZM),
            callConvert(user.id, AZM), callConvert(user.id, AZM),
        ]);
        disarmBarrier();

        const successes = results.filter((r) => r.statusCode === 200).length;
        const rejected = results.filter((r) => r.statusCode === 400).length;
        expect(successes).toBe(2);
        expect(rejected).toBe(2);

        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(0);
        expect(dec(after.azmBalance)).toBeGreaterThanOrEqual(0);
        const conversions = await base.azmConversionLog.findMany({ where: { userId: user.id } });
        expect(conversions.length).toBe(2);
    });

    // ── 3. Racing conversions cannot overdraw the platform pool ───────────────
    test('3 — pool covers exactly one conversion: racing requests produce one 200 and one 503, pool never negative', async () => {
        const AZM = 1000; // 2 x AZM stays under the 5000 daily quota
        const user = await seedUser(2 * AZM); // user-side is affordable; the pool is the constrained resource
        createdUserIds.push(user.id);

        // The rate is pool-dependent (healthFactor), so pin the pool FIRST and
        // derive expectations at that pinned rate. A small pool (< $10k) pins
        // healthFactor to its 0.5 floor: rate 0.0005 => oneUsdc = 0.5.
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 0.75 } });
        const rateInfo = await controller.getConversionRate(user.id);
        const oneUsdc = AZM * rateInfo.rate; // 0.5 at the pinned pool
        expect(oneUsdc).toBeLessThanOrEqual(0.75); // pool covers one conversion
        expect(2 * oneUsdc).toBeGreaterThan(0.75); // ...but not two

        // The user-debit write is the sync point for the OLD implementation:
        // once BOTH requests have issued it, both pool pre-checks have already
        // read the full pool. The fixed implementation serializes on the
        // conditional pool debit instead.
        armBarrier('user-debit', 2);
        const [a, b] = await Promise.all([callConvert(user.id, AZM), callConvert(user.id, AZM)]);
        disarmBarrier();

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([200, 503]);

        const pool = await base.systemProfitFees.findUnique({ where: { id: 1 } });
        expect(dec(pool.balance)).toBeGreaterThanOrEqual(0); // never overdrawn
        expect(dec(pool.balance)).toBeCloseTo(0.25, 6); // 0.75 - oneUsdc

        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(AZM); // exactly one burn
        expect(dec(after.availableBalance)).toBeCloseTo(oneUsdc, 6); // exactly one credit
        const loser = b.statusCode === 503 ? b : a;
        expect(loser.body.message).toBe('Conversion pool temporarily insufficient. Please try again later.');
        expect(loser.body).toHaveProperty('poolAvailable');
    });

    // ── 4. Ledger evidence matches committed reality under race ─────────────
    test('4 — every committed conversion has exactly-once, non-negative ledger evidence with a stable dedup key', async () => {
        const AZM = 2400; // 2 x AZM = 4800 stays under the 5000 daily quota
        const user = await seedUser(2 * AZM); // both conversions legitimately affordable
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 10000 } });

        armBarrier('user-debit', 2);
        await Promise.all([callConvert(user.id, AZM), callConvert(user.id, AZM)]);
        disarmBarrier();

        const after = await base.user.findUnique({ where: { id: user.id } });
        const conversions = await base.azmConversionLog.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
        const spendLogs = await base.azmSpendLog.findMany({ where: { userId: user.id } });

        // Both conversions committed legitimately — ledger row per conversion,
        // no phantom or missing evidence.
        expect(spendLogs.length).toBe(conversions.length);
        expect(conversions.length).toBe(2);

        for (const log of spendLogs) {
            // Evidence recorded from real committed state — never a stale
            // arithmetic guess, never negative.
            expect(dec(log.balanceAfter)).toBeGreaterThanOrEqual(0);
            expect(log.dedupKey).toMatch(/^azm_conversion_\d+$/);
        }

        // The conversion log's final balances must match the user's ACTUAL
        // committed end state (no stale-read evidence drift).
        const last = conversions[conversions.length - 1];
        expect(dec(last.newAzmBalance)).toBeCloseTo(dec(after.azmBalance), 6);
        expect(dec(last.newUsdcBalance)).toBeCloseTo(dec(after.availableBalance), 6);
    });

    // ── 5. Fail-closed: rejected conversions persist nothing ─────────────────
    test('5 — insufficient AZM: 400 with the existing contract and zero persisted evidence', async () => {
        const user = await seedUser(10);
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 10000 } });

        const r = await callConvert(user.id, 100); // 10 AZM available
        expect(r.statusCode).toBe(400);
        expect(r.body.message).toBe('Insufficient AZM balance.');

        expect(await base.azmSpendLog.count({ where: { userId: user.id } })).toBe(0);
        expect(await base.azmConversionLog.count({ where: { userId: user.id } })).toBe(0);
        expect(await base.transactionHistory.count({ where: { userId: user.id } })).toBe(0);
        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(10);
        expect(dec(after.availableBalance)).toBe(0);
    });

    // ── 6. Conservation end-to-end (single-threaded correctness) ────────────
    test('6 — successful conversion conserves value across user, pool and ledger exactly', async () => {
        const AZM = 1000;
        const user = await seedUser(AZM, 50);
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 10000 } });
        const poolBefore = dec((await base.systemProfitFees.findUnique({ where: { id: 1 } })).balance);
        const rateInfo = await controller.getConversionRate(user.id);
        const expectedUsdc = AZM * rateInfo.rate;

        const r = await callConvert(user.id, AZM);
        expect(r.statusCode).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.conversion.azmAmount).toBe(AZM);

        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(0); // AZM burned
        expect(dec(after.availableBalance)).toBeCloseTo(50 + expectedUsdc, 6); // USDC credited

        const poolAfter = dec((await base.systemProfitFees.findUnique({ where: { id: 1 } })).balance);
        expect(poolAfter).toBeCloseTo(poolBefore - expectedUsdc, 6); // pool drained by exactly the credit

        // Ledger triple present and mutually consistent.
        const spendLogs = await base.azmSpendLog.findMany({ where: { userId: user.id } });
        const conversions = await base.azmConversionLog.findMany({ where: { userId: user.id } });
        const histories = await base.transactionHistory.findMany({ where: { userId: user.id, type: 'AZM_CONVERSION_TO_USDC' } });
        expect(spendLogs.length).toBe(1);
        expect(conversions.length).toBe(1);
        expect(histories.length).toBe(1);
        expect(spendLogs[0].dedupKey).toBe(`azm_conversion_${conversions[0].id}`);
        expect(dec(spendLogs[0].balanceAfter)).toBeCloseTo(0, 6);
        expect(dec(conversions[0].newUsdcBalance)).toBeCloseTo(50 + expectedUsdc, 6);
        expect(histories[0].metadata.conversionId).toBe(conversions[0].id);
    });

    // ── 7. Idempotency-Key replay (existing architecture parity) ─────────────
    test('7 — duplicate submission with an Idempotency-Key replays the cached response and converts once', async () => {
        const { idempotency } = require('../middleware/idempotency');
        const AZM = 250;
        const user = await seedUser(AZM);
        createdUserIds.push(user.id);
        await base.systemProfitFees.update({ where: { id: 1 }, data: { balance: 10000 } });

        const key = `conv-test-${uniq()}`;
        const run = () => new Promise((resolve) => {
            const out = { statusCode: null, body: null };
            const res = {
                statusCode: 200, // the middleware caches on res.statusCode
                status(c) { this.statusCode = c; return { json: (b) => this.json(b) }; },
                json(b) { out.statusCode = this.statusCode; out.body = b; resolve(out); },
            };
            const req = {
                user: { id: user.id },
                body: { azmAmount: AZM },
                headers: { 'idempotency-key': key },
                method: 'POST',
                originalUrl: '/api/azm-convert',
                app: { get: (k) => (k === 'prisma' ? base : null) },
            };
            idempotency()(req, res, async () => {
                await controller.convertAzmToUsdc(req, res);
                resolve(out);
            });
        });

        const first = await run();
        await sleep(300); // let the fire-and-forget cache write land
        const second = await run();

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual(first.body); // cached replay

        expect(await base.azmConversionLog.count({ where: { userId: user.id } })).toBe(1);
        const after = await base.user.findUnique({ where: { id: user.id } });
        expect(dec(after.azmBalance)).toBe(0); // converted exactly once
    });
});
