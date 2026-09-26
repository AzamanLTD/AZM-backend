// §Wave-1B — inventory restock exact-decimal economics (real PostgreSQL).
// Binary floats must never be the economic authority: the ledger row
// (BusinessLedgerEntry.amount, Decimal(20, 8)) must carry the EXACT product
// of quantity × unit cost for any inputs within the documented precision
// bounds (≤ 8 decimal places each).
const { PrismaClient, Prisma: P } = require('@prisma/client');
const { seedBusiness } = require('./helpers/factories');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');
const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb('r33 §Wave-1B — inventory restock exact-decimal economics (PostgreSQL)', () => {
    let db, biz, item, svc;
    const url = process.env.TEST_DATABASE_URL;
    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        svc = new InventoryRestockService(db);
    });
    afterAll(async () => { await db?.$disconnect(); });
    beforeEach(async () => {
        ({ biz } = await seedBusiness(db));
        item = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Palm Oil', unit: 'liters',
            currentStock: 10, minimumStock: 0, costPerUnit: 4,
        } });
    });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "User", "BusinessProfile" RESTART IDENTITY CASCADE');
    });

    const restock = (key, extra = {}) => svc.restock({
        businessProfileId: biz.id, itemId: item.id, quantity: 1, idempotencyKey: key, ...extra,
    });
    const ledgerFor = async (opId) => {
        const rows = await db.businessLedgerEntry.findMany({
            where: { sourceType: 'INVENTORY_RESTOCK', sourceId: opId },
        });
        expect(rows).toHaveLength(1);
        return rows[0];
    };

    test('1. the classic float-poison product posts exactly: 0.1 × 3 = 0.3 GHS, not 0.30000000000000004', async () => {
        const out = await restock('exact-1', { quantity: '0.1', costPerUnit: '3' });
        const ledger = await ledgerFor(out.operationId);
        expect(ledger.amount.toString()).toBe('-0.3');
        expect(ledger.amountGhs.toString()).toBe('-0.3');
        // Wire compatibility: the response carries a JSON number.
        expect(out.totalCostGhs).toBe(0.3);
        // Exact strings recorded in ledger metadata — durable evidence.
        expect(ledger.metadata).toMatchObject({ quantity: '0.1', unitCost: '3', totalCostGhs: '0.3' });
    });

    test('2. multi-place decimals stay exact: 3.7 × 1.35 = 4.995 GHS', async () => {
        const out = await restock('exact-2', { quantity: '3.7', costPerUnit: '1.35' });
        const ledger = await ledgerFor(out.operationId);
        expect(ledger.amount.toString()).toBe('-4.995');
        expect(out.totalCostGhs).toBe(4.995);
    });

    test('3. the default-cost path is exact too: catalog 0.1 × quantity 3 = 0.3 GHS', async () => {
        await db.inventoryItem.update({ where: { id: item.id }, data: { costPerUnit: 0.1 } });
        const out = await restock('exact-3', { quantity: '3' });
        const ledger = await ledgerFor(out.operationId);
        expect(ledger.amount.toString()).toBe('-0.3');
        expect(ledger.metadata).toMatchObject({ unitCost: '0.1', totalCostGhs: '0.3' });
    });

    test('4. exactly 8 decimal places are accepted (documented precision bound)', async () => {
        const out = await restock('exact-4', { quantity: '1.12345678', costPerUnit: '0.00000002' });
        const ledger = await ledgerFor(out.operationId);
        // 1.12345678 × 0.00000002 = 0.0000000224691356 — beyond the ledger's
        // own 8dp scale it stores 0.00000002 (DB half-up), but the exact
        // product is preserved in metadata strings.
        expect(ledger.metadata.totalCostGhs).toBe('0.0000000224691356');
        expect(out.totalCostGhs).toBeCloseTo(2.24691356e-8, 15);
    });

    test.each([
        ['9dp quantity', { quantity: '1.123456789' }],
        ['9dp cost', { costPerUnit: '1.123456789' }],
        ['exponent string', { quantity: '1e5' }],
        ['comma decimal', { quantity: '12,5' }],
        ['whitespace', { quantity: ' 3' }],
        ['hex', { quantity: '0x10' }],
        ['empty string', { quantity: '' }],
        ['boolean', { quantity: true }],
        ['null', { quantity: null }],
        ['negative', { quantity: '-1' }],
        ['negative cost', { costPerUnit: '-0.5' }],
        ['NaN', { quantity: NaN }],
        ['Infinity', { quantity: Infinity }],
        ['object', { quantity: {valueOf: () => 5} }],
    ])('5. malformed or out-of-precision %s is rejected with no economic effect', async (label, extra) => {
        await expect(restock('reject-' + label, extra))
            .rejects.toMatchObject({ code: /^RESTOCK_INVALID_(QUANTITY|COST)$/ });
        const items = await db.inventoryItem.findUnique({ where: { id: item.id } });
        expect(items.currentStock).toBe(10);
        const ops = await db.inventoryRestockOperation.findMany();
        expect(ops).toHaveLength(0);
        const ledgers = await db.businessLedgerEntry.findMany({ where: { sourceType: 'INVENTORY_RESTOCK' } });
        expect(ledgers).toHaveLength(0);
    });

    test('6. JSON number inputs keep full wire compatibility and exactness', async () => {
        const out = await restock('exact-6', { quantity: 0.5, costPerUnit: 2.25 });
        const ledger = await ledgerFor(out.operationId);
        expect(ledger.amount.toString()).toBe('-1.125');
        expect(out.totalCostGhs).toBe(1.125);
        const retry = await restock('exact-6', { quantity: 0.5, costPerUnit: 2.25 });
        expect(retry).toEqual(out);
        expect((await db.inventoryRestockOperation.findMany())).toHaveLength(1);
    });

    test('7. an integer restock keeps the legacy wire shape byte-for-byte', async () => {
        const out = await restock('exact-7', { quantity: 5 });
        expect(out).toMatchObject({ totalCostGhs: 20, ledgerWritten: true, item: { currentStock: 15 } });
        const ledger = await ledgerFor(out.operationId);
        expect(ledger.amount.toString()).toBe('-20');
    });
});
