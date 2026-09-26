'use strict';
// =============================================================================
// r40/P1 — RESTOCK FINGERPRINT VERSIONING (real PostgreSQL).
//
// The v1 restock request fingerprint was computed from FLOAT-NORMALIZED
// economics (Number(quantity)); two different purchases that differ only
// beyond double precision collided, so the second request "replayed" and
// silently returned the FIRST operation's result (stock and ledger wrong,
// no error). v2 fingerprints the exact decimal strings.
//
// Migration safety is the point of VERSIONING (r40): each operation stores
// the fingerprint version it committed under; replay verifies against that
// version, so pre-r40 operations keep replaying and can never be stranded
// behind a 409. New operations commit under v2.
//
// Proofs:
//  1. New operations commit fingerprintVersion=2 with an exact digest.
//  2. Same request replays (result returned, no re-execution).
//  3. A seeded PRE-r40 v1 operation (float digest, version 1) still
//     replays — no stranded idempotency claims.
//  4. The v1 collision is fixed: two quantities identical under double
//     precision but different as exact decimals now conflict (409) —
//     and never silently return the wrong operation again.
//  5. A genuinely different economics request with the same key conflicts.
// =============================================================================

const crypto = require('crypto');
const { PrismaClient, Prisma: P } = require('@prisma/client');
const { seedBusiness } = require('./helpers/factories');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r40/P1 — restock fingerprint versioning (PostgreSQL)', () => {
    let db, biz, item, svc;

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

    // The v1 digest formula, kept verbatim for seeding legacy rows.
    const v1Digest = (quantity, hasCost, cost) => crypto.createHash('sha256').update(JSON.stringify([
        biz.id, item.id, Number(quantity), hasCost ? Number(cost) : 'DEFAULT_COST',
    ])).digest('hex');

    const restock = (key, extra = {}) => svc.restock({
        businessProfileId: biz.id, itemId: item.id, quantity: 1, idempotencyKey: key, ...extra,
    });

    test('1/2. new operations commit under v2 and replay without re-execution', async () => {
        const first = await restock('fpv2-1', { quantity: '2.5', costPerUnit: '3.2' });
        const row = await db.inventoryRestockOperation.findUnique({
            where: { businessProfileId_idempotencyKey: { businessProfileId: biz.id, idempotencyKey: 'fpv2-1' } },
        });
        expect(row.fingerprintVersion).toBe(2);
        expect(row.requestFingerprint).toBe(crypto.createHash('sha256').update(JSON.stringify([
            biz.id, item.id, '2.5', '3.2',
        ])).digest('hex'));
        // Replay: same key, same economics → same result, single ledger entry.
        const again = await restock('fpv2-1', { quantity: '2.5', costPerUnit: '3.2' });
        expect(again).toEqual(first);
        const ops = await db.inventoryRestockOperation.count({ where: { businessProfileId: biz.id } });
        expect(ops).toBe(1);
        const ledgers = await db.businessLedgerEntry.count({ where: { sourceType: 'INVENTORY_RESTOCK', sourceId: row.id } });
        expect(ledgers).toBe(1);
        // The same economics as a JSON NUMBER replay identically (wire forms
        // are equivalent under exact decimals — 2.5 parses to exactly "2.5").
        const numericForm = await restock('fpv2-1', { quantity: 2.5, costPerUnit: 3.2 });
        expect(numericForm.operationId).toBe(first.operationId);
    });

    test('3. a pre-r40 v1 operation (float digest, no version) still replays', async () => {
        const legacyDigest = v1Digest('1.5', true, '2');
        const legacy = await db.inventoryRestockOperation.create({
            data: {
                id: 'legacy-op-1', businessProfileId: biz.id, itemId: item.id,
                idempotencyKey: 'legacy-key', requestFingerprint: legacyDigest, fingerprintVersion: 1,
                result: { ok: true, replayed: 'legacy' }, ledgerId: 'legacy-ledger',
            },
        });
        const out = await restock('legacy-key', { quantity: '1.5', costPerUnit: '2' });
        expect(out).toEqual({ ok: true, replayed: 'legacy' });
        // no re-execution: still exactly one operation for this key
        expect(await db.inventoryRestockOperation.count({ where: { id: legacy.id } })).toBe(1);
    });

    test('4. the v1 double-precision collision now conflicts instead of silently replaying', async () => {
        // Both quantities have ≤ 8 decimal places and are within magnitude
        // bounds, but are IDENTICAL under double precision:
        const a = '12345678901.000001';
        const b = '12345678901.000002';
        expect(Number(a)).toBe(Number(b)); // the v1 collision condition, reproduced
        const first = await restock('collide', { quantity: a, costPerUnit: '1' });
        // Same key, DIFFERENT (but float-identical) economics → 409, never a
        // silent replay of the first purchase.
        await expect(restock('collide', { quantity: b, costPerUnit: '1' }))
            .rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT' });
        // and the first operation is untouched
        const again = await restock('collide', { quantity: a, costPerUnit: '1' });
        expect(again.operationId).toBe(first.operationId);
    });

    test('5. genuinely different economics with the same key conflicts', async () => {
        await restock('diff-1', { quantity: '1', costPerUnit: '2' });
        await expect(restock('diff-1', { quantity: '2', costPerUnit: '2' }))
            .rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT' });
        await expect(restock('diff-1', { quantity: '1', costPerUnit: '3' }))
            .rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT' });
        // default-cost vs explicit-cost is a different request too
        await expect(restock('diff-1', { quantity: '1' }))
            .rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT' });
    });
});
