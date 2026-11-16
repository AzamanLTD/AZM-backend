/**
 * Native-GHS money boundaries: concurrency, merchant cash and cross-reads.
 *
 * Three claims the Agent 3 brief asks for at once:
 *
 *  1. A tab cannot be closed twice concurrently, so income is recorded once.
 *  2. Cash handed to the merchant is MERCHANT settlement: it must not create a
 *     platform-held liability, an escrow, a customer wallet movement or a
 *     platform float entry. The only record is the merchant's own ledger.
 *  3. Cedis and dollars are never added together. A cedi cash sale contributes
 *     nothing to a USDC report — and must not crash one either, which it did
 *     once the ledger's USDC amount became nullable for cedi rows.
 */
const { PrismaClient, Prisma } = require('@prisma/client');
const { DineInCashCloseService } = require('../services/businessOS/dineInCashCloseService');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');

const url = process.env.TEST_DATABASE_URL;
if (!url) console.warn('[ghs-boundaries] TEST_DATABASE_URL not set — skipping.');
const run = url ? describe : describe.skip;

run('native-GHS money boundaries (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });

    async function cleanup() {
        const profiles = await db.businessProfile.findMany({
            where: { businessName: { startsWith: 'GhsBoundary Test' } }, select: { id: true },
        });
        const ids = profiles.map((p) => p.id);
        if (ids.length) {
            const tabs = await db.dineInTab.findMany({ where: { businessProfileId: { in: ids } }, select: { id: true } });
            const tabIds = tabs.map((t) => t.id);
            if (tabIds.length) {
                await db.dineInTabItem.deleteMany({ where: { dineInTabId: { in: tabIds } } });
                await db.dineInTab.deleteMany({ where: { id: { in: tabIds } } });
            }
            await db.businessLedgerEntry.deleteMany({ where: { businessProfileId: { in: ids } } });
            await db.businessTaxPreset.deleteMany({ where: { businessProfileId: { in: ids } } });
        }
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsBoundary Test' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsboundary-user' } } });
    }

    beforeEach(cleanup);
    afterAll(cleanup);

    async function seed() {
        seq += 1;
        const owner = await db.user.create({
            data: { username: `ghsboundary-user-o${seq}-${Date.now()}`, email: `ghsboundary-o${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const customer = await db.user.create({
            data: { username: `ghsboundary-user-c${seq}-${Date.now()}`, email: `ghsboundary-c${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id, businessName: `GhsBoundary Test ${seq}`,
                bizId: `BIZ-GB-${seq}-${String(Date.now()).slice(-6)}`, category: 'FOOD_BEVERAGE',
            },
        });
        return { owner, customer, profile };
    }

    async function seedGhsTab(profile, customer, unitPriceGhs = '25.50', quantity = 2) {
        const tab = await db.dineInTab.create({
            data: { businessProfileId: profile.id, customerId: customer.id, status: 'OPEN', currency: 'GHS' },
        });
        await db.dineInTabItem.create({
            data: {
                dineInTabId: tab.id, name: 'Jollof', quantity,
                unitPriceGhs: new Prisma.Decimal(unitPriceGhs),
                lineTotalGhs: new Prisma.Decimal(unitPriceGhs).times(quantity),
                unitPriceUsdc: new Prisma.Decimal(0), lineTotalUsdc: new Prisma.Decimal(0),
                addedBy: customer.id,
            },
        });
        return tab;
    }

    test('two concurrent closes record the money exactly once', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer);
        const svc = new DineInCashCloseService(db);

        // Different idempotency keys: these are genuine contenders, not replays.
        const results = await Promise.allSettled([
            svc.closeTab({ businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS', cashReceived: '60.00', idempotencyKey: 'race-a' }),
            svc.closeTab({ businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS', cashReceived: '60.00', idempotencyKey: 'race-b' }),
        ]);

        const winners = results.filter((r) => r.status === 'fulfilled');
        expect(winners).toHaveLength(1);

        const [row] = await db.$queryRawUnsafe(
            `SELECT "status", "grandTotalGhs"::text AS total FROM "DineInTab" WHERE id = $1`, tab.id);
        expect(row.status).toBe('PAID');
        expect(row.total).toBe('51.00');

        // One income record, not two.
        const entries = await db.businessLedgerEntry.findMany({
            where: { businessProfileId: profile.id, sourceType: 'DINE_IN_CASH' },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].currency).toBe('GHS');
        expect(entries[0].amount).toBeNull();
        expect(new Prisma.Decimal(entries[0].amountGhs).equals(51)).toBe(true);
    });

    test('cash taken by the merchant creates no platform liability, escrow or wallet movement', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer);

        const [before] = await db.$queryRawUnsafe(
            `SELECT "availableBalance"::text AS usdc, "nativeGhsBalance"::text AS ghs FROM "User" WHERE id = $1`, customer.id);

        await new DineInCashCloseService(db).closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id,
            currency: 'GHS', cashReceived: '60.00',
        });

        // The customer's platform balances are untouched: they paid cash in hand.
        const [after] = await db.$queryRawUnsafe(
            `SELECT "availableBalance"::text AS usdc, "nativeGhsBalance"::text AS ghs FROM "User" WHERE id = $1`, customer.id);
        expect(after.usdc).toBe(before.usdc);
        expect(after.ghs).toBe(before.ghs);

        // No escrow, no platform wallet movement for this customer, no platform
        // float row. The merchant's own ledger is the ONLY record.
        const escrows = await db.smartEscrow.count({ where: { payerId: customer.id } });
        expect(escrows).toBe(0);
        const txns = await db.transactionHistory.count({ where: { userId: customer.id } });
        expect(txns).toBe(0);

        // And the single record that does exist is a MERCHANT income row.
        const entries = await db.businessLedgerEntry.findMany({
            where: { businessProfileId: profile.id, sourceType: 'DINE_IN_CASH' },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe('INCOME');
        expect(entries[0].currency).toBe('GHS');
    });

    test('a cedi sale never enters a USDC report, and does not crash it either', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer);
        await new DineInCashCloseService(db).closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id,
            currency: 'GHS', cashReceived: '60.00',
        });

        const ledger = new BusinessLedgerService(db);

        // The report used to throw here: `new Prisma.Decimal(null)` on a cedi row.
        const pl = await ledger.getProfitLoss(profile.id);
        expect(pl.totalIncome).toBe(0);      // 51.00 GHS is NOT 51 USDC
        expect(pl.netProfit).toBe(0);
        expect(pl.nativeGhs).toEqual({
            currency: 'GHS',
            totalIncome: '51.00',
            totalExpenses: '0.00',
            netProfit: '51.00',
        });

        const cashFlow = await ledger.getCashFlow(profile.id);
        expect(cashFlow.totalInflow).toBe(0);

        const breakdown = await ledger.getExpenseBreakdown(profile.id);
        // A cedi-only merchant has no USDC expenses to show, and the report says so
        // rather than inventing a zero-valued cedi expense line.
        expect(breakdown.totalExpenses).toBe(0);
        expect(breakdown.categories).toEqual([]);

        const dashboard = await ledger.getDashboardStats(profile.id);
        expect(dashboard).toBeTruthy();
    });

    test('with both currencies present each report sees only its own money', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer);
        await new DineInCashCloseService(db).closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id,
            currency: 'GHS', cashReceived: '60.00',
        });
        await db.businessLedgerEntry.create({
            data: {
                businessProfileId: profile.id, type: 'INCOME', category: 'DINE_IN',
                description: 'legacy USDC sale', amount: new Prisma.Decimal('7.25'),
                currency: 'USDC', sourceType: 'DINE_IN_CASH', sourceId: 'legacy-1',
            },
        });

        const pl = await new BusinessLedgerService(db).getProfitLoss(profile.id);

        // Partitioned, never summed: 51.00 GHS and 7.25 USDC stay apart.
        expect(pl.totalIncome).toBe(7.25);
        expect(pl.nativeGhs.totalIncome).toBe('51.00');
        expect(pl.nativeGhs.netProfit).toBe('51.00');
    });
});
