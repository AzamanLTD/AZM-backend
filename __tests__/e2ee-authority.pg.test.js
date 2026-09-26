'use strict';
// =============================================================================
// E2EE server-blind authority — REAL PostgreSQL proofs (P0, r40).
//
// Proves the database-bound invariants of docs/e2ee-protocol.md:
//   9.  Concurrent one-time prekey acquisition returns DISTINCT keys
//       (atomic UPDATE ... FOR UPDATE SKIP LOCKED claim).
//   10. Server-side code cannot decrypt an ordinary message from database
//       state alone (no private material exists anywhere in the DB).
//   11. The ordinary conversation API persists and returns the ciphertext
//       envelope, never plaintext, and refuses text+envelope payloads.
// Plus the registration/replenishment input gates (proof items F, G:
// bounded, integer-only, base64-32 validation; fail-closed signatures).
// =============================================================================

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, res, next) => { req.user = { id: req.get('x-test-user') ? parseInt(req.get('x-test-user'), 10) : 0 }; next(); },
    adminOnly: (req, res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    // The real protectActive composes auth + ban guard and sets req.user;
    // this mock mirrors that (see middleware/banGuardMiddleware.js).
    protectActive: (req, res, next) => {
        req.user = { id: req.get('x-test-user') ? parseInt(req.get('x-test-user'), 10) : 0 };
        next();
    },
}));

const express = require('express');
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const protocol = require('../services/e2ee/protocol');
const { E2EEKeyService, MAX_PREKEYS_PER_BATCH } = require('../services/e2ee/keyService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
const b64 = (x) => Buffer.from(x).toString('base64');

async function deviceKeys(n) {
    const sodium = await protocol.init();
    const det = (i) => sodium.randombytes_buf_deterministic(32, Buffer.alloc(32, i));
    return {
        signing: sodium.crypto_sign_seed_keypair(det(n)),
        identity: sodium.crypto_box_seed_keypair(det(n + 1)),
        spk: sodium.crypto_box_seed_keypair(det(n + 2)),
        otpk: sodium.crypto_box_seed_keypair(det(n + 3)),
    };
}

run('E2EE server-blind authority (real PostgreSQL)', () => {
    let db, app;
    let alice, bob;
    let aliceKeys, bobKeys;

    beforeAll(async () => {
        process.env.AZM_E2EE_ENABLED = 'true'; // P0-A gate: tests run with the surface enabled
        db = new PrismaClient();
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.set('prisma', db);
        app.use('/api/conversation', require('../routes/conversationRoutes'));
        app.use('/api/e2ee', require('../routes/e2eeRoutes'));
    });
    afterAll(async () => { await db.$disconnect(); });

    beforeEach(async () => {
        await db.message.deleteMany({});
        await db.conversation.deleteMany({});
        await db.e2eeOneTimePreKey.deleteMany({});
        await db.e2eeDevice.deleteMany({});
        await db.user.deleteMany({ where: { username: { in: ['e2ee-alice', 'e2ee-bob', 'e2ee-charlie', 'e2ee-dora'] } } });
        alice = await db.user.create({ data: { username: 'e2ee-alice', email: 'e2ee-alice@t.test', password: 'x' } });
        bob = await db.user.create({ data: { username: 'e2ee-bob', email: 'e2ee-bob@t.test', password: 'x' } });
        const conv = await db.conversation.create({
            data: { type: 'PERSONAL', participants: { connect: [{ id: alice.id }, { id: bob.id }] } },
        });
        app.locals.convId = conv.id;
    });

    const register = async (userId, keys, { otpkCount = 5, spkId = 1, forged = false, otpkOffset = 0, materialOffset = null } = {}) => {
        const sodium = await protocol.init();
        const signingPublicKey = b64(keys.signing.publicKey);
        const identityPublicKey = b64(keys.identity.publicKey);
        const bindingMsg = Buffer.concat([
            Buffer.from('azaman-e2ee-v1-device-bind|'),
            Buffer.from(identityPublicKey), Buffer.from('|'), Buffer.from(signingPublicKey),
        ]);
        const spkPub = b64(keys.spk.publicKey);
        const spkMsg = Buffer.concat([
            Buffer.from('azaman-e2ee-v1-spk|'), Buffer.from(String(spkId)),
            Buffer.from('|'), Buffer.from(spkPub),
        ]);
        const otpkKeys = [];
        const otpkPrivateBy = {}; // test-only: the device's local secret
        // otpkOffset shifts the keyId RANGE; materialOffset (default: same
        // as otpkOffset) shifts the key MATERIAL. Decoupled in r40.2: keyIds
        // are DEVICE-scoped, so a second device can legitimately reuse the
        // SAME keyId range with its OWN material — the tests below prove
        // exactly that rotation contract.
        const mat = materialOffset === null ? otpkOffset : materialOffset;
        for (let i = 0; i < otpkCount; i++) {
            const kp = sodium.crypto_box_seed_keypair(sodium.randombytes_buf_deterministic(32, Buffer.alloc(32, 200 + mat + i)));
            otpkKeys.push({ keyId: 1000 + otpkOffset + i, publicKey: b64(kp.publicKey) });
            otpkPrivateBy[1000 + otpkOffset + i] = b64(kp.privateKey);
        }
        return {
            otpkPrivateBy,
            deviceId: 'device-' + String(userId).padStart(4, '0'),
            signingPublicKey,
            identityPublicKey,
            identityBindingSignature: b64(sodium.crypto_sign_detached(bindingMsg, forged ? bobKeys && keys.signing.privateKey : keys.signing.privateKey)),
            signedPreKey: {
                keyId: spkId,
                publicKey: spkPub,
                signature: b64(sodium.crypto_sign_detached(spkMsg, keys.signing.privateKey)),
            },
            oneTimePreKeys: otpkKeys,
        };
    };

    test('F/G. registration persists PUBLIC keys only; DB has no private material columns', async () => {
        aliceKeys = await deviceKeys(1);
        bobKeys = await deviceKeys(2);
        const svc = new E2EEKeyService(db);
        const payload = await register(alice.id, aliceKeys);
        const result = await svc.registerDevice({ userId: alice.id, ...payload });
        expect(result.deviceId).toBe(payload.deviceId);

        const deviceColumns = await db.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'E2EEDevice'`);
        const colNames = deviceColumns.map((c) => c.column_name.toLowerCase());
        expect(colNames).not.toContain('privatekey');
        expect(colNames).not.toContain('rootkey');
        expect(colNames).not.toContain('chainkey');
        const otpkColumns = await db.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'E2EEOneTimePreKey'`);
        const otpkNames = otpkColumns.map((c) => c.column_name.toLowerCase());
        expect(otpkNames).not.toContain('privatekey');
        // the pre-r40 private-material tables are gone entirely
        const oldTables = await db.$queryRawUnsafe(
            `SELECT table_name FROM information_schema.tables WHERE table_name IN ('E2EEPreKeyBundle','E2EESession')`);
        expect(oldTables.length).toBe(0);
        // stored row is public-only
        const row = await db.e2eeDevice.findUnique({ where: { userId_deviceId: { userId: alice.id, deviceId: payload.deviceId } } });
        expect(row.identityPublicKey).toBe(payload.identityPublicKey);
        expect(Object.keys(row).every((k) => !/private/i.test(k))).toBe(true);
    });

    test('F/G. forged identity binding and forged prekey signature are rejected (fail-closed)', async () => {
        aliceKeys = await deviceKeys(3);
        bobKeys = await deviceKeys(4);
        const svc = new E2EEKeyService(db);
        const payload = await register(alice.id, aliceKeys);
        const forged = await register(alice.id, bobKeys, { forged: true });
        // binding signed by ANOTHER device's signing key
        await expect(svc.registerDevice({ userId: alice.id, ...payload, identityBindingSignature: forged.identityBindingSignature }))
            .rejects.toMatchObject({ code: 'E2EE_BINDING_INVALID' });
        // valid binding but SPK signature from another device
        await expect(svc.registerDevice({ userId: alice.id, ...payload, signedPreKey: { ...payload.signedPreKey, signature: forged.signedPreKey.signature } }))
            .rejects.toMatchObject({ code: 'E2EE_SPK_SIGNATURE_INVALID' });
        // no device row was persisted by rejected registrations
        expect(await db.e2eeDevice.count({ where: { userId: alice.id } })).toBe(0);
    });

    test('F. prekey replenishment input is strictly bounded and validated', async () => {
        const svc = new E2EEKeyService(db);
        aliceKeys = await deviceKeys(7);
        const devPayload = await register(alice.id, aliceKeys);
        await svc.registerDevice({ userId: alice.id, ...devPayload });
        const mk = (i) => ({ keyId: i, publicKey: b64(Buffer.alloc(32, i)) });
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: 'nope' })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [] })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: Array.from({ length: MAX_PREKEYS_PER_BATCH + 1 }, (_, i) => mk(i)) })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: -1, publicKey: mk(1).publicKey }] })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 1.5, publicKey: mk(1).publicKey }] })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 1e18, publicKey: mk(1).publicKey }] })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 1, publicKey: 'not-base64' }] })).rejects.toThrow();
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 1, publicKey: b64(Buffer.alloc(31)) }] })).rejects.toThrow();
        const ok = await svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [mk(50), mk(51)] });
        expect(ok.count).toBe(2);
        expect(ok.inserted).toBe(2);
        // replenishing the SAME keys with the SAME material is idempotent (P1-D)
        const again = await svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [mk(50), mk(51)] });
        expect(again.inserted).toBe(0);
        // the same keyId with DIFFERENT material is a typed conflict (P1-D):
        // stable IDs must never silently swap key material.
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 50, publicKey: b64(Buffer.alloc(32, 99)) }] }))
            .rejects.toMatchObject({ code: 'E2EE_PREKEY_CONFLICT' });
        // the original material is INTACT after the refused replacement
        const row = await db.e2eeOneTimePreKey.findUnique({ where: { userId_deviceId_keyId: { userId: alice.id, deviceId: devPayload.deviceId, keyId: 50 } } });
        expect(row.publicKey).toBe(b64(Buffer.alloc(32, 50)));
    });

    test('9. concurrent one-time prekey claims return DISTINCT keys (atomic SKIP LOCKED)', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(bob.id, bobKeys || (bobKeys = await deviceKeys(2)), { otpkCount: 20 });
        await svc.registerDevice({ userId: bob.id, ...payload });

        const bundles = await Promise.all(Array.from({ length: 20 }, () => svc.fetchBundle(bob.id, { claimantId: alice.id })));
        const claimedIds = bundles.map((b) => b.oneTimePreKey && b.oneTimePreKey.keyId).filter(Boolean);
        expect(claimedIds.length).toBe(20);
        expect(new Set(claimedIds).size).toBe(20); // every concurrent caller got a DIFFERENT key
        const remaining = await db.e2eeOneTimePreKey.count({ where: { userId: bob.id, isUsed: false } });
        expect(remaining).toBe(0);
        // subsequent fetches degrade to no one-time prekey (no crash)
        const drained = await svc.fetchBundle(bob.id, { claimantId: alice.id });
        expect(drained.oneTimePreKey).toBeNull();
        expect(drained.signedPreKey.publicKey).toBe(payload.signedPreKey.publicKey);
    });

    test('10/11. conversation API persists/returns the opaque envelope; plaintext is refused; DB state alone cannot decrypt', async () => {
        // Register real devices for both users so the envelope is realistic.
        aliceKeys = await deviceKeys(11);
        bobKeys = await deviceKeys(12);
        const svc = new E2EEKeyService(db);
        const alicePayload = await register(alice.id, aliceKeys);
        const bobPayload = await register(bob.id, bobKeys);
        await svc.registerDevice({ userId: alice.id, ...alicePayload });
        await svc.registerDevice({ userId: bob.id, ...bobPayload });

        // Full client-side session: Alice fetches Bob's bundle, X3DH, ratchet.
        const bundle = await svc.fetchBundle(bob.id, { claimantId: alice.id });
        const sodium = await protocol.init();
        // verify bundle signatures client-side before use (contract §4)
        expect(protocol.verifySignedPreKeySignature({
            signingPublicKeyB64: bundle.signingPublicKey,
            signedPreKeyId: bundle.signedPreKey.keyId,
            signedPreKeyPublicKeyB64: bundle.signedPreKey.publicKey,
            signatureB64: bundle.signedPreKey.signature,
        })).toBe(true);

        const init = await protocol.initiateX3DH({
            ourIdentityPrivateKeyB64: b64(aliceKeys.identity.privateKey),
            theirIdentityPublicKeyB64: bundle.identityPublicKey,
            theirSignedPreKeyPublicKeyB64: bundle.signedPreKey.publicKey,
            theirOneTimePreKeyPublicKeyB64: bundle.oneTimePreKey && bundle.oneTimePreKey.publicKey,
        });
        // P1-F context binding: conversation + sender device + both identity keys
        const aliceCtx = {
            conversationId: app.locals.convId,
            senderDeviceId: alicePayload.deviceId,
            senderIdentityKey: b64(aliceKeys.identity.publicKey),
            recipientIdentityKey: bundle.identityPublicKey,
        };
        const aliceSession = await protocol.DoubleRatchetSession.initiator(init.sharedKey, bundle.signedPreKey.publicKey);
        const plaintext = 'bank details: not the server business';
        const m = aliceSession.encrypt(plaintext, aliceCtx);
        const envelope = {
            v: 1,
            deviceId: alicePayload.deviceId,
            ik: b64(aliceKeys.identity.publicKey),
            ek: b64(init.ephemeralPublicKey),
            spkId: bundle.signedPreKey.keyId,
            otpkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null,
            h: { dh: m.header.dh, pn: m.header.pn, n: m.header.n },
            nonce: b64(m.nonce),
            ct: b64(m.ciphertext),
        };

        // ── POST the envelope: the API must persist ciphertext only ──
        const post = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: envelope });
        expect(post.status).toBe(201);
        expect(post.body.success).toBe(true);
        expect(post.body.data.isE2EE).toBe(true);
        expect(post.body.data.e2eeEnvelope).toMatchObject({ v: 1, ct: envelope.ct });
        expect(post.body.data.text).toBe('');

        // plaintext + envelope together must be refused (no silent leak path)
        const leak = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', text: 'sneaky plaintext', e2ee: envelope });
        expect(leak.status).toBe(400);

        // malformed envelope shapes are rejected
        const bad = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { v: 2, ct: 'x' } });
        expect(bad.status).toBe(400);

        // ── GET: the API returns the envelope, never plaintext ──
        const list = await request(app)
            .get(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(bob.id));
        expect(list.status).toBe(200);
        const msg = list.body.data.find((x) => x.isE2EE);
        expect(msg.e2eeEnvelope.ct).toBe(envelope.ct);
        expect(msg.e2eeEnvelope.h.n).toBe(m.header.n);
        expect(msg.text).toBe('');

        // ── INVARIANT 10: reconstruct EVERYTHING the server can see and try
        // to decrypt. Database state alone must yield nothing.
        const dbMessage = await db.message.findFirst({ where: { conversationId: app.locals.convId }, orderBy: { createdAt: 'desc' } });
        expect(dbMessage.content).toBe(''); // no plaintext persisted
        expect(dbMessage.e2eeEnvelope.ct).toBe(envelope.ct);
        const allDevices = await db.e2eeDevice.findMany();
        const allPrekeys = await db.e2eeOneTimePreKey.findMany();
        const serverVisibleKeys = allDevices.map((d) => d.identityPublicKey).concat(allPrekeys.map((k) => k.publicKey));
        expect(serverVisibleKeys.length).toBeGreaterThan(0);
        // the envelope decrypts ONLY with the recipient's PRIVATE key material,
        // which by construction does not exist anywhere in the database:
        const privMaterial = JSON.stringify([allDevices, allPrekeys]);
        expect(/private/i.test(privMaterial)).toBe(false);
        // Attempt a session using ONLY server-visible material (public keys
        // stand in for private keys — everything the database can offer an
        // attacker). X25519 accepts the bytes, so the attacker gets A session
        // — but the WRONG one: the derived secret differs from the honest
        // secret and the envelope fails authentication under it.
        const fakeResp = await protocol.acceptX3DH({
            ourIdentityPrivateKeyB64: b64(bobKeys.identity.publicKey), // public key as "private" — what the DB offers
            ourSignedPreKeyPrivateKeyB64: bundle.signedPreKey.publicKey,
            theirIdentityPublicKeyB64: envelope.ik,
            theirEphemeralPublicKeyB64: envelope.ek,
        });
        expect(fakeResp.sharedKey.equals(init.sharedKey)).toBe(false); // different secret
        const fakeSession = await protocol.DoubleRatchetSession.responder(fakeResp.sharedKey, bobKeys.spk);
        expect(() => fakeSession.decrypt(
            { header: { dh: envelope.h.dh, pn: envelope.h.pn, n: envelope.h.n }, nonce: Buffer.from(envelope.nonce, 'base64'), ciphertext: Buffer.from(envelope.ct, 'base64') },
            aliceCtx,
        )).toThrow(); // ciphertext does NOT authenticate under any server-visible material
        // the honest recipient path DOES decrypt (session key exists only on Bob's device)
        const respShared = await protocol.acceptX3DH({
            ourIdentityPrivateKeyB64: b64(bobKeys.identity.privateKey),
            ourSignedPreKeyPrivateKeyB64: b64(bobKeys.spk.privateKey),
            // the private half of the one-time prekey the bundle claim marked
            // used — held ONLY on Bob's device, never in the database
            ourOneTimePreKeyPrivateKeyB64: bobPayload.otpkPrivateBy[envelope.otpkId],
            theirIdentityPublicKeyB64: envelope.ik,
            theirEphemeralPublicKeyB64: envelope.ek,
        });
        const bobSession = await protocol.DoubleRatchetSession.responder(respShared.sharedKey, bobKeys.spk);
        expect(bobSession.decrypt(
            { header: { dh: envelope.h.dh, pn: envelope.h.pn, n: envelope.h.n }, nonce: Buffer.from(envelope.nonce, 'base64'), ciphertext: Buffer.from(envelope.ct, 'base64') },
            aliceCtx,
        )).toBe(plaintext);
    });

    test('legacy plaintext path still works for non-E2EE clients (explicit mode)', async () => {
        const post = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', text: 'plain hello' });
        expect(post.status).toBe(201);
        expect(post.body.data.text).toBe('plain hello');
        expect(post.body.data.isE2EE).toBe(false);
    });

    test('P0-C. one active device per user: a second registration retires the first and rebinds prekeys', async () => {
        const svc = new E2EEKeyService(db);
        aliceKeys = await deviceKeys(21);
        // r40.2: Device B deliberately reuses the SAME keyId range (1000..1002)
        // as Device A — with its OWN material. KeyIds are device-scoped, so
        // this must be accepted, not a conflict.
        const payloadA = await register(alice.id, aliceKeys, { otpkCount: 3, otpkOffset: 0, materialOffset: 0 });
        payloadA.deviceId = 'device-rotation-aaa';
        await svc.registerDevice({ userId: alice.id, ...payloadA });

        const bob2 = await deviceKeys(22);
        const payloadB = await register(alice.id, bob2, { otpkCount: 3, otpkOffset: 0, materialOffset: 300 });
        payloadB.deviceId = 'device-rotation-bbb';
        await svc.registerDevice({ userId: alice.id, ...payloadB });
        // Device B's keyIds COEXIST with retired Device A's keyIds
        const bRows = await db.e2eeOneTimePreKey.findMany({
            where: { userId: alice.id, deviceId: 'device-rotation-bbb', isUsed: false } });
        expect(bRows.map((r) => r.keyId).sort()).toEqual([1000, 1001, 1002]);

        // invariant: exactly ONE active device
        const active = await db.e2eeDevice.findMany({ where: { userId: alice.id, isActive: true } });
        expect(active.length).toBe(1);
        expect(active[0].deviceId).toBe('device-rotation-bbb');

        // the old device's pending prekeys are consumed, not handed out
        const stale = await db.e2eeOneTimePreKey.findMany({
            where: { userId: alice.id, isUsed: true, deviceId: 'device-rotation-aaa' } });
        expect(stale.length).toBe(3);

        // every bundle + claimed OTP belongs to the ACTIVE device only
        const bundle = await svc.fetchBundle(alice.id, { claimantId: bob.id });
        expect(bundle.deviceId).toBe('device-rotation-bbb');
        const otpRow = await db.e2eeOneTimePreKey.findFirst({
            where: { userId: alice.id, deviceId: bundle.deviceId, keyId: bundle.oneTimePreKey.keyId } });
        expect(otpRow.deviceId).toBe('device-rotation-bbb');
    });

    test('r40.2. OTP keyIds are DEVICE-scoped: rotation reuses keyIds across devices with own material', async () => {
        const svc = new E2EEKeyService(db);
        const keysA = await deviceKeys(31);
        // Device A registers with keyId 1000 (its own material)
        const payloadA = await register(alice.id, keysA, { otpkCount: 1, otpkOffset: 0, materialOffset: 600 });
        payloadA.deviceId = 'device-scope-aaa';
        await svc.registerDevice({ userId: alice.id, ...payloadA });

        // (1) Device A keyId=1000 accepted; re-registering the same device with
        // the SAME material stays idempotent (no conflict, no duplicate row)
        await svc.registerDevice({ userId: alice.id, ...payloadA });
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, deviceId: 'device-scope-aaa', keyId: 1000 } })).toBe(1);

        // (2) replenishing keyId=1000 with the same material: idempotent
        const same = await svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [payloadA.oneTimePreKeys[0]] });
        expect(same.inserted).toBe(0);

        // (3) replenishing keyId=1000 with DIFFERENT material on the SAME
        // device: typed conflict (stable IDs never swap material)
        await expect(svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 1000, publicKey: b64(Buffer.alloc(32, 77)) }] }))
            .rejects.toMatchObject({ code: 'E2EE_PREKEY_CONFLICT' });

        // (4) Device B rotates in reusing keyId=1000 with ITS OWN material —
        // accepted: retired Device A's keyId=1000 does NOT block Device B
        const keysB = await deviceKeys(32);
        const payloadB = await register(alice.id, keysB, { otpkCount: 1, otpkOffset: 0, materialOffset: 700 });
        payloadB.deviceId = 'device-scope-bbb';
        await svc.registerDevice({ userId: alice.id, ...payloadB });

        // both rows coexist: identity is (userId, deviceId, keyId)
        const rows = await db.e2eeOneTimePreKey.findMany({ where: { userId: alice.id, keyId: 1000 } });
        expect(rows.length).toBe(2);
        expect(new Set(rows.map((r) => r.deviceId))).toEqual(new Set(['device-scope-aaa', 'device-scope-bbb']));

        // (5) the bundle claims DEVICE B's keyId=1000 — never A's
        const bundle = await svc.fetchBundle(alice.id, { claimantId: bob.id });
        expect(bundle.deviceId).toBe('device-scope-bbb');
        expect(bundle.oneTimePreKey.keyId).toBe(1000);
        const claimedRow = await db.e2eeOneTimePreKey.findUnique({
            where: { userId_deviceId_keyId: { userId: alice.id, deviceId: 'device-scope-bbb', keyId: 1000 } } });
        expect(claimedRow.isUsed).toBe(true);
        // Device A's row was consumed at rotation, never re-handed-out
        const aRow = await db.e2eeOneTimePreKey.findUnique({
            where: { userId_deviceId_keyId: { userId: alice.id, deviceId: 'device-scope-aaa', keyId: 1000 } } });
        expect(aRow.isUsed).toBe(true);

        // (6) rotation still leaves EXACTLY ONE active device
        const active = await db.e2eeDevice.findMany({ where: { userId: alice.id, isActive: true } });
        expect(active.length).toBe(1);
        expect(active[0].deviceId).toBe('device-scope-bbb');

        // (7) concurrent replenishment stays first-material-wins per
        // (device, keyId): two different materials race for keyId=2000 on
        // the active device — exactly one wins, the DB holds ONE row.
        const mat1 = b64(Buffer.alloc(32, 201));
        const mat2 = b64(Buffer.alloc(32, 202));
        const results = await Promise.allSettled([
            svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 2000, publicKey: mat1 }] }),
            svc.replenishOneTimePreKeys({ userId: alice.id, oneTimePreKeys: [{ keyId: 2000, publicKey: mat2 }] }),
        ]);
        const settled = results.map((r) => r.status);
        expect(settled).toContain('fulfilled');
        const row2000 = await db.e2eeOneTimePreKey.findMany({
            where: { userId: alice.id, deviceId: 'device-scope-bbb', keyId: 2000 } });
        expect(row2000.length).toBe(1);
        expect([mat1, mat2]).toContain(row2000[0].publicKey);
        // If the loser reached the DB race it MUST have failed loudly (409
        // or unique violation), never silently replaced the winner.
        if (settled.includes('rejected')) {
            const rejected = results.find((r) => r.status === 'rejected');
            expect(['E2EE_PREKEY_CONFLICT', 'P2002']).toContain(rejected.reason.code || rejected.reason.message);
        }
    });

    test('r40.3. an UNRELATED authenticated caller cannot claim a bundle — OPKs are never consumed by strangers', async () => {
        const svc = new E2EEKeyService(db);
        // alice registers 8 one-time prekeys
        const payload = await register(alice.id, aliceKeys, { otpkCount: 8, otpkOffset: 0, materialOffset: 800 });
        await svc.registerDevice({ userId: alice.id, ...payload });
        // charlie is authenticated on the platform but shares NO conversation with alice
        const charlie = await db.user.create({ data: { username: 'e2ee-charlie', email: 'e2ee-charlie@t.test', password: 'x' } });

        // 30 hostile probes through the REAL route: every one is refused
        // (403 relationship gate, then 429 once the per-pair limiter trips),
        // and NOT A SINGLE one-time prekey is ever consumed.
        const responses = [];
        for (let i = 0; i < 30; i++) {
            responses.push(await request(app).get(`/api/e2ee/keys/${alice.id}`).set('x-test-user', String(charlie.id)));
        }
        const allRefused = responses.every((r) => r.status === 403 || r.status === 429);
        expect(allRefused).toBe(true);
        const refused403 = responses.filter((r) => r.status === 403);
        expect(refused403.length).toBeGreaterThan(0);
        expect(refused403[0].body.code).toBe('E2EE_NO_RELATIONSHIP');
        // ...and the direct service call is refused identically
        await expect(svc.fetchBundle(alice.id, { claimantId: charlie.id })).rejects.toMatchObject({ code: 'E2EE_NO_RELATIONSHIP' });
        // the victim's OPK pool is COMPLETE after unlimited hostile probing
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, isUsed: false } })).toBe(8);
    });

    test('r40.3. self-fetch is refused — a bundle is for a conversation peer', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(alice.id, aliceKeys, { otpkCount: 3, otpkOffset: 0, materialOffset: 810 });
        await svc.registerDevice({ userId: alice.id, ...payload });
        const r = await request(app).get(`/api/e2ee/keys/${alice.id}`).set('x-test-user', String(alice.id));
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('E2EE_NO_RELATIONSHIP');
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, isUsed: false } })).toBe(3);
    });

    test('r40.3. a conversation peer claims legitimately: bundle served, exactly ONE OPK consumed, claimedBy recorded', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(alice.id, aliceKeys, { otpkCount: 6, otpkOffset: 0, materialOffset: 820 });
        await svc.registerDevice({ userId: alice.id, ...payload });

        const r = await request(app).get(`/api/e2ee/keys/${alice.id}`).set('x-test-user', String(bob.id));
        expect(r.status).toBe(200);
        expect(r.body.data.deviceId).toBe(payload.deviceId);
        expect(r.body.data.oneTimePreKey).toBeTruthy();
        expect(r.body.data.oneTimePreKey.publicKey).toBeTruthy();
        // exactly ONE key consumed, and the claim is attributed to bob
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, isUsed: false } })).toBe(5);
        const claimedRow = await db.e2eeOneTimePreKey.findFirst({ where: { userId: alice.id, isUsed: true } });
        expect(claimedRow.claimedBy).toBe(bob.id);
        expect(claimedRow.usedAt).toBeTruthy();
    });

    test('r40.3. an ABUSIVE peer is bounded: the per-pair limiter caps OPK drain, the pool survives', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(alice.id, aliceKeys, { otpkCount: 20, otpkOffset: 0, materialOffset: 830 });
        await svc.registerDevice({ userId: alice.id, ...payload });

        // bob shares a conversation with alice — every claim below passes the
        // relationship gate. He hammers the endpoint to drain her pool.
        const statuses = [];
        for (let i = 0; i < 15; i++) {
            const r = await request(app).get(`/api/e2ee/keys/${alice.id}`).set('x-test-user', String(bob.id));
            statuses.push(r.status);
        }
        // first 10 claims are served (limiter max), then 429
        expect(statuses.slice(0, 10).every((st) => st === 200)).toBe(true);
        expect(statuses.slice(10).every((st) => st === 429)).toBe(true);
        // the drain is BOUNDED: exactly 10 keys consumed, 10 remain — the
        // victim can still establish sessions and replenish
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, isUsed: false } })).toBe(10);
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, claimedBy: bob.id } })).toBe(10);
        // a DIFFERENT peer is unaffected by bob's abuse (per-PAIR limiting)
        const dora = await db.user.create({ data: { username: 'e2ee-dora', email: 'e2ee-dora@t.test', password: 'x' } });
        await db.conversation.create({ data: { type: 'PERSONAL', participants: { connect: [{ id: dora.id }, { id: alice.id }] } } });
        const r = await request(app).get(`/api/e2ee/keys/${alice.id}`).set('x-test-user', String(dora.id));
        expect(r.status).toBe(200);
        expect(r.body.data.oneTimePreKey).toBeTruthy();
    });

    test('r40.4. fetchBundle FAILS CLOSED without a claimant — anonymous claims are refused', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(bob.id, bobKeys || (bobKeys = await deviceKeys(2)), { otpkCount: 3 });
        await svc.registerDevice({ userId: bob.id, ...payload });
        // no claimant → the consumptive call is refused before ANY state changes
        await expect(svc.fetchBundle(bob.id)).rejects.toMatchObject({ code: 'E2EE_CLAIMANT_REQUIRED' });
        await expect(svc.fetchBundle(bob.id, {})).rejects.toMatchObject({ code: 'E2EE_CLAIMANT_REQUIRED' });
        await expect(svc.fetchBundle(bob.id, { claimantId: 'bogus' })).rejects.toMatchObject({ code: 'E2EE_CLAIMANT_REQUIRED' });
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: bob.id, isUsed: false } })).toBe(3);
    });

    test('r40.4. bundle claim vs device ROTATION is serialized by the device row lock (deterministic)', async () => {
        const svc = new E2EEKeyService(db);
        const aPayload = await register(alice.id, aliceKeys, { otpkCount: 10, otpkOffset: 0, materialOffset: 900 });
        await svc.registerDevice({ userId: alice.id, ...aPayload });

        // A claim holds the active device row lock mid-flight (the exact
        // window where the pre-r40.4 two-step claim could return a device
        // that rotation retired underneath it).
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let signalLockHeld;
        const lockHeld = new Promise((resolve) => { signalLockHeld = resolve; });
        const heldClaim = db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "E2EEDevice" WHERE "userId" = ${alice.id} AND "isActive" = true FOR UPDATE`;
            signalLockHeld(); // PROVE the device row lock is held before racing
            await gate; // hold the device row lock — claim in flight
            return 'held';
        }, { timeout: 15000 });
        // CI latency (connection pool startup under load) can delay the
        // transaction past the whole observation window — wait for the lock
        // itself, not for a timer, so the proof stays deterministic.
        await lockHeld;

        // Rotation (A → B) and a concurrent service-level claim both fire
        // while the lock is held: both MUST block on the device row.
        const bKeys = await deviceKeys(42);
        const bPayload = await register(alice.id, bKeys, { otpkCount: 10, otpkOffset: 0, materialOffset: 910 });
        bPayload.deviceId = 'device-race-bbb';
        const rotationP = svc.registerDevice({ userId: alice.id, ...bPayload });
        const claimP = svc.fetchBundle(alice.id, { claimantId: bob.id });
        let rotationDone = false, claimDone = false;
        rotationP.then(() => { rotationDone = true; });
        claimP.then(() => { claimDone = true; });

        await new Promise((r) => setTimeout(r, 500));
        expect(rotationDone).toBe(false); // rotation CANNOT retire the claimed device mid-claim
        expect(claimDone).toBe(false); // the concurrent claim waits for the lock

        release();
        await heldClaim;
        await rotationP;
        const bundle = await claimP;
        // The row lock SERIALIZED claim and rotation — two safe outcomes only:
        //   • the claim won the lock first: it serves device A, which was
        //     STILL ACTIVE in its locked snapshot (rotation commits after);
        //   • the rotation won: the claim's locked re-check sees A retired and
        //     its statement snapshot predates B, so it FAILS CLOSED (null →
        //     404 "no device") instead of ever serving a retired device. The
        //     pre-r40.4 two-step claim had a THIRD outcome here — returning
        //     the already-retired A — which is now impossible.
        if (bundle === null) {
            const active0 = await db.e2eeDevice.findMany({ where: { userId: alice.id, isActive: true } });
            expect(active0[0].deviceId).toBe('device-race-bbb'); // rotation won
        } else {
            expect(bundle.deviceId).toBe(aPayload.deviceId); // claim won: A, active at snapshot
        }
        const active = await db.e2eeDevice.findMany({ where: { userId: alice.id, isActive: true } });
        expect(active.length).toBe(1);
        expect(active[0].deviceId).toBe('device-race-bbb');
        // after rotation committed, EVERY claim returns the new device only
        const after = await svc.fetchBundle(alice.id, { claimantId: bob.id });
        expect(after.deviceId).toBe('device-race-bbb');
    });

    test('r40.4. a claim blocked mid-rotation RE-CHECKS the device row and never serves the retired device', async () => {
        const svc = new E2EEKeyService(db);
        const aPayload = await register(alice.id, aliceKeys, { otpkCount: 5, otpkOffset: 0, materialOffset: 940 });
        aPayload.deviceId = 'device-recheck-aaa';
        await svc.registerDevice({ userId: alice.id, ...aPayload });

        // Material for device B (rotation target), created but not yet active.
        const bKeys = await deviceKeys(44);
        const bPayload = await register(alice.id, bKeys, { otpkCount: 5, otpkOffset: 0, materialOffset: 950 });
        bPayload.deviceId = 'device-recheck-bbb';

        // A rotation-in-flight holds device A's row lock: it retires A and
        // activates B in ONE transaction (exactly the two statements
        // registerDevice performs), then pauses before commit.
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let signalLockHeld;
        const lockHeld = new Promise((resolve) => { signalLockHeld = resolve; });
        const heldRotation = db.$transaction(async (tx) => {
            await tx.e2eeDevice.updateMany({ where: { userId: alice.id, isActive: true }, data: { isActive: false } });
            signalLockHeld(); // A's row lock is taken — prove it before racing
            await tx.e2eeDevice.create({
                data: { userId: alice.id, deviceId: 'device-recheck-bbb',
                    signingPublicKey: bPayload.signingPublicKey,
                    identityPublicKey: bPayload.identityPublicKey,
                    bindingSignature: bPayload.identityBindingSignature,
                    signedPreKeyId: bPayload.signedPreKey.keyId,
                    signedPreKeyPublicKey: bPayload.signedPreKey.publicKey,
                    signedPreKeySignature: bPayload.signedPreKey.signature,
                    isActive: true },
            });
            await tx.e2eeOneTimePreKey.createMany({
                data: bPayload.oneTimePreKeys.map((k) => ({ userId: alice.id, deviceId: 'device-recheck-bbb', keyId: k.keyId, publicKey: k.publicKey })),
            });
            await gate; // rotation transaction held open past its retirement
            return 'rotated';
        }, { timeout: 15000 });

        // The claim arrives WHILE the rotation transaction holds A's row
        // lock mid-flight. It must block on the lock, then RE-CHECK the row
        // under READ COMMITTED: A is retired, and the claim's statement
        // snapshot predates B — so the claim FAILS CLOSED (null → 404), the
        // only safe answer. It can NEVER serve the retired device A, and a
        // retried claim sees the new device.
        await lockHeld; // wait for the lock itself, not a timer
        const claimP = svc.fetchBundle(alice.id, { claimantId: bob.id });
        let claimDone = false;
        claimP.then(() => { claimDone = true; });
        await new Promise((r) => setTimeout(r, 400));
        expect(claimDone).toBe(false); // blocked on the device row lock

        release();
        await heldRotation;
        const bundle = await claimP;
        expect(bundle).toBeNull(); // FAILS CLOSED — never the retired device
        // no OPK was consumed by the refused claim
        expect(await db.e2eeOneTimePreKey.count({ where: { userId: alice.id, deviceId: 'device-recheck-bbb', isUsed: true } })).toBe(0);
        // the retry (fresh statement, post-rotation snapshot) serves the NEW
        // device with ITS OWN prekey — never mixed with A's material
        const retry = await svc.fetchBundle(alice.id, { claimantId: bob.id });
        expect(retry.deviceId).toBe('device-recheck-bbb');
        expect(retry.oneTimePreKey).toBeTruthy();
        const otpRow = await db.e2eeOneTimePreKey.findFirst({
            where: { userId: alice.id, deviceId: 'device-recheck-bbb', keyId: retry.oneTimePreKey.keyId, isUsed: true } });
        expect(otpRow).toBeTruthy();
        expect(otpRow.claimedBy).toBe(bob.id);
    });

    test('r40.4. concurrent claims under rotation NEVER mix devices or target a retired device (fuzz)', async () => {
        const svc = new E2EEKeyService(db);
        const aPayload = await register(alice.id, aliceKeys, { otpkCount: 30, otpkOffset: 0, materialOffset: 920 });
        aPayload.deviceId = 'device-fuzz-aaa';
        await svc.registerDevice({ userId: alice.id, ...aPayload });

        const bKeys = await deviceKeys(43);
        const bPayload = await register(alice.id, bKeys, { otpkCount: 30, otpkOffset: 0, materialOffset: 930 });
        bPayload.deviceId = 'device-fuzz-bbb';

        // rotation races 15 concurrent bundle claims
        const rotationP = svc.registerDevice({ userId: alice.id, ...bPayload });
        const claimPs = Array.from({ length: 15 }, () => svc.fetchBundle(alice.id, { claimantId: bob.id }).catch(() => null));
        await rotationP;
        const bundles = (await Promise.all(claimPs)).filter(Boolean);

        for (const b of bundles) {
            expect(['device-fuzz-aaa', 'device-fuzz-bbb']).toContain(b.deviceId);
            if (b.oneTimePreKey) {
                // P0-C under race: the claimed OTPK is the row bound to the
                // SAME device as the bundle that served it — never mixed
                // (keyIds are device-scoped, so the pair (deviceId, keyId)
                // identifies the exact consumed row)
                const row = await db.e2eeOneTimePreKey.findFirst({
                    where: { userId: alice.id, deviceId: b.deviceId, keyId: b.oneTimePreKey.keyId, isUsed: true } });
                expect(row).toBeTruthy();
                expect(row.claimedBy).toBe(bob.id);
            }
        }
        // every claim that completed after the rotation returns ONLY the new
        // active device — no session may target a retired device
        for (let i = 0; i < 5; i++) {
            const late = await svc.fetchBundle(alice.id, { claimantId: bob.id });
            expect(late.deviceId).toBe('device-fuzz-bbb');
        }
    });

    test('P0-C. concurrent device registrations converge to EXACTLY ONE active device', async () => {
        const svc = new E2EEKeyService(db);
        const keysA = await deviceKeys(23);
        const payloadA = await register(alice.id, keysA, { otpkCount: 5, otpkOffset: 0, materialOffset: 400 });
        payloadA.deviceId = 'device-race-one';
        const keysB = await deviceKeys(24);
        const payloadB = await register(alice.id, keysB, { otpkCount: 5, otpkOffset: 0, materialOffset: 500 });
        payloadB.deviceId = 'device-race-two';

        await Promise.all([
            svc.registerDevice({ userId: alice.id, ...payloadA }),
            svc.registerDevice({ userId: alice.id, ...payloadB }),
        ]);

        const active = await db.e2eeDevice.findMany({ where: { userId: alice.id, isActive: true } });
        expect(active.length).toBe(1);
        const bundle = await svc.fetchBundle(alice.id, { claimantId: bob.id });
        expect(bundle.deviceId).toBe(active[0].deviceId);
        // the surviving device's bundle only ever contains ITS OWN prekeys
        if (bundle.oneTimePreKey) {
            const row = await db.e2eeOneTimePreKey.findFirst({ where: { userId: alice.id, deviceId: active[0].deviceId, keyId: bundle.oneTimePreKey.keyId } });
            expect(row.deviceId).toBe(active[0].deviceId);
        }
    });

    test('P1-E. non-pairwise (TRADE/BUSINESS) conversations reject E2EE envelopes', async () => {
        const svc = new E2EEKeyService(db);
        aliceKeys = await deviceKeys(25);
        const payload = await register(alice.id, aliceKeys);
        await svc.registerDevice({ userId: alice.id, ...payload });
        const trade = await db.conversation.create({
            data: { type: 'TRADE', participants: { connect: [{ id: alice.id }, { id: bob.id }] } },
        });
        const post = await request(app)
            .post(`/api/conversation/${trade.id}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { v: 1, deviceId: payload.deviceId, ik: payload.identityPublicKey, ct: 'AAAA', nonce: 'AAAA', h: { dh: 'AAAA' } } });
        expect(post.status).toBe(400);
        expect(post.body.code).toBe('E2EE_NOT_PAIRWISE');
    });

    test('P1-F. envelope sender must be an ACTIVE device OWNED by the authenticated caller', async () => {
        const svc = new E2EEKeyService(db);
        aliceKeys = await deviceKeys(26);
        bobKeys = await deviceKeys(27);
        const payload = await register(alice.id, aliceKeys);
        const bobPayload = await register(bob.id, bobKeys);
        await svc.registerDevice({ userId: alice.id, ...payload });
        await svc.registerDevice({ userId: bob.id, ...bobPayload });

        const envelope = {
            v: 1, deviceId: payload.deviceId, ik: payload.identityPublicKey,
            ct: 'AAAA', nonce: 'AAAA', h: { dh: 'AAAA' },
        };
        // a forged deviceId not registered to the caller
        const forged = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { ...envelope, deviceId: 'not-my-device-1' } });
        expect(forged.status).toBe(403);
        expect(forged.body.code).toBe('E2EE_SENDER_IDENTITY_MISMATCH');

        // right deviceId but a mismatched identity key (another user's IK)
        const stolenIk = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { ...envelope, ik: bobPayload.identityPublicKey } });
        expect(stolenIk.status).toBe(403);

        // an inactive (retired) device cannot sign envelopes
        await svc.registerDevice({ userId: alice.id, ...(await (async () => {
            const k = await deviceKeys(28);
            const p = await register(alice.id, k);
            p.deviceId = 'device-newer-0001';
            return p;
        })()) });
        const retired = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { ...envelope } });
        expect(retired.status).toBe(403);
    });

    test('P0-A. the E2EE surface is DISABLED (503) unless AZM_E2EE_ENABLED=true', async () => {
        const prev = process.env.AZM_E2EE_ENABLED;
        process.env.AZM_E2EE_ENABLED = '';
        const gate1 = await request(app).post('/api/e2ee/devices').set('x-test-user', String(alice.id)).send({});
        expect(gate1.status).toBe(503);
        expect(gate1.body.code).toBe('E2EE_NOT_AVAILABLE');
        const gate2 = await request(app)
            .post(`/api/conversation/${app.locals.convId}/messages`)
            .set('x-test-user', String(alice.id))
            .send({ type: 'TEXT', e2ee: { v: 1, deviceId: 'x', ik: 'y', ct: 'z', nonce: 'n', h: { dh: 'd' } } });
        expect(gate2.status).toBe(503);
        process.env.AZM_E2EE_ENABLED = prev || 'true';
    });
});
