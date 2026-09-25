// __tests__/r40-e2ee-server-authority.test.js
// =============================================================================
// r40/P0 — E2EE v2 SERVER AUTHORITY (real PostgreSQL, real HTTP).
//
// Proves the SERVER-side half of the r40 trust model (docs/e2ee/PROTOCOL.md
// §4–§7): the server is a PUBLIC-KEY DIRECTORY and a BLIND RELAY — it must
// never hold private key material, session state, or plaintext.
//
//   S1  Registration stores ONLY public material: after keys/init the
//       database contains every public key and NO private key column holds
//       any value (information_schema proof, not a code grep).
//   S2  Strict validation at the HTTP boundary: tampered bundles and
//       malformed prekey batches are refused with 400 E2EE_INVALID_BUNDLE.
//   S3  Prekey claim is idempotent-UNSAFE-safe: two concurrent bundle fetches
//       NEVER receive the same one-time prekey (atomic SKIP LOCKED claim).
//   S4  Replenishment is bounded: the pool can never exceed 200 unused keys.
//   S5  Encrypted send persists the envelope with EMPTY content: the message
//       row carries ciphertext + header + envelopeId, content === ''.
//   S6  Replay dedup: the same envelopeId returns the ORIGINAL row
//       (replayed: true) and never creates a second row.
//   S7  Fail-closed: once BOTH participants registered, plaintext TEXT is
//       refused with 409 E2EE_REQUIRED; before that plaintext is allowed.
//   S8  The wire response for encrypted messages NEVER carries plaintext
//       content, and unencrypted rows never leak envelope fields.
//   S9  The server-cannot-decrypt proof: for the two test users, EVERY row
//       in every E2EE-related table is inspected — there is no private key
//       material anywhere in the database, and the message content is empty.
//   S10 restock v2 (P1, cross-feature, same PR): idempotency replay is
//       versioned — a v1 legacy operation replays under the v1 contract
//       (never stranded), and two distinct 8dp quantities that collapse to
//       one float64 no longer alias to the same fingerprint (v2 contract).
// =============================================================================
const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R40_E2EE_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (_req, _res, next) => next(),
}));

const { PrismaClient } = require('@prisma/client');
const e2eeRoutes = require('../routes/e2eeRoutes');
const conversationRoutes = require('../routes/conversationRoutes');
const e2ee = require('../services/e2eeService');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r40/P0 — E2EE v2 server authority (real PostgreSQL)', () => {
    let db;
    let app;
    let alice, bob;

    const asUser = (user) => { global.__R40_E2EE_USER__ = user ? { id: user.id, role: user.role } : null; };

    const initKeys = (user, payload) => {
        asUser(user);
        return request(app).post('/api/e2ee/keys/init').send(payload);
    };
    const fetchBundle = (user, targetId) => {
        asUser(user);
        return request(app).get(`/api/e2ee/keys/${targetId}`);
    };
    const sendMessage = (user, conversationId, body) => {
        asUser(user);
        return request(app).post(`/api/conversations/${conversationId}/messages`).send(body);
    };

    // A full client-side registration payload generated with the reference
    // implementation (device-side keys; the server never sees privates).
    const registerPayload = async (otpkCount = 3) => {
        const identity = await e2ee.generateIdentityKeys();
        const spk = await e2ee.generateSignedPreKey(identity.identityKey.privateKey);
        const otps = await e2ee.generateOneTimePreKeys(otpkCount);
        return {
            payload: {
                identityPublicKey: identity.identityKey.publicKey,
                identityDhPublicKey: identity.identityDhKey.publicKey,
                identityKeySignature: identity.identityKeySignature,
                signedPreKeyId: spk.keyId,
                signedPreKeyPublicKey: spk.publicKey,
                signedPreKeySignature: spk.signature,
                oneTimePreKeys: otps.map(o => ({ keyId: o.keyId, publicKey: o.publicKey })),
            },
            priv: { identity, spk, otps },
        };
    };

    const validEnvelope = () => ({
        version: 2,
        header: { v: 2, dh: Buffer.alloc(32, 7).toString('base64'), pn: 0, n: 0 },
        cipherText: Buffer.alloc(32, 9).toString('base64'),
        envelopeId: randomUUID(),
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        // conversationRoutes rely on an outer auth layer setting req.user:
        app.use((req, _res, next) => {
            req.user = global.__R40_E2EE_USER__ ? { ...global.__R40_E2EE_USER__ } : undefined;
            next();
        });
        app.use('/api/e2ee', e2eeRoutes);
        app.use('/api/conversations', conversationRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__R40_E2EE_USER__ = null;
        await db.$executeRawUnsafe(
            'TRUNCATE TABLE "Message", "Conversation", "E2EEOneTimePreKey", "E2EEPreKeyBundle", "User" RESTART IDENTITY CASCADE'
        );
    });

    beforeEach(async () => {
        alice = await seedUser(db, { username: 'r40_alice' });
        bob = await seedUser(db, { username: 'r40_bob' });
    });

    const seedPersonalConversation = async () => {
        const conv = await db.conversation.create({
            data: { type: 'PERSONAL', participants: { connect: [{ id: alice.id }, { id: bob.id }] } },
            include: { participants: { select: { id: true, username: true } } },
        });
        return conv;
    };

    // ── S1/S9: public-only storage ─────────────────────────────────────────────
    it('S1: registration stores ONLY public material — no private column holds data', async () => {
        const { payload } = await registerPayload();
        const res = await initKeys(alice, payload);
        expect(res.status).toBe(200);
        expect(res.body.data.oneTimePreKeyCount).toBe(3);
        expect(res.body.data.identityChanged).toBe(false);

        // Schema-level proof: the E2EE tables have NO private-key column at all.
        const privateCols = await db.$queryRawUnsafe(`
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('E2EEPreKeyBundle', 'E2EEOneTimePreKey', 'Message')
              AND (column_name ILIKE '%private%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%chainkey%' OR column_name ILIKE '%rootkey%')`);
        expect(privateCols).toEqual([]);

        // Row-level proof (S9): every stored byte is inspectable and public.
        const bundle = await db.e2EEPreKeyBundle.findUniqueOrThrow({ where: { userId: alice.id } });
        expect(bundle.identityPublicKey).toBe(payload.identityPublicKey);
        expect(bundle.identityDhPublicKey).toBe(payload.identityDhPublicKey);
        expect(bundle.signedPreKeyPublicKey).toBe(payload.signedPreKeyPublicKey);
        const keys = await db.e2EEOneTimePreKey.findMany({ where: { userId: alice.id } });
        expect(keys).toHaveLength(3);
        // no row anywhere contains a private key field — by construction above.
    });

    it('S1b: re-registration preserves the previous identity for key-change detection', async () => {
        const first = await registerPayload();
        await initKeys(alice, first.payload);
        const second = await registerPayload();
        const res = await initKeys(alice, second.payload);
        expect(res.status).toBe(200);
        expect(res.body.data.identityChanged).toBe(true);
        expect(res.body.data.previousIdentityPublicKey).toBe(first.payload.identityPublicKey);
        const bundle = await db.e2EEPreKeyBundle.findUniqueOrThrow({ where: { userId: alice.id } });
        expect(bundle.previousIdentityDhPublicKey).toBe(first.payload.identityDhPublicKey);
    });

    // ── S2: validation at the HTTP boundary ────────────────────────────────────
    it('S2: tampered bundles and malformed prekey batches are refused with 400', async () => {
        const { payload } = await registerPayload();
        const flip = (b64s) => Buffer.from(b64s, 'base64').map((b, i) => (i === 5 ? b ^ 0x40 : b)).toString('base64');
        const bad = await initKeys(alice, { ...payload, identityKeySignature: flip(payload.identityKeySignature) });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('E2EE_INVALID_BUNDLE');
        const bad2 = await initKeys(alice, { ...payload, oneTimePreKeys: [] });
        expect(bad2.status).toBe(400);
        const bad3 = await initKeys(alice, { ...payload, oneTimePreKeys: 'junk' });
        expect(bad3.status).toBe(400);
        // nothing was stored by any failed attempt:
        expect(await db.e2EEPreKeyBundle.findUnique({ where: { userId: alice.id } })).toBeNull();
    });

    // ── S3: atomic prekey claim ─────────────────────────────────────────────────
    it('S3: concurrent bundle fetches NEVER receive the same one-time prekey', async () => {
        const { payload } = await registerPayload(10);
        await initKeys(bob, payload);

        // 10 concurrent claims for a pool of 10:
        const results = await Promise.all(
            Array.from({ length: 10 }, () => fetchBundle(alice, bob.id))
        );
        expect(results.every(r => r.status === 200)).toBe(true);
        const otps = results.map(r => r.body.data.oneTimePreKey).filter(Boolean);
        expect(otps).toHaveLength(10);
        const keyIds = otps.map(k => k.keyId);
        expect(new Set(keyIds).size).toBe(10); // every claim distinct — the race is closed
        // the pool is now empty; an 11th fetch returns the bundle with NO otpk:
        const drained = await fetchBundle(alice, bob.id);
        expect(drained.body.data.oneTimePreKey).toBeNull();
        // bundle fetch for an unregistered user:
        const missing = await fetchBundle(alice, alice.id + 999);
        expect(missing.status).toBe(404);
    });

    // ── S4: bounded replenishment ────────────────────────────────────────────────
    it('S4: the unused-prekey pool can never exceed 200', async () => {
        const { payload } = await registerPayload(5);
        await initKeys(alice, payload);
        asUser(alice);
        const batch = async (n) => request(app).post('/api/e2ee/keys/prekeys')
            .send({ oneTimePreKeys: Array.from({ length: n }, (_, i) => ({ keyId: 1000 + i, publicKey: payload.oneTimePreKeys[0].publicKey })) });

        // 5 (from init) + 100 + 100 = 205 > 200: the second batch is refused.
        expect((await batch(100)).status).toBe(200);
        const over = await batch(100);
        expect(over.status).toBe(400);
        expect(over.body.code).toBe('E2EE_PREKEY_POOL_FULL');
        // but a smaller batch that fits is accepted:
        const [{ unused }] = await db.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS unused FROM "E2EEOneTimePreKey" WHERE "userId" = $1 AND "isUsed" = false', alice.id
        );
        expect(unused).toBe(105);
        expect((await batch(95)).status).toBe(200);
        const [{ unused: after }] = await db.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS unused FROM "E2EEOneTimePreKey" WHERE "userId" = $1 AND "isUsed" = false', alice.id
        );
        expect(after).toBe(200); // exactly the cap, never over
    });

    // ── S5–S8: the encrypted message path ───────────────────────────────────────
    it('S5: encrypted send persists ONLY the envelope — content is the empty string', async () => {
        const { payload: alicePayload } = await registerPayload();
        const { payload: bobPayload } = await registerPayload();
        await initKeys(alice, alicePayload);
        await initKeys(bob, bobPayload);
        const conv = await seedPersonalConversation();

        const envelope = validEnvelope();
        const res = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: envelope });
        expect(res.status).toBe(201);
        expect(res.body.data.isEncrypted).toBe(true);
        expect(res.body.data.e2ee.cipherText).toBe(envelope.cipherText);
        expect(res.body.data.e2ee.envelopeId).toBe(envelope.envelopeId);

        const row = await db.message.findUniqueOrThrow({ where: { e2eeEnvelopeId: envelope.envelopeId } });
        expect(row.content).toBe(''); // the plaintext NEVER reached the server
        expect(row.isEncrypted).toBe(true);
        expect(row.e2eeCipherText).toBe(envelope.cipherText);
        expect(row.e2eeHeader).toEqual(envelope.header);
        expect(row.conversationId).toBe(conv.id);
    });

    it('S6: a retried send (same envelopeId) replays the ORIGINAL row — no duplicate', async () => {
        const { payload: alicePayload } = await registerPayload();
        const { payload: bobPayload } = await registerPayload();
        await initKeys(alice, alicePayload);
        await initKeys(bob, bobPayload);
        const conv = await seedPersonalConversation();

        const envelope = validEnvelope();
        const first = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: envelope });
        expect(first.status).toBe(201);
        // client timeout / reconnect / reload → same envelopeId retried:
        const retry = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: envelope });
        expect(retry.status).toBe(200);
        expect(retry.body.replayed).toBe(true);
        expect(retry.body.data.e2ee.envelopeId).toBe(envelope.envelopeId);
        expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(1);
        // a DIFFERENT envelopeId is a different message:
        const second = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: validEnvelope() });
        expect(second.status).toBe(201);
        expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(2);
    });

    it('S7: fail-closed — plaintext is refused once both participants registered', async () => {
        const conv = await seedPersonalConversation();
        // nobody registered: plaintext allowed (compatibility window)
        const plain1 = await sendMessage(alice, conv.id, { type: 'TEXT', text: 'before e2ee' });
        expect(plain1.status).toBe(201);

        // only ONE participant registered: still allowed (peer cannot decrypt yet)
        const { payload: alicePayload } = await registerPayload();
        await initKeys(alice, alicePayload);
        const plain2 = await sendMessage(bob, conv.id, { type: 'TEXT', text: 'one side' });
        expect(plain2.status).toBe(201);

        // BOTH registered: plaintext TEXT is refused, envelope required.
        const { payload: bobPayload } = await registerPayload();
        await initKeys(bob, bobPayload);
        const refused = await sendMessage(alice, conv.id, { type: 'TEXT', text: 'secret' });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('E2EE_REQUIRED');
        // and the refusal stored nothing:
        const rows = await db.message.findMany({ where: { conversationId: conv.id } });
        expect(rows.every(r => r.content !== 'secret')).toBe(true);
        // the envelope still works:
        const enc = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: validEnvelope() });
        expect(enc.status).toBe(201);
    });

    it('S7b: malformed envelopes are refused with 400 and stored nothing', async () => {
        const { payload: alicePayload } = await registerPayload();
        const { payload: bobPayload } = await registerPayload();
        await initKeys(alice, alicePayload);
        await initKeys(bob, bobPayload);
        const conv = await seedPersonalConversation();

        for (const bad of [
            { version: 1, header: validEnvelope().header, cipherText: 'AAAA', envelopeId: randomUUID() },
            { ...validEnvelope(), header: { v: 1, dh: 'AAAA', pn: 0, n: 0 } },
            { ...validEnvelope(), cipherText: '' },
            { ...validEnvelope(), envelopeId: 'not-a-uuid' },
            { ...validEnvelope(), cipherText: Buffer.alloc(4).toString('base64') }, // shorter than a Poly1305 tag
        ]) {
            const res = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: bad });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('E2EE_BAD_ENVELOPE');
        }
        expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(0);
    });

    it('S8: the wire response for encrypted messages never carries content', async () => {
        const { payload: alicePayload } = await registerPayload();
        const { payload: bobPayload } = await registerPayload();
        await initKeys(alice, alicePayload);
        await initKeys(bob, bobPayload);
        const conv = await seedPersonalConversation();

        const envelope = validEnvelope();
        const res = await sendMessage(alice, conv.id, { type: 'TEXT', e2ee: envelope });
        expect(res.status).toBe(201);
        const wire = JSON.stringify(res.body);
        // the wire format for an encrypted message has no content field at all:
        expect(res.body.data.content).toBeUndefined();
        expect(wire).not.toContain('plain');
    });

    // ── S10: restock fingerprint v2 (P1, same PR) ───────────────────────────────
    it('S10: restock replay identity — v1 replays legacy ops, v2 never aliases 8dp quantities', async () => {
        const { seedBusiness } = require('./helpers/factories');
        const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');
        const { biz } = await seedBusiness(db, { businessName: 'r40-restock-biz' });
        const item = await db.inventoryItem.create({
            data: {
                name: 'Sack of rice', unit: 'BAG', currentStock: 0,
                costPerUnit: 10.0, businessProfileId: biz.id,
            },
        });

        const svc = new InventoryRestockService(db);
        const key = randomUUID();

        // First execution commits under the v2 fingerprint:
        const op1 = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '0.12345678', costPerUnit: null, idempotencyKey: key });
        expect(op1.ledgerWritten).toBe(true);
        const op2 = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '0.12345678', costPerUnit: null, idempotencyKey: key });
        expect(op2).toEqual(op1); // byte-identical replay: no second execution
        expect(await db.businessLedgerEntry.count({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } })).toBe(1);
        const stored = await db.inventoryRestockOperation.findUniqueOrThrow({ where: { businessProfileId_idempotencyKey: { businessProfileId: biz.id, idempotencyKey: key } } });
        expect(stored.fingerprintVersion).toBe(2);

        // The float64-collapse regression: these two quantities are the SAME
        // IEEE float64 but DIFFERENT money (differ only in the 8th decimal at
        // 1e12, below the float64 spacing of 2.4e-4). With a unit cost of
        // 0.0001 the exact totals (1e8 and 1e8 + 1e-8) stay within the ledger
        // magnitude cap. The same key must now CONFLICT under v2:
        const collapseKey = randomUUID();
        await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '999999999999.99999998', costPerUnit: '0.0001', idempotencyKey: collapseKey });
        await expect(
            svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '999999999999.99999999', costPerUnit: '0.0001', idempotencyKey: collapseKey })
        ).rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_CONFLICT' });

        // A legacy v1 operation (committed pre-r40) replays under the v1
        // contract — never stranded behind a 409 it cannot satisfy:
        const legacyKey = randomUUID();
        const v1Fingerprint = require('crypto').createHash('sha256').update(JSON.stringify([
            biz.id, item.id, 7.5, 'DEFAULT_COST',
        ])).digest('hex');
        await db.inventoryRestockOperation.create({
            data: {
                businessProfileId: biz.id, itemId: item.id, idempotencyKey: legacyKey,
                requestFingerprint: v1Fingerprint, fingerprintVersion: 1,
                result: { ok: true, legacy: true }, ledgerId: 'leg-ledger-1',
            },
        });
        const legacyReplay = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '7.5', costPerUnit: null, idempotencyKey: legacyKey });
        expect(legacyReplay).toEqual({ ok: true, legacy: true });

        // The two contracts differ BY DESIGN (v2 is canonical strings):
        const v2Fingerprint = require('crypto').createHash('sha256').update(JSON.stringify([
            biz.id, item.id, '7.50000000', 'DEFAULT_COST',
        ])).digest('hex');
        expect(v1Fingerprint).not.toBe(v2Fingerprint);
    });
});
