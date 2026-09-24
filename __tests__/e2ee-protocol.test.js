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
    const alice = await protocol.DoubleRatchetSession.initiator(init.sharedKey, b64(B.spk.publicKey));
    const bob = await protocol.DoubleRatchetSession.responder(resp.sharedKey, B.spk);
    const aliceDev = { deviceId: 'device-alice-0001', ik: aliceIdentity.pub };
    const bobDev = { deviceId: 'device-bob-0001', ik: bobIdentity.pub };
    return { alice, bob, aliceDev, bobDev, aliceIdentity, bobIdentity, A, B, init, resp };
}

// Context binding (P1-F): each direction binds conversation + sender device +
// both identity keys. The recipient rebuilds the SAME context the sender used.
const ctx = (from, to, conversationId = 'conv-0001') => ({
    conversationId, senderDeviceId: from.deviceId,
    senderIdentityKey: from.ik, recipientIdentityKey: to.ik,
});
const E = (sess, text, c) => sess.encrypt(text, c);
const D = (sess, m, c) => sess.decrypt({ header: m.header, nonce: m.nonce, ciphertext: m.ciphertext }, c);

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
        const { alice, bob, aliceDev, bobDev } = await makeSession(7, 8);
        expect(D(bob, alice.encrypt('a1', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('a1');
        expect(D(alice, bob.encrypt('b1', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev))).toBe('b1');
        expect(D(bob, alice.encrypt('a2', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('a2');
        expect(D(alice, bob.encrypt('b2', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev))).toBe('b2');
        expect(D(bob, alice.encrypt('a3', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('a3');
        expect(D(alice, bob.encrypt('b3', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev))).toBe('b3');
    });

    test('2. tampered ciphertext fails authentication; wrong peer cannot decrypt', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(9, 10);
        const good = alice.encrypt('integrity', ctx(aliceDev, bobDev));
        expect(D(bob, good, ctx(aliceDev, bobDev))).toBe('integrity');
        const bad = { header: { ...good.header }, nonce: good.nonce, ciphertext: Buffer.from(good.ciphertext) };
        bad.ciphertext[0] ^= 0x01;
        expect(() => D(bob, bad, ctx(aliceDev, bobDev))).toThrow();
        // wrong associated data (mis-bound identities) fails
        // P1-F: a context binding the WRONG identities must fail auth.
        const wrongCtx = { ...ctx(aliceDev, bobDev), senderIdentityKey: b64(Buffer.alloc(32, 1)) };
        const w = alice.encrypt('misbound', wrongCtx);
        expect(() => D(bob, w, ctx(aliceDev, bobDev))).toThrow();
        // a session established with the WRONG peer's SPK is unreadable by Bob
        const other = await makeSession(9, 11);
        const m = other.alice.encrypt('not for you', ctx(other.aliceDev, other.bobDev));
        expect(() => D(bob, { header: m.header, nonce: m.nonce, ciphertext: m.ciphertext }, ctx(aliceDev, bobDev))).toThrow();
        // and the honest session's messages are unreadable by the third party
        const mine = alice.encrypt('for bob', ctx(aliceDev, bobDev));
        expect(() => D(other.bob, { header: mine.header, nonce: mine.nonce, ciphertext: mine.ciphertext }, ctx(other.aliceDev, other.bobDev))).toThrow();
    });

    test('4. nonce reuse is impossible under the message API contract', async () => {
        const { alice, aliceDev, bobDev } = await makeSession(12, 13);
        const nonces = new Set();
        for (let i = 0; i < 50; i++) {
            const m = alice.encrypt('n' + i, ctx(aliceDev, bobDev));
            nonces.add(m.nonce.toString('base64'));
        }
        expect(nonces.size).toBe(50); // every message a distinct nonce
        const { messageKey: mk } = protocol.kdfCk(alice.sendingChainKey);
        expect(protocol.messageNonce(mk).length).toBe(12);
        expect(protocol.messageNonce(mk).equals(protocol.messageNonce(mk))).toBe(true);
        expect(protocol.messageNonce(mk).equals(protocol.messageNonce(Buffer.alloc(32, 1)))).toBe(false);
    });

    test('5. replayed envelope is rejected and does NOT advance the session', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(14, 15);
        const m1 = alice.encrypt('once', ctx(aliceDev, bobDev));
        expect(D(bob, m1, ctx(aliceDev, bobDev))).toBe('once');
        const stateBefore = JSON.stringify(bob.serialize());
        expect(() => D(bob, m1, ctx(aliceDev, bobDev))).toThrow();
        expect(JSON.stringify(bob.serialize())).toBe(stateBefore);
        expect(D(bob, alice.encrypt('next', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('next');
    });

    test('6. out-of-order delivery: skipped message keys follow the documented state machine', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(16, 17);
        const m1 = alice.encrypt('o1', ctx(aliceDev, bobDev));
        const m2 = alice.encrypt('o2', ctx(aliceDev, bobDev));
        const m3 = alice.encrypt('o3', ctx(aliceDev, bobDev));
        expect(D(bob, m3, ctx(aliceDev, bobDev))).toBe('o3');
        expect(D(bob, m1, ctx(aliceDev, bobDev))).toBe('o1');
        expect(D(bob, m2, ctx(aliceDev, bobDev))).toBe('o2');
        const far = alice.encrypt('far', ctx(aliceDev, bobDev));
        far.header.n = protocol.MAX_SKIP + 10;
        expect(() => D(bob, far, ctx(aliceDev, bobDev))).toThrow('E2EE_TOO_MANY_SKIPPED');
    });

    test('7/8. key rotation: a new device ends the old session cleanly; old key material is not trusted', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(18, 19);
        expect(D(bob, alice.encrypt('old device', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('old device');
        expect(D(alice, bob.encrypt('reply', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev))).toBe('reply');
        // Bob rotates to a NEW device: fresh keys, fresh session.
        const fresh = await makeSession(18, 20);
        const freshCtx = ctx(fresh.aliceDev, fresh.bobDev);
        const newAlice = await protocol.DoubleRatchetSession.initiator(fresh.init.sharedKey, b64(fresh.B.spk.publicKey));
        const newBob = await protocol.DoubleRatchetSession.responder(fresh.resp.sharedKey, fresh.B.spk);
        expect(D(newBob, newAlice.encrypt('new device', freshCtx), freshCtx)).toBe('new device');
        // messages from the OLD session are NOT accepted by the new device
        const stale = alice.encrypt('stale', ctx(aliceDev, bobDev));
        expect(() => D(newBob, { header: stale.header, nonce: stale.nonce, ciphertext: stale.ciphertext }, freshCtx)).toThrow();
    });

    test('session state serializes/restores exactly (client persistence contract)', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(21, 22);
        expect(D(bob, alice.encrypt('persist', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('persist');
        const restored = protocol.DoubleRatchetSession.parse(JSON.parse(JSON.stringify(bob.serialize())));
        expect(D(restored, alice.encrypt('after restore', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev))).toBe('after restore');
        expect(D(alice, restored.encrypt('reply after restore', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev))).toBe('reply after restore');
    });

    test('13. plaintext is bound: envelope carries bounded, authenticated bytes only', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(23, 24);
        const m = alice.encrypt('x'.repeat(1000), ctx(aliceDev, bobDev));
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

    // ── r40.1 audit proofs (P0-B, P1-F, P1-G, P1-H) ──────────────────────────

    test('P0-B. tampering header.dh alone is DETECTED (header is authenticated)', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(30, 31);
        const good = alice.encrypt('hdr-auth', ctx(aliceDev, bobDev));
        const tamperedDh = b64(Buffer.concat([Buffer.from(good.header.dh, 'base64').subarray(0, 31), Buffer.from([1])]));
        const bad = { header: { dh: tamperedDh, pn: good.header.pn, n: good.header.n }, nonce: good.nonce, ciphertext: good.ciphertext };
        expect(() => D(bob, bad, ctx(aliceDev, bobDev))).toThrow();
    });

    test('P0-B. tampering header.pn alone is DETECTED', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(32, 33);
        // establish two chains so pn is meaningful and non-zero
        D(bob, alice.encrypt('first chain', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev));
        const second = bob.encrypt('bob replies', ctx(bobDev, aliceDev));
        D(alice, second, ctx(bobDev, aliceDev)); // alice ratchets, pn=1
        const good = alice.encrypt('pn-auth', ctx(aliceDev, bobDev));
        const bad = { header: { dh: good.header.dh, pn: good.header.pn + 1, n: good.header.n }, nonce: good.nonce, ciphertext: good.ciphertext };
        expect(() => D(bob, bad, ctx(aliceDev, bobDev))).toThrow();
        // and the untouched message still decrypts
        expect(D(bob, good, ctx(aliceDev, bobDev))).toBe('pn-auth');
    });

    test('P0-B. tampering header.n alone is DETECTED', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(34, 35);
        const good = alice.encrypt('n-auth', ctx(aliceDev, bobDev));
        const bad = { header: { dh: good.header.dh, pn: good.header.pn, n: good.header.n + 1 }, nonce: good.nonce, ciphertext: good.ciphertext };
        expect(() => D(bob, bad, ctx(aliceDev, bobDev))).toThrow();
        expect(D(bob, good, ctx(aliceDev, bobDev))).toBe('n-auth');
    });

    test('P1-F. cross-conversation transplant is REJECTED (conversation bound in AD)', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(36, 37);
        const c1 = ctx(aliceDev, bobDev, 'conv-one');
        const c2 = ctx(aliceDev, bobDev, 'conv-two');
        const m = alice.encrypt('secret for conv one only', c1);
        expect(() => D(bob, m, c2)).toThrow();
        expect(D(bob, m, c1)).toBe('secret for conv one only');
    });

    test('P1-G. an encrypt() failure consumes NO ratchet state (transactional)', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(38, 39);
        D(bob, alice.encrypt('warm', ctx(aliceDev, bobDev)), ctx(aliceDev, bobDev));
        const before = JSON.stringify(alice.serialize());
        // invalid context (missing recipient identity) throws AFTER the trial
        // clone has already advanced its sending chain — the committed session
        // must remain untouched.
        const badCtx = { conversationId: 'x', senderDeviceId: 'd', senderIdentityKey: 'k' };
        expect(() => alice.encrypt('doomed', badCtx)).toThrow('E2EE_INVALID_CONTEXT');
        expect(JSON.stringify(alice.serialize())).toBe(before);
        // the session still works and the message stream has NO gap: the
        // failed attempt consumed no chain step (counter unchanged).
        const m1 = alice.encrypt('survivor', ctx(aliceDev, bobDev));
        expect(m1.header.n).toBe(1);
        expect(D(bob, m1, ctx(aliceDev, bobDev))).toBe('survivor');
    });

    test('P1-H. skipped-key cache is globally bounded (FIFO eviction, no unbounded state)', async () => {
        const { alice, bob, aliceDev, bobDev } = await makeSession(40, 41);
        // Chain 1: alice sends 900 messages, bob reads none yet.
        const chain1 = [];
        for (let i = 0; i < 900; i++) chain1.push(alice.encrypt('c1-' + i, ctx(aliceDev, bobDev)));
        // Bob reads the last message of chain 1 (forcing ~899 skipped keys),
        // then replies — Bob is the responder and must receive before sending,
        // and Alice's reply ratchets her into a fresh sending chain.
        D(bob, chain1[899], ctx(aliceDev, bobDev)); // ~899 skipped keys
        D(alice, bob.encrypt('reply-1', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev));
        const chain2 = [];
        for (let i = 0; i < 900; i++) chain2.push(alice.encrypt('c2-' + i, ctx(aliceDev, bobDev)));
        D(bob, chain2[899], ctx(aliceDev, bobDev)); // +899 -> 1798 retained
        D(alice, bob.encrypt('reply-2', ctx(bobDev, aliceDev)), ctx(bobDev, aliceDev));
        const chain3 = [];
        for (let i = 0; i < 900; i++) chain3.push(alice.encrypt('c3-' + i, ctx(aliceDev, bobDev)));
        D(bob, chain3[899], ctx(aliceDev, bobDev)); // +899 -> bound enforced, eviction

        expect(bob.skipped.size).toBeLessThanOrEqual(protocol.MAX_SKIPPED_CACHE);
        // The cache bound has a real cost: the OLDEST skipped keys are gone.
        const oldest = chain1[0];
        expect(() => D(bob, oldest, ctx(aliceDev, bobDev))).toThrow();
        // but recent material still decrypts
        expect(D(bob, chain3[0], ctx(aliceDev, bobDev))).toBe('c3-0');
    });

    test('P0-B. canonicalHeader is deterministic and field-order stable', () => {
        expect(protocol.canonicalHeader({ dh: 'AAA', pn: 1, n: 2 }))
            .toBe('azaman-dr-v1|AAA|1|2');
        expect(protocol.canonicalHeader({ n: 2, dh: 'AAA', pn: 1 }))
            .toBe(protocol.canonicalHeader({ dh: 'AAA', pn: 1, n: 2 }));
        expect(() => protocol.canonicalHeader({ dh: 'AAA', pn: 'x', n: 2 })).toThrow('E2EE_INVALID_HEADER');
    });
});
