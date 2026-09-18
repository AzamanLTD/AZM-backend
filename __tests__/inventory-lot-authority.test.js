// §P.5-B inventory lot authority — real PostgreSQL proofs. InventoryLot is the
// ONLY inventory authority (CorporatePurchaseLog stays an untouched audit log);
// exact quantities, atomic-claim concurrency, durable idempotency, no
// quote-only P&L, P4/P5-A ledger surface unchanged.
const describeOrSkip = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const { Prisma, PrismaClient } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const inventory = require('../services/inventoryService');
const { seedUser } = require('./helpers/factories');

describeOrSkip('§P.5-B inventory lot authority (real PostgreSQL)', () => {
    let prisma;
    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "InventoryLotConsumption", "InventoryLot", "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
    );
    beforeEach(async () => { await TRUNCATE_ALL(); }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    const acquire = (tx, o) => inventory.acquireLot(tx, {
        acquisitionKey: o.key ?? 'lot:test:1',
        sourceType: o.sourceType ?? 'CORPORATE_PURCHASE',
        sourceReference: o.sourceReference ?? 'purchase-log:42',
        quantity: o.quantity ?? '500',
        costBasisGhs: o.cost ?? '6000',
        acquisitionRate: o.rate === undefined ? '12' : o.rate,
    });
    const acquireTx = (o = {}) => prisma.$transaction((tx) => acquire(tx, o));
    const consume = (tx, o) => inventory.consumeLot(tx, {
        consumptionKey: o.key, lotId: o.lotId, quantity: o.quantity,
        purpose: o.purpose ?? 'ROUTE_SETTLEMENT_PLACEHOLDER', sourceReference: o.sourceReference ?? null,
    });
    const bal = (account) => ledger.accountBalance(prisma, account).then((b) => b.balance);

    describe('A. acquisition authority', () => {
        it('creates an immutable lot with exact quantity/cost and posts inventory:usdc:lots', async () => {
            const { lot, replayed } = await acquireTx({ key: 'lot:a:1', quantity: '500.12345678', cost: '6001.5' });
            expect(replayed).toBe(false);
            expect(lot.quantityOriginal).toBeInstanceOf(Prisma.Decimal);
            expect(lot.quantityOriginal.toFixed(8)).toBe('500.12345678');
            expect(lot.quantityRemaining.toFixed(8)).toBe('500.12345678');
            expect(lot.costBasisGhs.toFixed(8)).toBe('6001.50000000');
            expect(lot.acquisitionRate.toFixed(8)).toBe('12.00000000');
            expect(lot.status).toBe('OPEN');
            // authoritative ledger posting through ledgerService.post()
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe('500.12345678');
            expect((await bal('equity:treasury')).toFixed(8)).toBe('500.12345678'); // credit side
            const t = await prisma.ledgerTransaction.findUnique({ where: { id: lot.ledgerTxnId } });
            expect(t.entryType).toBe('INVENTORY_ACQUISITION');
            expect(await prisma.journalEntry.count({ where: { account: 'inventory:usdc:lots', debit: { gt: 0 } } })).toBe(1);
        });
        it('duplicate acquisition replay returns the committed lot without recreating or double-posting', async () => {
            const first = await acquireTx({ key: 'lot:a:2', quantity: '100', cost: '1200' });
            const second = await acquireTx({ key: 'lot:a:2', quantity: '100', cost: '1200' });
            expect(second.replayed).toBe(true);
            expect(second.lot.id).toBe(first.lot.id);
            expect(await prisma.inventoryLot.count()).toBe(1);
            expect(await prisma.ledgerTransaction.count()).toBe(1);
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe('100.00000000');
        });
        it('conflicting reuse of an acquisition identity fails closed', async () => {
            await acquireTx({ key: 'lot:a:3', quantity: '100', cost: '1200' });
            await expect(acquireTx({ key: 'lot:a:3', quantity: '101', cost: '1200' }))
                .rejects.toMatchObject({ code: 'INVENTORY_ACQUISITION_CONFLICT' });
            await expect(acquireTx({ key: 'lot:a:3', quantity: '100', cost: '999' }))
                .rejects.toMatchObject({ code: 'INVENTORY_ACQUISITION_CONFLICT' });
            expect(await prisma.inventoryLot.count()).toBe(1);
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe('100.00000000');
        });
        it('rejects inexact/zero/negative quantities and invalid identities', async () => {
            const bad = [
                { quantity: '0' }, { quantity: '-5' }, { quantity: '1e2' },
                { quantity: '1.123456789' }, { quantity: 'abc' }, { quantity: 0.1 + 0.2 },
                { cost: '0' }, { quantity: '10', key: '' }, { quantity: '10', key: 'x'.repeat(141) },
            ];
            for (const o of bad) {
                await expect(acquireTx(o)).rejects.toBeTruthy();
            }
            expect(await prisma.inventoryLot.count()).toBe(0);
            expect(await prisma.ledgerTransaction.count()).toBe(0);
        });
    });

    describe('B. consumption authority', () => {
        beforeEach(async () => { await acquireTx({ key: 'lot:b:0', quantity: '50', cost: '600' }); });
        const lot0 = async () => (await prisma.inventoryLot.findUnique({ where: { acquisitionKey: 'lot:b:0' } })).id;

        it('partial consumption decrements remaining exactly and records the durable movement', async () => {
            const lotId = await lot0();
            const r = await prisma.$transaction((tx) => consume(tx, { key: 'cons:b:1', lotId, quantity: '17.5' }));
            expect(r.replayed).toBe(false);
            expect(r.lot.quantityRemaining.toFixed(8)).toBe('32.50000000');
            expect(r.lot.status).toBe('OPEN');
            expect(r.consumption.quantity.toFixed(8)).toBe('17.50000000');
            expect(r.consumption.ledgerTxnId).toBeNull(); // P5-E realizes economics, not this slice
        });
        it('full consumption closes the lot; exact remaining hits zero, never negative', async () => {
            const lotId = await lot0();
            const r = await prisma.$transaction((tx) => consume(tx, { key: 'cons:b:2', lotId, quantity: '50' }));
            expect(r.lot.quantityRemaining.toFixed(8)).toBe('0.00000000');
            expect(r.lot.status).toBe('CONSUMED');
        });
        it('over-consumption fails closed and rolls back the entire enclosing transaction', async () => {
            const lotId = await lot0();
            const user = await seedUser(prisma); // default starting balance 1000
            await expect(prisma.$transaction(async (tx) => {
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { increment: 5 } } });
                await consume(tx, { key: 'cons:b:3', lotId, quantity: '50.00000001' });
            })).rejects.toMatchObject({ code: 'INVENTORY_INSUFFICIENT_REMAINING' });
            expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(1000);
            expect((await prisma.inventoryLot.findUnique({ where: { id: lotId } })).quantityRemaining.toFixed(8)).toBe('50.00000000');
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
        });
        it('concurrent consumers of one lot allocate disjoint quantity — exactly one of the two wins', async () => {
            const lotId = await lot0();
            const attempt = (key) => prisma.$transaction((tx) => consume(tx, { key, lotId, quantity: '30' }));
            const results = await Promise.allSettled([attempt('cons:b:4a'), attempt('cons:b:4b')]);
            const ok = results.filter((r) => r.status === 'fulfilled');
            const lost = results.filter((r) => r.status === 'rejected');
            expect(ok).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0].reason.code).toBe('INVENTORY_INSUFFICIENT_REMAINING');
            expect((await prisma.inventoryLot.findUnique({ where: { id: lotId } })).quantityRemaining.toFixed(8)).toBe('20.00000000');
            expect(await prisma.inventoryLotConsumption.count()).toBe(1);
        });
        it('consumption replay returns the committed movement without consuming twice', async () => {
            const lotId = await lot0();
            const run = () => prisma.$transaction((tx) => consume(tx, { key: 'cons:b:5', lotId, quantity: '10' }));
            expect((await run()).replayed).toBe(false);
            const replay = await run();
            expect(replay.replayed).toBe(true);
            expect((await prisma.inventoryLot.findUnique({ where: { id: lotId } })).quantityRemaining.toFixed(8)).toBe('40.00000000');
            expect(await prisma.inventoryLotConsumption.count()).toBe(1);
        });
        it('conflicting reuse of a consumption identity fails closed', async () => {
            const lotId = await lot0();
            const run = (q) => prisma.$transaction((tx) => consume(tx, { key: 'cons:b:6', lotId, quantity: q }));
            await run('10');
            await expect(run('11')).rejects.toMatchObject({ code: 'INVENTORY_CONSUMPTION_CONFLICT' });
            expect((await prisma.inventoryLot.findUnique({ where: { id: lotId } })).quantityRemaining.toFixed(8)).toBe('40.00000000');
        });
        it('unknown lot fails closed', async () => {
            await expect(prisma.$transaction((tx) => consume(tx, { key: 'cons:b:7', lotId: 999999, quantity: '1' })))
                .rejects.toMatchObject({ code: 'INVENTORY_LOT_NOT_FOUND' });
        });
        it('a consumed lot can no longer be consumed', async () => {
            const lotId = await lot0();
            const run = (key, q) => prisma.$transaction((tx) => consume(tx, { key, lotId, quantity: q }));
            await run('cons:b:8', '50');
            await expect(run('cons:b:9', '1')).rejects.toMatchObject({ code: 'INVENTORY_LOT_NOT_OPEN' });
        });
    });

    describe('C. conservation, P&L boundary, P4/P5-A compatibility', () => {
        it('quantity conservation: sum(remaining) + sum(consumed) == sum(acquired) across lots', async () => {
            await acquireTx({ key: 'lot:c:1', quantity: '50', cost: '600' });
            await acquireTx({ key: 'lot:c:2', quantity: '25.5', cost: '306' });
            const lotIdOf = (k) => prisma.inventoryLot.findUnique({ where: { acquisitionKey: k } }).then((l) => l.id);
            const id1 = await lotIdOf('lot:c:1');
            const id2 = await lotIdOf('lot:c:2');
            await prisma.$transaction((tx) => consume(tx, { key: 'cons:c:1', lotId: id1, quantity: '17.25' }));
            await prisma.$transaction((tx) => consume(tx, { key: 'cons:c:2', lotId: id2, quantity: '25.5' }));
            const lots = await prisma.inventoryLot.aggregate({ _sum: { quantityOriginal: true, quantityRemaining: true } });
            const consumed = await prisma.inventoryLotConsumption.aggregate({ _sum: { quantity: true } });
            expect(lots._sum.quantityOriginal.toFixed(8)).toBe('75.50000000'); // acquired
            expect(lots._sum.quantityRemaining.plus(consumed._sum.quantity).toFixed(8)).toBe('75.50000000');
        });
        it('no quote-only P&L: pnl:inventory stays 0 and the ledger tracks acquired inventory, not consumption', async () => {
            await acquireTx({ key: 'lot:c:3', quantity: '80', cost: '960', rate: '12' });
            const lot = await prisma.inventoryLot.findUnique({ where: { acquisitionKey: 'lot:c:3' } });
            await prisma.$transaction((tx) => consume(tx, { key: 'cons:c:3', lotId: lot.id, quantity: '80' }));
            expect((await bal('pnl:inventory')).toFixed(8)).toBe('0.00000000');
            expect(await prisma.journalEntry.count({ where: { account: 'pnl:inventory' } })).toBe(0);
            // consumption is substrate allocation; ledger economics are realized in P5-E
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe('80.00000000');
        });
        it('P4/P5-A USDC ledger behavior is unchanged alongside lot authority', async () => {
            const user = await seedUser(prisma);
            const r = await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'p5b:p4-compat', entryType: 'DEPOSIT', userId: user.id, description: 'P4 deposit',
                lines: [{ account: 'custody:deposit:usdc', debit: '10' }, { account: `user:${user.id}:liability`, credit: '10' }],
            }));
            expect(r.replayed).toBe(false);
            expect((await ledger.accountBalance(prisma, `user:${user.id}:liability`)).balance.toFixed(8)).toBe('10.00000000');
            // cross-asset mixing without ASSET_CONVERSION still fails closed
            await expect(prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'p5b:p5a-compat', entryType: 'DEPOSIT', description: 'mixed',
                lines: [{ account: 'fiat:momo:ghs', debit: '120' }, { account: `user:${user.id}:liability`, credit: '10' }],
            }))).rejects.toMatchObject({ code: 'LEDGER_CROSS_ASSET_BALANCE' });
        });
    });
});
