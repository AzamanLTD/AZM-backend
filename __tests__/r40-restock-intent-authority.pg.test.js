'use strict';

// =============================================================================
// §r40.4 — SERVER-OWNED RESTOCK INTENT (final-audit P1 redesign, PostgreSQL).
//
// The final audit rejected the client-derived restock identity model on four
// grounds. This suite proves each fix against the real database:
//
//  1. OPERATION-LEVEL IDENTITY: two genuinely distinct restocks of the SAME
//     item and the SAME quantity are two intents, each executing a separate,
//     distinct backend operation (stock increases twice) — never conflated.
//  2. RESOLUTION BY INTENT ID: a LATE SUCCESS of an old request (K1) can only
//     mark/acknowledge its OWN intent; a newer intent (K2) for the same
//     item/quantity is untouched. The (item, qty) conflation race is closed.
//  3. NO TTL: unresolved intents never expire; a committed-but-unobserved
//     operation is recoverable from the server after arbitrary browser loss
//     — the retry carries the ORIGINAL key and replays, never duplicates.
//  4. AUTHORITATIVE SERVER STATE: the restock service itself marks the
//     intent EXECUTED (execute AND replay paths) with the stored result, so
//     the recovery list re-displays the outcome the browser lost.
//  Plus the guarded state machine: cancel is refused once executed; a
//  cancelled-but-actually-committed operation resurfaces as EXECUTED
//  (truth wins); ack is only valid for EXECUTED and is idempotent.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedBusiness } = require('./helpers/factories');
const { InventoryRestockIntentService } = require('../services/businessOS/inventoryRestockIntentService');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r40.4 — server-owned restock intent (PostgreSQL)', () => {
    let db, owner, biz, item, intents, restocks;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db?.$disconnect(); });

    beforeEach(async () => {
        ({ owner, biz } = await seedBusiness(db));
        item = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Palm Oil', unit: 'liters',
            currentStock: 10, minimumStock: 0, costPerUnit: 4,
        } });
        intents = new InventoryRestockIntentService(db);
        restocks = new InventoryRestockService(db);
    });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "User", "BusinessProfile" RESTART IDENTITY CASCADE');
    });

    const createIntent = (quantity, itemId = item.id) => intents.createIntent({
        businessProfileId: biz.id, userId: owner.id, itemId, quantity,
    });
    const restockWith = (key, quantity, cost) => restocks.restock({
        businessProfileId: biz.id, itemId: item.id, quantity, idempotencyKey: key,
        ...(cost !== undefined ? { costPerUnit: cost } : {}),
    });
    const get = (id) => db.inventoryRestockIntent.findUnique({ where: { id } });

    test('1. registration mints an operation-level identity; two same-qty intents are DISTINCT', async () => {
        const a = await createIntent('5');
        const b = await createIntent('5');
        expect(a.id).not.toBe(b.id);
        expect(a.status).toBe('PENDING');
        expect(a.quantity).toBe('5'); // stored VERBATIM (fingerprint v2 digests the string)
        const list = await intents.listUnresolved({ businessProfileId: biz.id });
        expect(list.length).toBe(2); // multiple unresolved intents coexist
    });

    test('2. two distinct same-item/same-qty purchases EXECUTE as two separate operations', async () => {
        const a = await createIntent('5');
        const b = await createIntent('5');
        // each intent's id IS its idempotency key
        const ra = await restockWith(a.id, '5', '2');
        const rb = await restockWith(b.id, '5', '2');
        expect(rb.operationId).not.toBe(ra.operationId); // two DIFFERENT operations
        const stock = await db.inventoryItem.findUnique({ where: { id: item.id } });
        expect(Number(stock.currentStock)).toBe(20); // 10 + 5 + 5 — both executed
        const ops = await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id } });
        expect(ops).toBe(2);
        const ledger = await db.businessLedgerEntry.count({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } });
        expect(ledger).toBe(2); // two separate financial postings
    });

    test('3. retry with the intent key REPLAYS — exactly-once holds across the loss of the response', async () => {
        const a = await createIntent('5');
        const first = await restockWith(a.id, '5', '2');
        // response lost; browser restarted; the client recovers the SAME
        // intent id from the server and retries with the ORIGINAL key
        const retry = await restockWith(a.id, '5', '2');
        expect(retry).toEqual(first); // replayed, not re-executed
        const stock = await db.inventoryItem.findUnique({ where: { id: item.id } });
        expect(Number(stock.currentStock)).toBe(15); // executed exactly ONCE
        const ops = await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id } });
        expect(ops).toBe(1);
    });

    test('4. recovery list: a committed-but-unobserved operation surfaces with its stored result; NO TTL', async () => {
        const a = await createIntent('7');
        await restockWith(a.id, '7', '2');
        // the browser never saw the response — the intent is EXECUTED, not
        // acknowledged, and remains resolvable forever
        const list = await intents.listUnresolved({ businessProfileId: biz.id });
        expect(list.length).toBe(1);
        expect(list[0].id).toBe(a.id);
        expect(list[0].status).toBe('EXECUTED');
        expect(list[0].executionResult.operationId).toBeTruthy(); // the outcome is recoverable
        expect(list[0].executedAt).toBeTruthy();
        // the client observes and acknowledges
        await intents.acknowledge({ businessProfileId: biz.id, id: a.id });
        const after = await intents.listUnresolved({ businessProfileId: biz.id });
        expect(after.length).toBe(0); // resolved: gone from the recovery list
    });

    test('5. K1-late-success race: acknowledging/executing K1 never touches K2 (same item+qty)', async () => {
        const k1 = await createIntent('5');
        const k2 = await createIntent('5');
        // K1's request eventually commits; its success resolves ONLY K1
        await restockWith(k1.id, '5', '2');
        const row1 = await get(k1.id);
        expect(row1.status).toBe('EXECUTED');
        // K2 is COMPLETELY UNTOUCHED — still pending, still resolvable
        const row2 = await get(k2.id);
        expect(row2.status).toBe('PENDING');
        expect(row2.executionResult).toBeNull();
        // the late acknowledgement of K1 also only affects K1
        await intents.acknowledge({ businessProfileId: biz.id, id: k1.id });
        expect((await get(k2.id)).status).toBe('PENDING');
        // and K2 still executes independently afterwards
        await restockWith(k2.id, '5', '2');
        expect((await get(k2.id)).status).toBe('EXECUTED');
    });

    test('6. replay marks the intent EXECUTED with the stored result (recovery after total client loss)', async () => {
        const a = await createIntent('5');
        // commit happened, response lost, browser destroyed — the client
        // recovered the intent id from the server and retried
        const first = await restockWith(a.id, '5', '2');
        const replayed = await restockWith(a.id, '5', '2');
        expect(replayed).toEqual(first);
        const row = await get(a.id);
        expect(row.status).toBe('EXECUTED');
        expect(row.executionResult).toEqual(first); // the outcome is recoverable
    });

    test('7. cancel is refused once executed; a cancel-on-a-guess that actually committed RESURFACES', async () => {
        const a = await createIntent('5');
        // cancel while pending: allowed
        const cancelled = await intents.cancel({ businessProfileId: biz.id, id: a.id });
        expect(cancelled.status).toBe('CANCELLED');
        expect((await intents.listUnresolved({ businessProfileId: biz.id })).length).toBe(0);
        // ...but the request was ALREADY in flight and commits afterwards —
        // truth wins: the executed operation resurfaces in the recovery list
        await restockWith(a.id, '5', '2');
        const row = await get(a.id);
        expect(row.status).toBe('EXECUTED'); // CANCELLED → EXECUTED allowed
        expect((await intents.listUnresolved({ businessProfileId: biz.id })).length).toBe(1);
        // cancelling an EXECUTED intent is now FORBIDDEN — only acknowledge
        await expect(intents.cancel({ businessProfileId: biz.id, id: a.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_ALREADY_EXECUTED' });
        await intents.acknowledge({ businessProfileId: biz.id, id: a.id });
        expect((await get(a.id)).status).toBe('ACKNOWLEDGED');
    });

    test('8. ack is only valid for EXECUTED intents (and idempotent); state machine is guarded', async () => {
        const a = await createIntent('5');
        await expect(intents.acknowledge({ businessProfileId: biz.id, id: a.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_NOT_EXECUTED' });
        await restockWith(a.id, '5', '2');
        await intents.acknowledge({ businessProfileId: biz.id, id: a.id });
        // re-ack is idempotent
        await intents.acknowledge({ businessProfileId: biz.id, id: a.id });
        expect((await get(a.id)).status).toBe('ACKNOWLEDGED');
    });

    test('9. business isolation and not-found guards', async () => {
        const other = await seedBusiness(db);
        const a = await createIntent('5');
        // another business cannot see, ack or cancel this intent
        expect((await intents.listUnresolved({ businessProfileId: other.biz.id })).length).toBe(0);
        await expect(intents.acknowledge({ businessProfileId: other.biz.id, id: a.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_NOT_FOUND' });
        await expect(intents.cancel({ businessProfileId: other.biz.id, id: a.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_NOT_FOUND' });
        await expect(intents.cancel({ businessProfileId: biz.id, id: 'no-such-intent' }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_NOT_FOUND' });
    });

    test('10. strict quantity registration (verbatim exact-decimal strings)', async () => {
        // JSON numbers are refused — the intent stores and resends the string
        await expect(createIntent(5)).rejects.toMatchObject({ code: 'RESTOCK_INTENT_INVALID_QUANTITY' });
        await expect(createIntent('1e3')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_INVALID_QUANTITY' });
        await expect(createIntent('-1')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_INVALID_QUANTITY' });
        await expect(createIntent('0.000000001')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_INVALID_QUANTITY' }); // below restock minimum
        await expect(createIntent('1.123456789')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_INVALID_QUANTITY' }); // >8dp
        await expect(createIntent('12.50', 'no-such-item')).rejects.toMatchObject({ code: 'RESTOCK_ITEM_NOT_FOUND' });
        // trailing-zero strings are stored VERBATIM (fingerprint v2)
        const a = await createIntent('12.50');
        expect(a.quantity).toBe('12.50');
    });
});
