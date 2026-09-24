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
        await db.user.deleteMany({ where: { username: { in: ['e2ee-alice', 'e2ee-bob'] } } });
        alice = await db.user.create({ data: { username: 'e2ee-alice', email: 'e2ee-alice@t.test', password: 'x' } });
        bob = await db.user.create({ data: { username: 'e2ee-bob', email: 'e2ee-bob@t.test', password: 'x' } });
        const conv = await db.conversation.create({
            data: { type: 'PERSONAL', participants: { connect: [{ id: alice.id }, { id: bob.id }] } },
        });
        app.locals.convId = conv.id;
    });

    const register = async (userId, keys, { otpkCount = 5, spkId = 1, forged = false } = {}) => {
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
        for (let i = 0; i < otpkCount; i++) {
            const kp = sodium.crypto_box_seed_keypair(sodium.randombytes_buf_deterministic(32, Buffer.alloc(32, 200 + i)));
            otpkKeys.push({ keyId: 1000 + i, publicKey: b64(kp.publicKey) });
            otpkPrivateBy[1000 + i] = b64(kp.privateKey);
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
    });

    test('9. concurrent one-time prekey claims return DISTINCT keys (atomic SKIP LOCKED)', async () => {
        const svc = new E2EEKeyService(db);
        const payload = await register(bob.id, bobKeys || (bobKeys = await deviceKeys(2)), { otpkCount: 20 });
        await svc.registerDevice({ userId: bob.id, ...payload });

        const bundles = await Promise.all(Array.from({ length: 20 }, () => svc.fetchBundle(bob.id)));
        const claimedIds = bundles.map((b) => b.oneTimePreKey && b.oneTimePreKey.keyId).filter(Boolean);
        expect(claimedIds.length).toBe(20);
        expect(new Set(claimedIds).size).toBe(20); // every concurrent caller got a DIFFERENT key
        const remaining = await db.e2eeOneTimePreKey.count({ where: { userId: bob.id, isUsed: false } });
        expect(remaining).toBe(0);
        // subsequent fetches degrade to no one-time prekey (no crash)
        const drained = await svc.fetchBundle(bob.id);
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
        const bundle = await svc.fetchBundle(bob.id);
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
        const AD = protocol.associatedData(b64(aliceKeys.identity.publicKey), bundle.identityPublicKey);
        const aliceSession = await protocol.DoubleRatchetSession.initiator(init.sharedKey, bundle.signedPreKey.publicKey);
        const plaintext = 'bank details: not the server business';
        const m = aliceSession.encrypt(plaintext, AD);
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
            AD,
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
            AD,
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
});
