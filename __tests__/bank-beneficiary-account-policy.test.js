// __tests__/bank-beneficiary-account-policy.test.js
// =============================================================================
// Issue #389 P1-3: saved bank accounts obey a payee POLICY, and "primary" is a
// fact the database enforces.
//
// The service demoted the previous primary and then wrote the new one. Correct
// one request at a time, wrong two at a time: both callers demote nobody, both
// insert, and the customer has two primary payees. The revival path did not
// demote at all, so re-saving a deleted account as primary duplicated it every
// time, single-threaded.
//
// PROVES:
//   1. Reviving a deleted account as primary demotes the current primary.
//   2. Two concurrent saves of the SAME account: one wins, the other is told it
//      is already saved (never a raw P2002 / 500).
//   3. Two concurrent saves of DIFFERENT accounts, both primary: exactly one
//      primary remains.
//   4. The database itself refuses a second primary, whoever writes it.
//   5. The payee list is capped, and the cap is checked inside the write.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[bank-beneficiary-account-policy] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
}

(hasDb ? describe : describe.skip)('saved bank beneficiary account policy (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    let prisma;
    let seedUser;
    let svc;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        svc = require('../src/services/savedBankBeneficiaryService');
        // The invariant under test lives in a raw-SQL migration (Prisma cannot
        // express a partial index), so apply the same DDL the migration runs.
        await prisma.$executeRawUnsafe(`
            CREATE UNIQUE INDEX IF NOT EXISTS "SavedBankBeneficiary_one_primary_per_user"
            ON "SavedBankBeneficiary" ("userId")
            WHERE "isPrimary" = true AND "status" = 'ACTIVE'
        `);
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    let acct = 7000000000000;
    const nextAccount = () => String(acct++);
    const save = (userId, accountNumber, extra = {}) => svc.createBeneficiary(prisma, userId, {
        bankCode: 'GCB', bankName: 'GCB Bank', accountNumber, accountName: 'Ama Mensah', ...extra,
    });
    const primaries = (userId) => prisma.savedBankBeneficiary.findMany({
        where: { userId, isPrimary: true, status: 'ACTIVE' }, select: { id: true },
    });

    test('1: reviving a deleted account as primary demotes the current primary', async () => {
        const user = await seedUser(prisma);
        const numberA = nextAccount();
        const first = await save(user.id, numberA, { isPrimary: true });
        await svc.deleteBeneficiary(prisma, user.id, first.id);
        const second = await save(user.id, nextAccount(), { isPrimary: true });
        expect((await primaries(user.id)).map((r) => r.id)).toEqual([second.id]);

        // Re-save the deleted account as primary: the current primary steps down.
        const revived = await svc.createBeneficiary(prisma, user.id, {
            bankCode: 'GCB', bankName: 'GCB Bank', accountNumber: numberA, accountName: 'Ama Mensah', isPrimary: true,
        });
        const live = await primaries(user.id);
        expect(live.length).toBe(1);
        expect(live[0].id).toBe(revived.id);
        expect(revived.id).toBe(first.id); // revived, not a second row
        expect(await prisma.savedBankBeneficiary.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(2);
    });

    test('2: two concurrent saves of the same account yield one payee and one refusal', async () => {
        const user = await seedUser(prisma);
        const number = nextAccount();
        const results = await Promise.allSettled([save(user.id, number), save(user.id, number)]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toBeInstanceOf(svc.BankBeneficiaryError);
        expect(rejected[0].reason.code).toBe('BENEFICIARY_DUPLICATE');
        expect(await prisma.savedBankBeneficiary.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(1);
    });

    test('3: two concurrent primary saves leave exactly one primary', async () => {
        const user = await seedUser(prisma);
        const [a, b] = [nextAccount(), nextAccount()];
        const results = await Promise.allSettled([save(user.id, a, { isPrimary: true }), save(user.id, b, { isPrimary: true })]);
        // Both instructions are legitimate, so neither may fail outright.
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const live = await primaries(user.id);
        expect(live.length).toBe(1);
        const activeRows = await prisma.savedBankBeneficiary.count({ where: { userId: user.id, status: 'ACTIVE' } });
        expect(activeRows).toBe(2);
    });

    test('4: the database refuses a second primary, whoever writes it', async () => {
        const user = await seedUser(prisma);
        const first = await save(user.id, nextAccount(), { isPrimary: true });
        const second = await save(user.id, nextAccount());
        await expect(
            prisma.savedBankBeneficiary.update({ where: { id: second.id }, data: { isPrimary: true } })
        ).rejects.toMatchObject({ code: 'P2002' });
        expect((await primaries(user.id)).map((r) => r.id)).toEqual([first.id]);
    });

    test('5: the payee list is capped inside the write', async () => {
        const user = await seedUser(prisma);
        for (let i = 0; i < svc.MAX_ACTIVE_BENEFICIARIES; i += 1) {
            await save(user.id, nextAccount());
        }
        await expect(save(user.id, nextAccount())).rejects.toMatchObject({ code: 'BENEFICIARY_LIMIT_REACHED' });
        expect(await prisma.savedBankBeneficiary.count({ where: { userId: user.id, status: 'ACTIVE' } }))
            .toBe(svc.MAX_ACTIVE_BENEFICIARIES);

        // Deleting one makes room again: the cap is on the active list.
        const [one] = await prisma.savedBankBeneficiary.findMany({ where: { userId: user.id, status: 'ACTIVE' }, take: 1 });
        await svc.deleteBeneficiary(prisma, user.id, one.id);
        const added = await save(user.id, nextAccount());
        expect(added.id).toBeTruthy();
    });
});
