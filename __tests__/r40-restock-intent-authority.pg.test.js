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
//  §r40.7 (final-audit P1): a CANCELLED intent without a committed
//  operation is TERMINAL — a later submission can never resurrect it. The
//  restock claim takes the intent row lock (FOR UPDATE) at the DB boundary,
//  serializing claim vs cancel; truth-wins survives only as the documented
//  replay of an already-committed operation.
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

    test('7. cancel is terminal without a committed operation; a cancel-on-a-guess that DID commit RESURFACES (r40.7)', async () => {
        const a = await createIntent('5');
        // cancel while pending: allowed — and with NO committed operation it
        // is TERMINAL (§r40.7 final-audit P1): a later submission with the
        // same key can never resurrect the deliberately discarded operation.
        const cancelled = await intents.cancel({ businessProfileId: biz.id, id: a.id });
        expect(cancelled.status).toBe('CANCELLED');
        expect((await intents.listUnresolved({ businessProfileId: biz.id })).length).toBe(0);
        await expect(restockWith(a.id, '5', '2')).rejects.toMatchObject({
            code: 'RESTOCK_INTENT_CANCELLED', statusCode: 409,
        });
        expect((await get(a.id)).status).toBe('CANCELLED'); // unchanged
        expect(await stockOf(item.id)).toBe(10);             // no mutation
        expect(await ledgerCount()).toBe(0);
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: a.id } })).toBe(0);

        // ...but if the operation HAD already committed when the operator
        // cancelled on a guess (the documented truth-wins recovery state),
        // a later retry REPLAYS the committed operation and the intent
        // resurfaces as EXECUTED with its stored result. Constructed here
        // directly: under §r40.7 the service itself can no longer create
        // this state (the intent row lock serializes claim vs cancel), so
        // this covers exactly the legacy/recovery states the in-list
        // [PENDING, CANCELLED] → EXECUTED transition exists for.
        const b = await createIntent('5');
        const first = await restockWith(b.id, '5', '2');
        expect((await get(b.id)).status).toBe('EXECUTED');
        await db.inventoryRestockIntent.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
        const replayed = await restockWith(b.id, '5', '2');
        expect(replayed).toEqual(first); // replay only — never a new operation
        const row = await get(b.id);
        expect(row.status).toBe('EXECUTED'); // CANCELLED → EXECUTED allowed (truth wins)
        expect((await intents.listUnresolved({ businessProfileId: biz.id })).length).toBe(1);
        expect(await ledgerCount()).toBe(1); // exactly one economic effect
        // cancelling an EXECUTED intent is FORBIDDEN — only acknowledge
        await expect(intents.cancel({ businessProfileId: biz.id, id: b.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_ALREADY_EXECUTED' });
        await intents.acknowledge({ businessProfileId: biz.id, id: b.id });
        expect((await get(b.id)).status).toBe('ACKNOWLEDGED');
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

    // ── §r40.5 — intent-id binding to the registered operation (P1) ────────

    const restockAs = (key, itemId, quantity, bpid = biz.id) => restocks.restock({
        businessProfileId: bpid, itemId, quantity, idempotencyKey: key,
    });
    const ledgerCount = () => db.businessLedgerEntry.count({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } });
    const stockOf = async (id) => (await db.inventoryItem.findUnique({ where: { id } })).currentStock;

    test('11. intent key + MATCHING payload succeeds; exact-decimal equivalence holds (12.5 ≡ 12.50)', async () => {
        const k = await createIntent('12.5');
        const item2 = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Rice', unit: 'kg',
            currentStock: 0, minimumStock: 0, costPerUnit: 2,
        } });
        // matching item + exactly-equal quantity (value-exact base-10) executes
        const r = await restockAs(k.id, item.id, '12.50', biz.id);
        expect(r.ledgerWritten).toBe(true);
        expect((await get(k.id)).status).toBe('EXECUTED');
        expect(await stockOf(item2.id)).toBe(0); // untouched — the other item
    });

    test('12. intent key + WRONG ITEM is rejected BEFORE any economic mutation', async () => {
        const k = await createIntent('5');
        const item2 = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Rice', unit: 'kg',
            currentStock: 0, minimumStock: 0, costPerUnit: 2,
        } });
        await expect(restockAs(k.id, item2.id, '5'))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_PAYLOAD_MISMATCH', statusCode: 409 });
        // nothing moved: no stock, no ledger, no operation row, intent untouched
        expect(await stockOf(item.id)).toBe(10);
        expect(await stockOf(item2.id)).toBe(0);
        expect(await ledgerCount()).toBe(0);
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id } })).toBe(0);
        expect((await get(k.id)).status).toBe('PENDING');
    });

    test('13. intent key + WRONG QUANTITY is rejected BEFORE any economic mutation', async () => {
        const k = await createIntent('5');
        await expect(restockAs(k.id, item.id, '100'))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_PAYLOAD_MISMATCH', statusCode: 409 });
        // a different valid quantity (not value-equal) is also refused
        await expect(restockAs(k.id, item.id, '5.5'))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_PAYLOAD_MISMATCH', statusCode: 409 });
        expect(await stockOf(item.id)).toBe(10);
        expect(await ledgerCount()).toBe(0);
        expect((await get(k.id)).status).toBe('PENDING');
        // the intent is still usable with its REGISTERED payload afterwards
        await restockAs(k.id, item.id, '5');
        expect((await get(k.id)).status).toBe('EXECUTED');
    });

    test('14. a cross-business restock with a foreign intent key cannot disturb the owning intent', async () => {
        const other = await seedBusiness(db);
        const item2 = await db.inventoryItem.create({ data: {
            businessProfileId: other.biz.id, name: 'Rice', unit: 'kg',
            currentStock: 0, minimumStock: 0, costPerUnit: 2,
        } });
        const k = await createIntent('5'); // owned by biz
        // the other business uses the same key string — it is a DIFFERENT
        // operation in its own scope and cannot see or redefine our intent
        const r = await restockAs(k.id, item2.id, '3', other.biz.id);
        expect(r.ledgerWritten).toBe(true);
        expect(await stockOf(item2.id)).toBe(3); // its own economics ran
        expect((await get(k.id)).status).toBe('PENDING'); // our intent untouched
        await expect(intents.cancel({ businessProfileId: other.biz.id, id: k.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_NOT_FOUND' });
        // the owning business can still execute its OWN registered operation
        await restockAs(k.id, item.id, '5', biz.id);
        const done = await get(k.id);
        expect(done.status).toBe('EXECUTED');
        expect(done.itemId).toBe(item.id);
    });

    // ── §r40.5 — cancel-vs-restock concurrency (P1) ────────────────────────

    test('15. RACE execution-wins-first: cancel blocked on the locked row can NEVER overwrite EXECUTED', async () => {
        const k = await createIntent('5');
        let release;
        const gate = new Promise((res) => { release = res; });
        // Simulates the restock service's §r40.4 boundary: economics and the
        // intent's PENDING → EXECUTED transition inside ONE transaction,
        // held open (the intent row is LOCKED) before commit.
        const restockTx = db.$transaction(async (tx) => {
            await tx.inventoryItem.update({ where: { id: item.id }, data: { currentStock: { increment: 5 } } });
            await tx.inventoryRestockIntent.updateMany({
                where: { id: k.id, businessProfileId: biz.id, status: { in: ['PENDING', 'CANCELLED'] } },
                data: { status: 'EXECUTED', executedAt: new Date() },
            });
            await gate; // hold the transaction — the intent row stays locked
        });
        // cancel arrives WHILE the restock transaction is in flight: its
        // conditional UPDATE blocks on the locked row and must re-check the
        // committed state (PostgreSQL EvalPlanQual) instead of acting on the
        // pre-read PENDING snapshot.
        const cancelPromise = intents.cancel({ businessProfileId: biz.id, id: k.id });
        await new Promise((r) => setTimeout(r, 200)); // let cancel reach the locked row
        release();
        await restockTx;
        await expect(cancelPromise).rejects.toMatchObject({ code: 'RESTOCK_INTENT_ALREADY_EXECUTED', statusCode: 409 });
        // truth wins: the committed execution is intact, never CANCELLED
        expect((await get(k.id)).status).toBe('EXECUTED');
        expect(await stockOf(item.id)).toBe(15);
    });

    test('16. RACE cancel-wins-first: reuse of the cancelled key is REJECTED with no mutation; a genuine simultaneous race stays consistent (r40.7)', async () => {
        // ordering A (§r40.7 proof A — cancel wins BEFORE the economic
        // claim): a later submission of the cancelled key is rejected
        // permanently; NO ledger/stock/operation mutation occurs.
        const a = await createIntent('5');
        await intents.cancel({ businessProfileId: biz.id, id: a.id });
        expect((await get(a.id)).status).toBe('CANCELLED');
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: a.id } })).toBe(0);
        await expect(restockAs(a.id, item.id, '5')).rejects.toMatchObject({
            code: 'RESTOCK_INTENT_CANCELLED', statusCode: 409,
        });
        expect((await get(a.id)).status).toBe('CANCELLED'); // stays cancelled
        expect(await stockOf(item.id)).toBe(10);             // stock unchanged
        expect(await ledgerCount()).toBe(0);                 // no ledger row
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: a.id } })).toBe(0);
        // a REPEATED attempt is rejected identically (stable typed conflict)
        await expect(restockAs(a.id, item.id, '5')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_CANCELLED' });

        // ordering B: genuinely simultaneous cancel-vs-restock, five rounds.
        // BOTH outcomes are legal — whoever wins the intent row lock first.
        // The invariant is the audit's state machine:
        //   execution won  → EXECUTED, exactly ONE economic effect,
        //                    cancel afterwards refused, replay never mutates;
        //   cancel won     → CANCELLED, ZERO mutation, reuse rejected.
        let executed = 0, cancelled = 0;
        for (let round = 0; round < 5; round++) {
            const k = await createIntent('5');
            const [, outcome] = await Promise.allSettled([
                intents.cancel({ businessProfileId: biz.id, id: k.id }),
                restockAs(k.id, item.id, '5'),
            ]);
            const final = await get(k.id);
            if (outcome.status === 'fulfilled') {
                executed += 1;
                expect(final.status).toBe('EXECUTED'); // never CANCELLED over a commit
                expect(await stockOf(item.id)).toBe(10 + 5 * executed);
                expect(await ledgerCount()).toBe(executed);
                await expect(intents.cancel({ businessProfileId: biz.id, id: k.id }))
                    .rejects.toMatchObject({ code: 'RESTOCK_INTENT_ALREADY_EXECUTED' });
                const first = outcome.value;
                const again = await restockAs(k.id, item.id, '5'); // replay: no second mutation
                expect(again).toEqual(first);
                expect(await stockOf(item.id)).toBe(10 + 5 * executed);
                expect(await ledgerCount()).toBe(executed);
            } else {
                cancelled += 1;
                expect(outcome.reason.code).toBe('RESTOCK_INTENT_CANCELLED');
                expect(final.status).toBe('CANCELLED');
                expect(await stockOf(item.id)).toBe(10 + 5 * executed); // unchanged
                expect(await ledgerCount()).toBe(executed);             // unchanged
                // later reuse of the cancelled key stays rejected
                await expect(restockAs(k.id, item.id, '5')).rejects.toMatchObject({ code: 'RESTOCK_INTENT_CANCELLED' });
            }
            expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: k.id } })).toBe(final.status === 'EXECUTED' ? 1 : 0);
        }
        expect(executed + cancelled).toBe(5);
    });

    test('17. r40.7 proof B — EXECUTION-WINS: the claim serializes on the intent row lock; after commit, cancel is forbidden and replay never mutates twice (deterministic)', async () => {
        const k = await createIntent('5');
        // Hold the intent row lock externally — the service's claim must
        // queue BEHIND it (the §r40.7 DB boundary: the intent row lock is
        // taken before ANY economic statement).
        let release;
        const gate = new Promise((res) => { release = res; });
        let lockHeld;
        const lockAcquired = new Promise((res) => { lockHeld = res; });
        const held = db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "InventoryRestockIntent" WHERE "id" = ${k.id} FOR UPDATE`;
            lockHeld();
            await gate;
            return 'held';
        }, { timeout: 15000 });
        await lockAcquired; // wait for the lock itself, not a timer (§r40.6)
        const restockP = restockAs(k.id, item.id, '5');
        let done = false;
        restockP.then(() => { done = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(done).toBe(false); // blocked on the intent row lock
        release();
        await held;
        const first = await restockP;
        expect((await get(k.id)).status).toBe('EXECUTED');
        expect(await stockOf(item.id)).toBe(15);
        expect(await ledgerCount()).toBe(1);
        // once EXECUTED, cancel is FORBIDDEN — truth wins
        await expect(intents.cancel({ businessProfileId: biz.id, id: k.id }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_ALREADY_EXECUTED' });
        // replay returns the ORIGINAL result and NEVER creates a second
        // ledger/stock mutation
        const again = await restockAs(k.id, item.id, '5');
        expect(again).toEqual(first);
        expect(await stockOf(item.id)).toBe(15);
        expect(await ledgerCount()).toBe(1);
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: k.id } })).toBe(1);
    });

    test('18. r40.7 proof C — ACKNOWLEDGED TERMINALITY: reuse replays the original operation only, or fails with a typed conflict; NEVER a new operation', async () => {
        const k = await createIntent('5');
        const first = await restockWith(k.id, '5', '2');
        await intents.acknowledge({ businessProfileId: biz.id, id: k.id });
        expect((await get(k.id)).status).toBe('ACKNOWLEDGED');
        // same payload: replay of the original committed operation
        const replayed = await restockWith(k.id, '5', '2');
        expect(replayed).toEqual(first);
        expect((await get(k.id)).status).toBe('ACKNOWLEDGED'); // untouched
        // a new payload (different cost): typed idempotency conflict
        await expect(restockWith(k.id, '5', '3')).rejects.toMatchObject({
            code: 'RESTOCK_IDEMPOTENCY_CONFLICT', statusCode: 409,
        });
        // a new payload (different quantity): typed payload binding conflict
        await expect(restockWith(k.id, '6', '2')).rejects.toMatchObject({
            code: 'RESTOCK_INTENT_PAYLOAD_MISMATCH', statusCode: 409,
        });
        // a new payload (different item): typed payload binding conflict
        const item2 = await db.inventoryItem.create({ data: {
            businessProfileId: biz.id, name: 'Rice', unit: 'bags',
            currentStock: 0, minimumStock: 0, costPerUnit: 10,
        } });
        await expect(restocks.restock({ businessProfileId: biz.id, itemId: item2.id, quantity: '5', idempotencyKey: k.id, costPerUnit: '2' }))
            .rejects.toMatchObject({ code: 'RESTOCK_INTENT_PAYLOAD_MISMATCH', statusCode: 409 });
        // NEVER a new operation: one op, one ledger row, one stock increment
        expect(await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id, idempotencyKey: k.id } })).toBe(1);
        expect(await ledgerCount()).toBe(1);
        expect(await stockOf(item.id)).toBe(15);
        expect(await stockOf(item2.id)).toBe(0);
        expect((await get(k.id)).status).toBe('ACKNOWLEDGED');
    });
});
