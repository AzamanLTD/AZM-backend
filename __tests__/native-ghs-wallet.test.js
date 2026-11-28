// __tests__/native-ghs-wallet.test.js
// =============================================================================
// FX-balance workstream — native-GHS wallet proof (real PostgreSQL, Prisma
// never mocked).
//
// PROVES:
//
//   A. creditNativeGhs posts a BALANCED double entry (fiat:momo:ghs custody
//      asset debited, ghs:user:{id}:liability credited) with the GHS asset
//      identity — and bumps the User.nativeGhsBalance projection inside the
//      SAME transaction.
//   B. debitNativeGhs is CAS-guarded: a debit larger than the projection is
//      refused with GHS_INSUFFICIENT_BALANCE, leaves the projection
//      untouched, and posts NO ledger entry (no residue).
//   C. Overdraft refusal under genuine concurrency: two parallel debits of
//      the full balance — exactly one wins, the loser is refused, and the
//      final projection is never negative.
//   D. Idempotency: replaying the same idempotencyKey is refused by the
//      ledger (LEDGER_IDEMPOTENCY_CONFLICT) and does NOT double-credit.
//   E. Exact decimals: sub-pesewa GHS amounts are exact through the whole
//      path; the projection equals the ledger liability to the last digit
//      (reconciliation residual EXACTLY zero), and JS float noise is never
//      an input to authoritative economics.
//   F. The GHS wallet account is a SEPARATE identity from the USDC wallet:
//      crediting the GHS wallet never touches user:{id}:liability (USDC) or
//      User.availableBalance.
//   G. The database CHECK floor: a negative nativeGhsBalance cannot be
//      written directly at the database level (the overlay's backstop).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-wallet.test] TEST_DATABASE_URL not set — skipping.');

describe('Native-GHS wallet service (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let wallet;
    let ledger;
    let { seedUser } = {};

    const _ledgerCleanSlate = async () => {
        // LedgerTransaction has NO User FK, so a User-cascade truncate does
        // NOT remove it — and RESTART IDENTITY re-issues the same user ids,
        // which would make a later run's idempotency keys replay this run's
        // economic history. Explicit ledger cleanup is the established
        // convention (see ewa-withdrawal-intent-reconciliation.db.test.js).
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
        );
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        wallet = require('../src/services/nativeGhsWalletService');
        ledger = require('../services/ledgerService');
        ({ seedUser } = require('./helpers/factories'));
        await _ledgerCleanSlate();
    });

    afterAll(async () => {
        if (prisma) {
            await _ledgerCleanSlate();
            await prisma.$disconnect();
        }
    });

    afterEach(async () => {
        // Drain the 150ms event-loop window (r-established deadlock lesson)
        await new Promise((r) => setTimeout(r, 200));
    });

    const RUN = Date.now();
    const credit = (tx, userId, amountGhs, key, extra = {}) =>
        wallet.creditNativeGhs({ tx, userId, amountGhs, idempotencyKey: `${RUN}:${key}`, ...extra });
    const debit = (tx, userId, amountGhs, key, extra = {}) =>
        wallet.debitNativeGhs({ tx, userId, amountGhs, idempotencyKey: `${RUN}:${key}`, ...extra });

    test('credit posts a balanced custody-vs-liability double entry and bumps the projection atomically', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        const amount = '100.50';

        const result = await prisma.$transaction(async (tx) =>
            credit(tx, user.id, amount, `ghs-credit-basic-${user.id}`));

        // Projection
        expect(result.nativeGhsBalanceExact.toFixed(2)).toBe('100.50');
        // Ledger: custody asset debited, GHS liability credited
        const liability = await ledger.accountBalance(prisma, `ghs:user:${user.id}:liability`);
        expect(liability.normalSide).toBe('CREDIT');
        expect(new String(liability.balance).valueOf()).toBe('100.5');
        const custody = await ledger.accountBalance(prisma, wallet.GHS_CUSTODY_ACCOUNT);
        expect(custody.normalSide).toBe('DEBIT');
        expect(new String(custody.balance).valueOf()).toBe('100.5');
        // Reconciliation residual is EXACTLY zero
        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
        expect(recon.residualExact.toFixed(8)).toBe('0.00000000');
    });

    test('the GHS wallet never touches the USDC wallet identity', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 250 });
        await prisma.$transaction(async (tx) =>
            credit(tx, user.id, '75', `ghs-separate-${user.id}`));

        const usdcLiability = await ledger.accountBalance(prisma, `user:${user.id}:liability`);
        expect(new String(usdcLiability.balance).valueOf()).toBe('0'); // untouched
        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true, nativeGhsBalance: true } });
        expect(Number(fresh.availableBalance)).toBe(250);   // untouched
        expect(Number(fresh.nativeGhsBalance)).toBe(75);    // credited
    });

    test('debit is CAS-guarded: overdraft is refused with no projection change and NO ledger residue', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        await prisma.$transaction(async (tx) =>
            credit(tx, user.id, '50', `ghs-overdraft-pre-${user.id}`));

        await expect(
            prisma.$transaction(async (tx) =>
                debit(tx, user.id, '50.01', `ghs-overdraft-${user.id}`))
        ).rejects.toMatchObject({ code: 'GHS_INSUFFICIENT_BALANCE' });

        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(fresh.nativeGhsBalance)).toBe(50);
        // No WITHDRAWAL ledger transaction was created by the refused debit
        const withdrawals = await prisma.journalEntry.findMany({
            where: { account: `ghs:user:${user.id}:liability`, entryType: 'WITHDRAWAL' },
        });
        expect(withdrawals).toHaveLength(0);
        // And the whole transaction rolled back: projection still reconciles
        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    test('concurrent full-balance debits: exactly one wins, the projection never goes negative', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        await prisma.$transaction(async (tx) =>
            credit(tx, user.id, '80', `ghs-concurrent-pre-${user.id}`));

        const results = await Promise.allSettled([
            prisma.$transaction(async (tx) => debit(tx, user.id, '80', `ghs-concurrent-a-${user.id}`)),
            prisma.$transaction(async (tx) => debit(tx, user.id, '80', `ghs-concurrent-b-${user.id}`)),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('GHS_INSUFFICIENT_BALANCE');

        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(fresh.nativeGhsBalance)).toBe(0);
        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    test('idempotency: exact replay converges (no double-credit); a CONFLICTING reuse of the key is refused', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        const key = `ghs-idem-${user.id}`;
        const first = await prisma.$transaction(async (tx) => credit(tx, user.id, '10', key));
        expect(first.replayed).toBe(false);

        // Exact replay: converges — the ledger returns the committed
        // posting and the projection is NOT re-incremented.
        const replay = await prisma.$transaction(async (tx) => credit(tx, user.id, '10', key));
        expect(replay.replayed).toBe(true);
        const fresh1 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(fresh1.nativeGhsBalance)).toBe(10); // still 10, not 20

        // A DIFFERENT posting under the same key is economic-history
        // tampering: refused, no state change.
        await expect(
            prisma.$transaction(async (tx) => credit(tx, user.id, '25', key))
        ).rejects.toMatchObject({ name: 'LedgerError' });
        const fresh2 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(fresh2.nativeGhsBalance)).toBe(10);

        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    test('debit replay converges too: the projection is not re-debited', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        await prisma.$transaction(async (tx) => credit(tx, user.id, '40', `ghs-dr-pre-${user.id}`));
        const key = `ghs-dr-${user.id}`;
        const first = await prisma.$transaction(async (tx) => debit(tx, user.id, '15', key));
        expect(first.replayed).toBe(false);

        const replay = await prisma.$transaction(async (tx) => debit(tx, user.id, '15', key));
        expect(replay.replayed).toBe(true);
        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(fresh.nativeGhsBalance)).toBe(25); // 40 - 15, NOT 40 - 30
        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    test('exact sub-pesewa decimals survive the whole path', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        const amount = '0.00012345';
        const result = await prisma.$transaction(async (tx) =>
            credit(tx, user.id, amount, `ghs-exact-${user.id}`));

        expect(result.amountGhsExact.toFixed(8)).toBe('0.00012345');
        const recon = await wallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
        expect(recon.projectionExact.toFixed(8)).toBe('0.00012345');
    });

    test('the service refuses non-positive/malformed amounts (no float economy)', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        for (const bad of ['0', '-5', 'abc', 'NaN', 'Infinity']) {
            await expect(
                prisma.$transaction(async (tx) => credit(tx, user.id, bad, `ghs-bad-${user.id}-${bad}`))
            ).rejects.toMatchObject({ code: 'GHS_INVALID_AMOUNT' });
        }
        // tx required — the caller-owned transaction is not optional
        await expect(
            wallet.creditNativeGhs({ userId: user.id, amountGhs: '1', idempotencyKey: 'no-tx' })
        ).rejects.toMatchObject({ code: 'GHS_TX_REQUIRED' });
    });

    test('database CHECK floor: a negative nativeGhsBalance cannot be written directly', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "User" SET "nativeGhsBalance" = -1 WHERE "id" = ${user.id}`)
        ).rejects.toThrow();
    });
});
