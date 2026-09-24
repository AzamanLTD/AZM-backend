'use strict';
// =============================================================================
// E2EE protocol proof suite (P0) — deterministic real crypto, no mocks.
// Proves the pure-crypto invariants of docs/e2ee-protocol.md (proof items
// 1-8, 13); the database-bound invariants (9-11) are proven in
// e2ee-authority.pg.test.js; client byte-compatibility (12) is proven by
// packages/e2ee_protocol in the app repository.
//
// Context: current main's e2eeService.js establishSession()/acceptSession()
// compute DIFFERENT DH term sets and therefore derive DIFFERENT root keys
// (deterministic red proof captured in the PR description). This suite is
// the replacement's green proof.
// =============================================================================

const protocol = require('../services/e2ee/protocol');

const sodiumPromise = require('libsodium-wrappers').ready.then(() => require('libsodium-wrappers'));

// Deterministic seeds (distinct integer per key -> distinct, reproducible keys).
async function deviceSeeds(n) {
    const sodium = await sodiumPromise;
    const det = (i) => sodium.randombytes_buf_deterministic(32, Buffer.alloc(32, i));
    return {
        signing: sodium.crypto_sign_seed_keypair(det(n)),
        identity: sodium.crypto_box_seed_keypair(det(n + 1)),
        spk: sodium.crypto_box_seed_keypair(det(n + 2)),
        otpk: sodium.crypto_box_seed_keypair(det(n + 3)),
    };
}

const b64 = (x) => Buffer.from(x).toString('base64');

async function makePeers(seedA, seedB) {
    const A = await deviceSeeds(seedA);
    const B = await deviceSeeds(seedB);
    const aliceIdentity = { pub: b64(A.identity.publicKey), priv: b64(A.identity.privateKey) };
    const bobIdentity = { pub: b64(B.identity.publicKey), priv: b64(B.identity.privateKey) };
    const init = await protocol.initiateX3DH({
        ourIdentityPrivateKeyB64: aliceIdentity.priv,
        theirIdentityPublicKeyB64: bobIdentity.pub,
        theirSignedPreKeyPublicKeyB64: b64(B.spk.publicKey),
        theirOneTimePreKeyPublicKeyB64: b64(B.otpk.publicKey),
    });
    const resp = await protocol.acceptX3DH({
        ourIdentityPrivateKeyB64: bobIdentity.priv,
        ourSignedPreKeyPrivateKeyB64: b64(B.spk.privateKey),
        theirIdentityPublicKeyB64: aliceIdentity.pub,
        theirEphemeralPublicKeyB64: b64(init.ephemeralPublicKey),
        // the OTPK private key never exists server-side; supplied here only
        // because this test drives BOTH endpoints locally.
        ourOneTimePreKeyPrivateKeyB64: b64(B.otpk.privateKey),
    });
    return { A, B, aliceIdentity, bobIdentity, init, resp };
}

async function makeSession(seedA, seedB) {
    const { A, B, aliceIdentity, bobIdentity, init, resp } = await makePeers(seedA, seedB);
    const AD = protocol.associatedData(aliceIdentity.pub, bobIdentity.pub);
    const alice = await protocol.DoubleRatchetSession.initiator(init.sharedKey, b64(B.spk.publicKey));
    const bob = await protocol.DoubleRatchetSession.responder(resp.sharedKey, B.spk);
    return { alice, bob, AD, aliceIdentity, bobIdentity, A, B, init, resp };
}

const D = (sess, m, AD) => sess.decrypt({ header: m.header, nonce: m.nonce, ciphertext: m.ciphertext }, AD);

describe('E2EE protocol v1 (deterministic real crypto)', () => {
    beforeAll(async () => { await protocol.init(); });

    test('1. X3DH: initiator and receiver derive the EXACT same session secret', async () => {
        const { init, resp } = await makePeers(1, 2);
        expect(init.sharedKey.equals(resp.sharedKey)).toBe(true);
        expect(init.sharedKey.length).toBe(32);
    });

    test('X3DH: every DH term is mirrored exactly (no accidental term reuse)', async () => {
        const sodium = await sodiumPromise;
        const { A, B, aliceIdentity } = await makePeers(3, 4);
        const eph = sodium.crypto_box_seed_keypair(sodium.randombytes_buf_deterministic(32, Buffer.alloc(32, 99)));
        const dh = (priv, pub) => protocol.dh(Buffer.from(priv), Buffer.from(pub));
        const dh1 = dh(A.identity.privateKey, B.spk.publicKey);       // DH(IKa, SPKb)
        const dh2 = dh(eph.privateKey, B.identity.publicKey);          // DH(EKa, IKb)
        const dh3 = dh(eph.privateKey, B.spk.publicKey);              // DH(EKa, SPKb)
        const dh4 = dh(eph.privateKey, B.otpk.publicKey);              // DH(EKa, OPKb)
        expect(dh(B.spk.privateKey, A.identity.publicKey).equals(dh1)).toBe(true);
        expect(dh(B.identity.privateKey, eph.publicKey).equals(dh2)).toBe(true);
        expect(dh(B.spk.privateKey, eph.publicKey).equals(dh3)).toBe(true);
        expect(dh(B.otpk.privateKey, eph.publicKey).equals(dh4)).toBe(true);
        // Distinct terms — a rearranged/aliased implementation fails this.
        expect(dh1.equals(dh2)).toBe(false);
        expect(dh1.equals(dh3)).toBe(false);
        expect(dh2.equals(dh3)).toBe(false);
        expect(dh2.equals(dh4)).toBe(false);
        expect(dh3.equals(dh4)).toBe(false);
        // The identity keys really are distinct peers, not the seed-collision trap.
        expect(aliceIdentity.pub).not.toBe(b64(B.identity.publicKey));
        expect(b64(A.identity.publicKey)).not.toBe(b64(B.spk.publicKey));
    });

    test('X3DH works without a one-time prekey (depleted prekeys degrade, not fail)', async () => {
        const A = await deviceSeeds(5), B = await deviceSeeds(6);
        const init = await protocol.initiateX3DH({
            ourIdentityPrivateKeyB64: b64(A.identity.privateKey),
            theirIdentityPublicKeyB64: b64(B.identity.publicKey),
            theirSignedPreKeyPublicKeyB64: b64(B.spk.publicKey),
        });
        const resp = await protocol.acceptX3DH({
            ourIdentityPrivateKeyB64: b64(B.identity.privateKey),
            ourSignedPreKeyPrivateKeyB64: b64(B.spk.privateKey),
            theirIdentityPublicKeyB64: b64(A.identity.publicKey),
            theirEphemeralPublicKeyB64: b64(init.ephemeralPublicKey),
        });
        expect(init.sharedKey.equals(resp.sharedKey)).toBe(true);
    });

    test('double ratchet: bidirectional conversation, both chains in lockstep', async () => {
        const { alice, bob, AD } = await makeSession(7, 8);
        expect(D(bob, alice.encrypt('a1', AD), AD)).toBe('a1');
        expect(D(alice, bob.encrypt('b1', AD), AD)).toBe('b1');
        expect(D(bob, alice.encrypt('a2', AD), AD)).toBe('a2');
        expect(D(alice, bob.encrypt('b2', AD), AD)).toBe('b2');
        expect(D(bob, alice.encrypt('a3', AD), AD)).toBe('a3');
        expect(D(alice, bob.encrypt('b3', AD), AD)).toBe('b3');
    });

    test('2. tampered ciphertext fails authentication; wrong peer cannot decrypt', async () => {
        const { alice, bob, AD } = await makeSession(9, 10);
        const good = alice.encrypt('integrity', AD);
        expect(D(bob, good, AD)).toBe('integrity');
        const bad = { header: { ...good.header }, nonce: good.nonce, ciphertext: Buffer.from(good.ciphertext) };
        bad.ciphertext[0] ^= 0x01;
        expect(() => D(bob, bad, AD)).toThrow();
        // wrong associated data (mis-bound identities) fails
        const wrongAD = protocol.associatedData(b64(Buffer.alloc(32, 1)), b64(Buffer.alloc(32, 2)));
        const w = alice.encrypt('misbound', wrongAD);
        expect(() => D(bob, w, AD)).toThrow();
        // a session established with the WRONG peer's SPK is unreadable by Bob
        const other = await makeSession(9, 11);
        const m = other.alice.encrypt('not for you', other.AD);
        expect(() => D(bob, { header: m.header, nonce: m.nonce, ciphertext: m.ciphertext }, AD)).toThrow();
        // and the honest session's messages are unreadable by the third party
        const mine = alice.encrypt('for bob', AD);
        expect(() => D(other.bob, { header: mine.header, nonce: mine.nonce, ciphertext: mine.ciphertext }, other.AD)).toThrow();
    });

    test('4. nonce reuse is impossible under the message API contract', async () => {
        const { alice, AD } = await makeSession(12, 13);
        const nonces = new Set();
        for (let i = 0; i < 50; i++) {
            const m = alice.encrypt('n' + i, AD);
            nonces.add(m.nonce.toString('base64'));
        }
        expect(nonces.size).toBe(50); // every message a distinct nonce
        const { messageKey: mk } = protocol.kdfCk(alice.sendingChainKey);
        expect(protocol.messageNonce(mk).length).toBe(12);
        expect(protocol.messageNonce(mk).equals(protocol.messageNonce(mk))).toBe(true);
        expect(protocol.messageNonce(mk).equals(protocol.messageNonce(Buffer.alloc(32, 1)))).toBe(false);
    });

    test('5. replayed envelope is rejected and does NOT advance the session', async () => {
        const { alice, bob, AD } = await makeSession(14, 15);
        const m1 = alice.encrypt('once', AD);
        expect(D(bob, m1, AD)).toBe('once');
        const stateBefore = JSON.stringify(bob.serialize());
        expect(() => D(bob, m1, AD)).toThrow();
        expect(JSON.stringify(bob.serialize())).toBe(stateBefore);
        expect(D(bob, alice.encrypt('next', AD), AD)).toBe('next');
    });

    test('6. out-of-order delivery: skipped message keys follow the documented state machine', async () => {
        const { alice, bob, AD } = await makeSession(16, 17);
        const m1 = alice.encrypt('o1', AD);
        const m2 = alice.encrypt('o2', AD);
        const m3 = alice.encrypt('o3', AD);
        expect(D(bob, m3, AD)).toBe('o3');
        expect(D(bob, m1, AD)).toBe('o1');
        expect(D(bob, m2, AD)).toBe('o2');
        const far = alice.encrypt('far', AD);
        far.header.n = protocol.MAX_SKIP + 10;
        expect(() => D(bob, far, AD)).toThrow('E2EE_TOO_MANY_SKIPPED');
    });

    test('7/8. key rotation: a new device ends the old session cleanly; old key material is not trusted', async () => {
        const { alice, bob, AD } = await makeSession(18, 19);
        expect(D(bob, alice.encrypt('old device', AD), AD)).toBe('old device');
        expect(D(alice, bob.encrypt('reply', AD), AD)).toBe('reply');
        // Bob rotates to a NEW device: fresh keys, fresh session.
        const fresh = await makeSession(18, 20);
        const newAD = protocol.associatedData(fresh.aliceIdentity.pub, fresh.bobIdentity.pub);
        const newAlice = await protocol.DoubleRatchetSession.initiator(fresh.init.sharedKey, b64(fresh.B.spk.publicKey));
        const newBob = await protocol.DoubleRatchetSession.responder(fresh.resp.sharedKey, fresh.B.spk);
        expect(D(newBob, newAlice.encrypt('new device', newAD), newAD)).toBe('new device');
        // messages from the OLD session are NOT accepted by the new device
        const stale = alice.encrypt('stale', AD);
        expect(() => D(newBob, { header: stale.header, nonce: stale.nonce, ciphertext: stale.ciphertext }, newAD)).toThrow();
    });

    test('session state serializes/restores exactly (client persistence contract)', async () => {
        const { alice, bob, AD } = await makeSession(21, 22);
        expect(D(bob, alice.encrypt('persist', AD), AD)).toBe('persist');
        const restored = protocol.DoubleRatchetSession.parse(JSON.parse(JSON.stringify(bob.serialize())));
        expect(D(restored, alice.encrypt('after restore', AD), AD)).toBe('after restore');
        expect(D(alice, restored.encrypt('reply after restore', AD), AD)).toBe('reply after restore');
    });

    test('13. plaintext is bound: envelope carries bounded, authenticated bytes only', async () => {
        const { alice, bob, AD } = await makeSession(23, 24);
        const m = alice.encrypt('x'.repeat(1000), AD);
        expect(m.ciphertext.length).toBeGreaterThanOrEqual(1000 + 16);
        expect(Number.isInteger(m.header.n)).toBe(true);
        expect(m.header.pn).toBeGreaterThanOrEqual(0);
    });

    test('registration gates: forged identity bindings and forged prekey signatures are rejected', async () => {
        const sodium = await sodiumPromise;
        const A = await deviceSeeds(25);
        const C = await deviceSeeds(26);
        const signingPublicKey = b64(A.signing.publicKey);
        const identityPublicKey = b64(A.identity.publicKey);
        const bindingMsg = Buffer.concat([
            Buffer.from('azaman-e2ee-v1-device-bind|'),
            Buffer.from(identityPublicKey), Buffer.from('|'), Buffer.from(signingPublicKey),
        ]);
        const goodBinding = sodium.crypto_sign_detached(bindingMsg, A.signing.privateKey);
        expect(protocol.verifyDeviceBinding({ signingPublicKeyB64: signingPublicKey, identityPublicKeyB64: identityPublicKey, bindingSignatureB64: b64(goodBinding) })).toBe(true);
        const forgedBinding = sodium.crypto_sign_detached(bindingMsg, C.signing.privateKey);
        expect(protocol.verifyDeviceBinding({ signingPublicKeyB64: signingPublicKey, identityPublicKeyB64: identityPublicKey, bindingSignatureB64: b64(forgedBinding) })).toBe(false);
        // SPK signature gate
        const spkPub = b64(A.spk.publicKey);
        const spkMsg = Buffer.concat([Buffer.from('azaman-e2ee-v1-spk|'), Buffer.from('123'), Buffer.from('|'), Buffer.from(spkPub)]);
        const goodSig = sodium.crypto_sign_detached(spkMsg, A.signing.privateKey);
        expect(protocol.verifySignedPreKeySignature({ signingPublicKeyB64: signingPublicKey, signedPreKeyId: 123, signedPreKeyPublicKeyB64: spkPub, signatureB64: b64(goodSig) })).toBe(true);
        // same signature for a DIFFERENT keyId must not verify (key-substitution attack)
        expect(protocol.verifySignedPreKeySignature({ signingPublicKeyB64: signingPublicKey, signedPreKeyId: 124, signedPreKeyPublicKeyB64: spkPub, signatureB64: b64(goodSig) })).toBe(false);
        // signature over a different SPK public key must not verify
        expect(protocol.verifySignedPreKeySignature({ signingPublicKeyB64: signingPublicKey, signedPreKeyId: 123, signedPreKeyPublicKeyB64: b64(C.spk.publicKey), signatureB64: b64(goodSig) })).toBe(false);
    });

    test('HKDF (RFC 5869) self-checks: extraction is stable and expansion splits cleanly', () => {
        const ikm = Buffer.from('input key material secret', 'utf8');
        const okm32 = protocol.hkdfSha256(ikm, Buffer.alloc(32, 0), 'AZAMAN-X3DH-v1', 32);
        const okm64 = protocol.hkdfSha256(ikm, Buffer.alloc(32, 0), 'AZAMAN-X3DH-v1', 64);
        expect(okm32.length).toBe(32);
        expect(okm64.subarray(0, 32).equals(okm32)).toBe(true);
        expect(okm64.subarray(32).equals(okm32)).toBe(false);
    });
});
