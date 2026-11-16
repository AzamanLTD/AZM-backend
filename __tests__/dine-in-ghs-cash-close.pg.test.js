/**
 * Dine-in cash close, native GHS, on real PostgreSQL.
 *
 * THE DEFECT THIS CLOSES: a Ghana till closed a tab in cedis and the code wrote
 * those cedis into `DineInTab.grandTotalUsdc` and into `BusinessLedgerEntry.amount`
 * — the USDC income column — with no currency anywhere. A 100 GHS sale was
 * therefore reported as 100 USDC of merchant income, and the cedi figure was
 * duplicated into `amountGhs` where that column means "GHS equivalent of a USDC
 * amount" rather than "cedis received".
 *
 * Now a GHS close carries its money in the cedi columns at exact 2dp, writes NO
 * USDC amount at all, and the database refuses the mislabelled shape outright.
 */
const { PrismaClient, Prisma } = require('@prisma/client');
const { DineInCashCloseService } = require('../services/businessOS/dineInCashCloseService');

const url = process.env.TEST_DATABASE_URL;
if (!url) console.warn('[dine-in-ghs-cash-close] TEST_DATABASE_URL not set — skipping.');
const run = url ? describe : describe.skip;

run('dine-in cash close in native GHS (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });

    async function cleanup() {
        const profiles = await db.businessProfile.findMany({
            where: { businessName: { startsWith: 'DineInGhs Cash Test' } }, select: { id: true },
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
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'DineInGhs Cash Test' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'dineinghs-user' } } });
    }

    beforeEach(cleanup);
    afterAll(cleanup);

    async function seed({ withTaxPreset = false } = {}) {
        seq += 1;
        const owner = await db.user.create({
            data: { username: `dineinghs-user-o${seq}-${Date.now()}`, email: `dineinghs-o${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const customer = await db.user.create({
            data: { username: `dineinghs-user-c${seq}-${Date.now()}`, email: `dineinghs-c${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `DineInGhs Cash Test ${seq}`,
                bizId: `BIZ-DGC-${seq}-${String(Date.now()).slice(-6)}`,
                category: 'FOOD_BEVERAGE',
            },
        });
        if (withTaxPreset) {
            await db.businessTaxPreset.create({
                data: { businessProfileId: profile.id, name: 'VAT', type: 'PERCENTAGE', value: new Prisma.Decimal('15.0'), isDefault: true },
            });
        }
        return { owner, customer, profile };
    }

    // A cedi-priced tab. The legacy *Usdc columns are NOT NULL, so they carry
    // zero: the money itself is in the cedi columns.
    async function seedGhsTab(profile, customer, lines) {
        const tab = await db.dineInTab.create({
            data: {
                businessProfileId: profile.id,
                customerId: customer.id,
                status: 'OPEN',
                currency: 'GHS',
            },
        });
        for (const line of lines) {
            await db.dineInTabItem.create({
                data: {
                    dineInTabId: tab.id,
                    name: line.name,
                    quantity: line.quantity,
                    unitPriceGhs: new Prisma.Decimal(line.unitPriceGhs),
                    lineTotalGhs: new Prisma.Decimal(line.unitPriceGhs).times(line.quantity),
                    unitPriceUsdc: new Prisma.Decimal(0),
                    lineTotalUsdc: new Prisma.Decimal(0),
                    addedBy: customer.id,
                },
            });
        }
        return tab;
    }

    const svc = () => new DineInCashCloseService(db);

    test('a cedi tab closes with exact pesewa totals and NO USDC amount written', async () => {
        const { owner, customer, profile } = await seed();
        // 3 x 0.10 is the classic float trap: 0.30000000000000004.
        const tab = await seedGhsTab(profile, customer, [
            { name: 'Kelewele', quantity: 3, unitPriceGhs: '0.10' },
            { name: 'Waakye', quantity: 1, unitPriceGhs: '12.35' },
        ]);

        const result = await svc().closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS',
            cashReceived: '20.00', tipAmount: '1.00',
        });

        expect(result.currency).toBe('GHS');
        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "grandTotalGhs"::text AS ghs_total, "subtotalGhs"::text AS sub_total,
                    "tipGhs"::text AS tip_total,
                    "grandTotalUsdc"::text AS usdc_total, "subtotalUsdc"::text AS usdc_sub
             FROM "DineInTab" WHERE id = $1`, tab.id);
        expect(row.currency).toBe('GHS');
        expect(row.sub_total).toBe('12.65');   // 0.30 + 12.35, exact
        expect(row.tip_total).toBe('1.00');
        expect(row.ghs_total).toBe('13.65');   // no tax preset: 12.65 + 1.00
        // The USDC-named columns never receive cedi money.
        expect(row.usdc_sub).toBe('0.00000000');
        expect(row.usdc_total).toBe('0.00000000');
    });

    test('the merchant ledger records cedis as cedis: cedi column set, USDC amount NULL', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer, [{ name: 'Jollof', quantity: 2, unitPriceGhs: '25.50' }]);

        await svc().closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS', cashReceived: '60.00',
        });

        const [entry] = await db.$queryRawUnsafe(
            `SELECT "currency", "amount"::text AS amount, "amountGhs"::text AS ghs
             FROM "BusinessLedgerEntry" WHERE "businessProfileId" = $1 AND "sourceType" = 'DINE_IN_CASH'`,
            profile.id);
        expect(entry.currency).toBe('GHS');
        // A 51.00 GHS sale must not appear as 51.00 USDC of income.
        expect(entry.amount).toBeNull();
        // amountGhs keeps its legacy DECIMAL(20,8) scale as a valuation column, but
        // the VALUE is exactly 51 cedis — no rounding, no fractional residue.
        expect(new Prisma.Decimal(entry.ghs).equals(51)).toBe(true);
    });

    test('tax is computed and stored in cedis to the pesewa', async () => {
        const { owner, customer, profile } = await seed({ withTaxPreset: true });
        const tab = await seedGhsTab(profile, customer, [{ name: 'Banku', quantity: 1, unitPriceGhs: '10.00' }]);

        await svc().closeTab({ businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS' });

        const [row] = await db.$queryRawUnsafe(
            `SELECT "taxTotalGhs"::text AS tax, "grandTotalGhs"::text AS total FROM "DineInTab" WHERE id = $1`, tab.id);
        expect(row.tax).toBe('1.50');    // 15% of 10.00
        expect(row.total).toBe('11.50');
    });

    test('the legacy USDC close still works and stays untagged', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await db.dineInTab.create({
            data: { businessProfileId: profile.id, customerId: customer.id, status: 'OPEN' },
        });
        await db.dineInTabItem.create({
            data: {
                dineInTabId: tab.id, name: 'Legacy', quantity: 2,
                unitPriceUsdc: new Prisma.Decimal('1.50'), lineTotalUsdc: new Prisma.Decimal('3.00'), addedBy: customer.id,
            },
        });

        const result = await svc().closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, cashReceived: '5.00',
        });

        expect(result.currency).toBeNull();
        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "grandTotalUsdc"::text AS usdc, "grandTotalGhs" FROM "DineInTab" WHERE id = $1`, tab.id);
        expect(row.currency).toBeNull();
        expect(row.usdc).toBe('3.00000000');
        expect(row.grandTotalGhs).toBeNull();
    });

    test('an unknown currency is refused before any money is written', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer, [{ name: 'X', quantity: 1, unitPriceGhs: '1.00' }]);

        await expect(svc().closeTab({
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'EUR',
        })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

        const [row] = await db.$queryRawUnsafe(`SELECT status FROM "DineInTab" WHERE id = $1`, tab.id);
        expect(row.status).toBe('OPEN');
    });

    test('the database itself refuses a cedi figure in the USDC column', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer, [{ name: 'Y', quantity: 1, unitPriceGhs: '1.00' }]);

        // A ledger row tagged GHS that still carries a USDC amount is the exact
        // mislabel this contract removes.
        await expect(db.businessLedgerEntry.create({
            data: {
                businessProfileId: profile.id, type: 'INCOME', category: 'DINE_IN',
                description: 'mislabelled', currency: 'GHS',
                amount: new Prisma.Decimal('10.00'), amountGhs: new Prisma.Decimal('10.00'),
                sourceType: 'DINE_IN_CASH', sourceId: tab.id,
            },
        })).rejects.toThrow(/ck_businessledgerentry_currency_shape/);

        // And an untagged tab carrying a cedi total is unreadable, so it is refused.
        await expect(db.dineInTab.create({
            data: {
                businessProfileId: profile.id, customerId: customer.id, status: 'OPEN',
                grandTotalGhs: new Prisma.Decimal('9.99'),
            },
        })).rejects.toThrow(/ck_dineintab_currency_shape/);
    });

    test('a repeat close with the same key replays instead of double-recording income', async () => {
        const { owner, customer, profile } = await seed();
        const tab = await seedGhsTab(profile, customer, [{ name: 'Z', quantity: 1, unitPriceGhs: '7.00' }]);

        const args = {
            businessProfileId: profile.id, actorId: owner.id, tabId: tab.id, currency: 'GHS',
            cashReceived: '10.00', idempotencyKey: 'ghs-close-1',
        };
        await svc().closeTab(args);
        const replay = await svc().closeTab(args);

        expect(replay.duplicate).toBe(true);
        const entries = await db.businessLedgerEntry.count({
            where: { businessProfileId: profile.id, sourceType: 'DINE_IN_CASH' },
        });
        // One income record, not two.
        expect(entries).toBe(1);
    });
});
