// Real PostgreSQL economic authority. Do not replace with a mocked transaction.
const { PrismaClient } = require('@prisma/client');
const { seedBusiness } = require('./helpers/factories');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');
const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb('inventory restock durable economic identity (PostgreSQL)', () => {
    let db, otherClient, biz, item, svc;
    beforeAll(() => { db = new PrismaClient(); otherClient = new PrismaClient(); svc = new InventoryRestockService(db); });
    afterAll(async () => { await db?.$disconnect(); await otherClient?.$disconnect(); });
    beforeEach(async () => {
        ({ biz } = await seedBusiness(db));
        item = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Rice', unit: 'kg', currentStock: 10, minimumStock: 0, costPerUnit: 4,
        } });
    });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "User", "BusinessProfile" RESTART IDENTITY CASCADE');
    });
    const args = (key, extra = {}) => ({ businessProfileId: biz.id, itemId: item.id, quantity: 5, idempotencyKey: key, ...extra });
    const stock = () => db.inventoryItem.findUnique({ where: { id: item.id } });
    const ledgers = () => db.businessLedgerEntry.findMany({ where: { sourceType: 'INVENTORY_RESTOCK' } });
    const operations = () => db.inventoryRestockOperation.findMany();

    test('first commit and exact retries preserve one stock delta, one expense, one immutable response', async () => {
        const first = await svc.restock(args('first'));
        expect(first).toMatchObject({ totalCostGhs: 20, ledgerWritten: true, item: { currentStock: 15 } });
        const retry = await svc.restock(args('first'));
        expect(retry).toEqual(first);
        expect((await stock()).currentStock).toBe(15);
        const rows = await ledgers();
        expect(rows).toHaveLength(1);
        expect(rows[0].amount.toString()).toBe('-20');
        expect(rows[0].sourceId).toBe(first.operationId);
        expect((await operations())).toHaveLength(1);
    });
    test('concurrent duplicate requests across Prisma clients commit one economic effect', async () => {
        const results = await Promise.allSettled([
            svc.restock(args('race')), new InventoryRestockService(otherClient).restock(args('race')),
        ]);
        expect(results.map(x => x.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(results[0].value).toEqual(results[1].value);
        expect((await stock()).currentStock).toBe(15);
        expect(await ledgers()).toHaveLength(1);
        expect(await operations()).toHaveLength(1);
    });
    test.each([
        [{ quantity: 6 }, 'quantity'], [{ costPerUnit: 5 }, 'unit cost'],
        [{ itemId: 'different-item' }, 'item identity'],
    ])('key reuse with changed %s fails closed', async (change) => {
        await svc.restock(args('conflict'));
        await expect(svc.restock(args('conflict', change))).rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT', statusCode: 409 });
        expect((await stock()).currentStock).toBe(15);
        expect(await ledgers()).toHaveLength(1);
    });
    test('distinct keys allow two identical intentional restocks', async () => {
        const first = await svc.restock(args('intent-one'));
        const second = await svc.restock(args('intent-two'));
        expect(first.operationId).not.toBe(second.operationId);
        expect((await stock()).currentStock).toBe(20);
        expect(await ledgers()).toHaveLength(2);
        expect(await operations()).toHaveLength(2);
    });
    test('ledger write failure rolls back stock, key and ledger; same key later succeeds', async () => {
        const failOnce = new InventoryRestockService({
            inventoryRestockOperation: db.inventoryRestockOperation,
            $transaction: (fn) => db.$transaction(tx => fn(new Proxy(tx, { get(target, prop) {
                if (prop === 'businessLedgerEntry') return { create: async () => { throw new Error('injected ledger failure'); } };
                return target[prop];
            } }))),
        });
        await expect(failOnce.restock(args('rollback'))).rejects.toThrow('injected ledger failure');
        expect((await stock()).currentStock).toBe(10);
        expect(await ledgers()).toHaveLength(0);
        expect(await operations()).toHaveLength(0);
        const committed = await svc.restock(args('rollback'));
        expect(committed.item.currentStock).toBe(15);
        expect(await ledgers()).toHaveLength(1);
    });
    test('same key is scoped per business, while a different business cannot restock this item', async () => {
        const { biz: otherBiz } = await seedBusiness(db);
        await svc.restock(args('shared-key'));
        await expect(svc.restock(args('shared-key', { businessProfileId: otherBiz.id })))
            .rejects.toMatchObject({ code: 'RESTOCK_ITEM_NOT_FOUND' });
        const otherItem = await db.inventoryItem.create({ data: {
            businessProfileId: otherBiz.id, name: 'Rice', unit: 'kg', currentStock: 10, costPerUnit: 4,
        } });
        const second = await svc.restock(args('shared-key', { businessProfileId: otherBiz.id, itemId: otherItem.id }));
        expect(second.item.currentStock).toBe(15);
        expect((await stock()).currentStock).toBe(15);
        expect(await ledgers()).toHaveLength(2);
    });
    test('replay survives later stock, catalog cost and active status changes', async () => {
        const first = await svc.restock(args('catalog-change'));
        await db.inventoryItem.update({ where: { id: item.id }, data: { currentStock: 2, costPerUnit: 100, name: 'Brown Rice', isActive: false } });
        expect(await svc.restock(args('catalog-change'))).toEqual(first);
        expect((await stock()).currentStock).toBe(2);
        expect(await ledgers()).toHaveLength(1);
    });
});
