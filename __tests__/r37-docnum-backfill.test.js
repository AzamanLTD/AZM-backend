// __tests__/r37-docnum-backfill.test.js
// =============================================================================
// r37/P1 — PRODUCTION DATA BACKFILL for DocumentNumberSequence (real
// PostgreSQL). r36 introduced the durable per-business document-number
// sequence, but its tests all started from an EMPTY database. Production
// already contains PurchaseOrder/StockCount rows with real numbers: a fresh
// sequence starting at 0 would issue PO-00001/SC-00001 into a business that
// already used them. nextDocumentNumber now INITIALIZES each business's
// sequence from the MAXIMUM existing canonical number (inside the same atomic
// upsert), so:
//   • existing numbering is never reused
//   • malformed legacy numbers cannot break deployment (they are ignored by
//     the MAX and surfaced via countMalformedLegacyNumbers)
//   • the backfill is naturally idempotent (INSERT branch runs once)
//   • concurrent creation stays safe during/after bootstrap
//   • deleted documents never free a number
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r37/P1 — document-number production backfill', () => {
    let db;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "StockCountItem", "StockCount", "PurchaseOrderItem", "PurchaseOrder", "Supplier", "DocumentNumberSequence", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    const { nextDocumentNumber, countMalformedLegacyNumbers } = require('../services/businessOS/documentNumberService');

    async function seedBiz() {
        const { owner, biz } = await seedBusiness(db);
        return { user: owner, biz };
    }

    async function seedPO(bizId, byId, poNumber) {
        const sup = await db.supplier.create({ data: { businessProfileId: bizId, name: `S-${poNumber}` } });
        return db.purchaseOrder.create({ data: { businessProfileId: bizId, poNumber, supplierId: sup.id, createdById: byId, totalCost: 10 } });
    }

    const seedSC = (bizId, byId, countNumber) =>
        db.stockCount.create({ data: { businessProfileId: bizId, countNumber, createdById: byId } });

    const next = (bizId, type) => db.$transaction((tx) => nextDocumentNumber(tx, bizId, type));

    test('existing PO-00037 → first new PO is PO-00038', async () => {
        const { user, biz } = await seedBiz();
        await seedPO(biz.id, user.id, 'PO-00037');
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00038');
    });

    test('existing SC-00014 → first new count is SC-00015', async () => {
        const { user, biz } = await seedBiz();
        await seedSC(biz.id, user.id, 'SC-00014');
        await expect(next(biz.id, 'STOCK_COUNT')).resolves.toBe('SC-00015');
    });

    test('two businesses backfill independently', async () => {
        const a = await seedBiz();
        const b = await seedBiz();
        await seedPO(a.biz.id, a.user.id, 'PO-00037');
        await seedPO(b.biz.id, b.user.id, 'PO-00003');
        await expect(next(a.biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00038');
        await expect(next(b.biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00004');
    });

    test('repeated backfill is idempotent: sequence continues, never resets', async () => {
        const { user, biz } = await seedBiz();
        await seedPO(biz.id, user.id, 'PO-00037');
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00038');
        // The sequence row now exists — the INSERT (backfill) branch never
        // runs again; every further reservation increments.
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00039');
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00040');
        const seq = await db.documentNumberSequence.findUnique({
            where: { businessProfileId_docType: { businessProfileId: biz.id, docType: 'PURCHASE_ORDER' } },
        });
        expect(seq.lastNumber).toBe(40);
    });

    test('concurrent creation after backfill produces unique contiguous numbers', async () => {
        const { user, biz } = await seedBiz();
        await seedPO(biz.id, user.id, 'PO-00037');
        const results = await Promise.all(
            Array.from({ length: 5 }, () => next(biz.id, 'PURCHASE_ORDER'))
        );
        expect(new Set(results).size).toBe(5);
        const nums = results.map((n) => Number(n.replace('PO-', ''))).sort((x, y) => x - y);
        expect(nums).toEqual([38, 39, 40, 41, 42]);
    });

    test('deleted documents never free a number', async () => {
        const { user, biz } = await seedBiz();
        await seedPO(biz.id, user.id, 'PO-00005');
        const first = await next(biz.id, 'PURCHASE_ORDER'); // PO-00006
        expect(first).toBe('PO-00006');
        // The document that holds PO-00006 is deleted from production.
        await db.purchaseOrder.deleteMany({ where: { businessProfileId: biz.id, poNumber: 'PO-00006' } });
        // The sequence is monotonic — the number is not reissued.
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00007');
    });

    test('malformed legacy numbers are ignored by the floor and surfaced, never guessed', async () => {
        const { user, biz } = await seedBiz();
        // One canonical, two malformed legacy identifiers.
        await seedPO(biz.id, user.id, 'PO-00005');
        await seedPO(biz.id, user.id, 'legacy-manual-1');
        await seedPO(biz.id, user.id, 'PO/manual/9');
        // The MAX runs over CANONICAL numbers only → floor is 5.
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00006');
        // Malformed rows are surfaced explicitly, not silently guessed at.
        await expect(countMalformedLegacyNumbers(db, biz.id, 'PURCHASE_ORDER')).resolves.toBe(2);
    });

    test('business with no existing documents starts at PO-00001', async () => {
        const { biz } = await seedBiz();
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00001');
        await expect(next(biz.id, 'STOCK_COUNT')).resolves.toBe('SC-00001');
    });

    test('mixed PO and SC sequences for one business are independent', async () => {
        const { user, biz } = await seedBiz();
        await seedSC(biz.id, user.id, 'SC-00014');
        await expect(next(biz.id, 'PURCHASE_ORDER')).resolves.toBe('PO-00001');
        await expect(next(biz.id, 'STOCK_COUNT')).resolves.toBe('SC-00015');
    });
});
