// services/e2ee/protocol.js
// =============================================================================
// AZAMAN E2EE Protocol v1 — reference implementation.
//
// Implements the PUBLISHED Signal X3DH and Double Ratchet specifications on
// standard primitives (X25519, Ed25519, HKDF-SHA256, HMAC-SHA256,
// ChaCha20-Poly1305-IETF). The full contract, including the exact KDF
// constructions, envelope format, associated-data binding, rotation and
// recovery behaviour, is docs/e2ee-protocol.md. That document is binding for
// every client implementation (Flutter packages/e2ee_protocol).
//
// This module is PURE CRYPTOGRAPHY: no database, no HTTP, no key storage.
// The server uses it only to VERIFY registration signatures. Session state
// (SK, root/chain keys, skipped-message keys) belongs to the CLIENT, never
// the server (the server-blind trust model).
// =============================================================================

'use strict';

const crypto = require('node:crypto');
const _sodium = require('libsodium-wrappers');

const PROTOCOL_VERSION = 1;
const X3DH_INFO = 'AZAMAN-X3DH-v1';
const DR_RK_INFO = 'AZAMAN-DR-v1-rk';
const DR_NONCE_INFO = 'AZAMAN-DR-v1-nonce';
const AD_PREFIX = 'azaman-e2ee-v1';
const BIND_PREFIX = 'azaman-e2ee-v1-device-bind';
const SPK_PREFIX = 'azaman-e2ee-v1-spk';
const MAX_SKIP = 1000;
// P1-H: total skipped-message-key cache bound across ALL chains. Signal bounds
// skipped key material globally, not just the per-chain skip distance: without
// a total bound, an attacker can force unbounded retained key state by sending
// many sparse headers. FIFO eviction once the cache is full.
const MAX_SKIPPED_CACHE = 2000;
// P0-B: canonical authenticated-header encoding. Every byte of the Double
// Ratchet header { dh, pn, n } is bound into the AEAD associated data exactly
// as the Signal specification requires (AD' = AD || header). The encoding is
// ASCII, length-delimited by '|', and MUST be byte-identical in every client
// implementation: `azaman-dr-v1|<dhB64>|<pn>|<n>`.
const HEADER_PREFIX = 'azaman-dr-v1';

let sodium = null;
async function init() {
    if (!sodium) { await _sodium.ready; sodium = _sodium; }
    return sodium;
}

// ── Primitives ────────────────────────────────────────────────────────────────

function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

// HKDF-SHA256 (RFC 5869), single or multi-block.
function hkdfSha256(ikm, salt, info, length) {
    const prk = hmacSha256(salt, ikm);
    const blocks = [];
    let previous = Buffer.alloc(0);
    while (blocks.length * 32 < length) {
        previous = hmacSha256(prk, Buffer.concat([previous, Buffer.from(info, 'utf8'),
            Buffer.from([blocks.length + 1])]));
        blocks.push(previous);
    }
    return Buffer.concat(blocks).subarray(0, length);
}

function b64(data) { return Buffer.from(data).toString('base64'); }
function unb64(text) { return Buffer.from(String(text), 'base64'); }

// Raw X25519 scalarmult (the DH output feeds the KDFs directly).
function dh(privateKey32, publicKey32) {
    const out = sodium.crypto_scalarmult(privateKey32, publicKey32);
    // X25519 all-zero output must never be used (small-subgroup defence).
    if (Buffer.from(out).equals(Buffer.alloc(32))) throw new Error('E2EE_DH_ALL_ZERO');
    return Buffer.from(out);
}

// ── Registration signature verification (server-side trust gate) ──────────────

function verifyDeviceBinding({ signingPublicKeyB64, identityPublicKeyB64, bindingSignatureB64 }) {
    const message = Buffer.concat([
        Buffer.from(BIND_PREFIX + '|', 'utf8'),
        Buffer.from(String(identityPublicKeyB64), 'utf8'),
        Buffer.from('|', 'utf8'),
        Buffer.from(String(signingPublicKeyB64), 'utf8'),
    ]);
    return sodium.crypto_sign_verify_detached(unb64(bindingSignatureB64), message, unb64(signingPublicKeyB64));
}

function verifySignedPreKeySignature({ signingPublicKeyB64, signedPreKeyId, signedPreKeyPublicKeyB64, signatureB64 }) {
    const message = Buffer.concat([
        Buffer.from(SPK_PREFIX + '|', 'utf8'),
        Buffer.from(String(signedPreKeyId), 'utf8'),
        Buffer.from('|', 'utf8'),
        Buffer.from(String(signedPreKeyPublicKeyB64), 'utf8'),
    ]);
    return sodium.crypto_sign_verify_detached(unb64(signatureB64), message, unb64(signingPublicKeyB64));
}

// ── X3DH (Signal specification) ───────────────────────────────────────────────

// Initiator side. Returns { sharedKey (Buffer 32), ephemeralPublicKey (Buffer) }.
// Every DH term is computed EXACTLY as the spec names it; the responder
// mirrors each term (see acceptX3DH). The invariant
// initiateX3DH(...).sharedKey === acceptX3DH(...).sharedKey is proven by tests.
async function initiateX3DH({ ourIdentityPrivateKeyB64, theirIdentityPublicKeyB64, theirSignedPreKeyPublicKeyB64, theirOneTimePreKeyPublicKeyB64 }) {
    const s = await init();
    const ikPriv = unb64(ourIdentityPrivateKeyB64);
    const ikbPub = unb64(theirIdentityPublicKeyB64);
    const spkbPub = unb64(theirSignedPreKeyPublicKeyB64);

    const ephemeral = s.crypto_box_keypair(); // X25519 pair for this session
    const dh1 = dh(ikPriv, spkbPub);              // DH(IKa, SPKb)
    const dh2 = dh(Buffer.from(ephemeral.privateKey), ikbPub); // DH(EKa, IKb)
    const dh3 = dh(Buffer.from(ephemeral.privateKey), spkbPub); // DH(EKa, SPKb)
    const terms = [Buffer.alloc(32, 0xff), dh1, dh2, dh3];

    if (theirOneTimePreKeyPublicKeyB64) {
        terms.push(dh(Buffer.from(ephemeral.privateKey), unb64(theirOneTimePreKeyPublicKeyB64))); // DH(EKa, OPKb)
    }
    const sharedKey = hkdfSha256(Buffer.concat(terms), Buffer.alloc(32, 0), X3DH_INFO, 32);
    return { sharedKey, ephemeralPrivateKey: Buffer.from(ephemeral.privateKey), ephemeralPublicKey: Buffer.from(ephemeral.publicKey) };
}

// Responder side (the device that owns SPKb/OPKb).
async function acceptX3DH({ ourIdentityPrivateKeyB64, ourSignedPreKeyPrivateKeyB64, ourOneTimePreKeyPrivateKeyB64, theirIdentityPublicKeyB64, theirEphemeralPublicKeyB64 }) {
    await init();
    const ikPriv = unb64(ourIdentityPrivateKeyB64);
    const spkPriv = unb64(ourSignedPreKeyPrivateKeyB64);
    const ekaPub = unb64(theirEphemeralPublicKeyB64);
    const ikaPub = unb64(theirIdentityPublicKeyB64);

    // Mirror of each initiator term (X25519 is symmetric):
    const dh1 = dh(spkPriv, ikaPub);  // = DH(IKa, SPKb)
    const dh2 = dh(ikPriv, ekaPub);   // = DH(EKa, IKb)
    const dh3 = dh(spkPriv, ekaPub);  // = DH(EKa, SPKb)
    const terms = [Buffer.alloc(32, 0xff), dh1, dh2, dh3];
    if (ourOneTimePreKeyPrivateKeyB64) {
        terms.push(dh(unb64(ourOneTimePreKeyPrivateKeyB64), ekaPub)); // = DH(EKa, OPKb)
    }
    const sharedKey = hkdfSha256(Buffer.concat(terms), Buffer.alloc(32, 0), X3DH_INFO, 32);
    return { sharedKey };
}

// ── Double Ratchet (Signal specification) ────────────────────────────────────

// KDF_RK: (rk, dh_out) -> (rk', ck')
function kdfRk(rk, dhOut) {
    const out = hkdfSha256(dhOut, rk, DR_RK_INFO, 64);
    return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

// KDF_CK: ck -> (mk, ck')
function kdfCk(ck) {
    return {
        messageKey: hmacSha256(ck, Buffer.from([0x01])),
        chainKey: hmacSha256(ck, Buffer.from([0x02])),
    };
}

// Deterministic single-use nonce derived from the single-use message key.
function messageNonce(mk) {
    return hmacSha256(mk, Buffer.from(DR_NONCE_INFO, 'utf8')).subarray(0, 12);
}

// AEAD: ChaCha20-Poly1305 (IETF, RFC 8439).
function aeadEncrypt(messageKey, nonce, plaintext, associatedData) {
    return Buffer.from(sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        Buffer.from(plaintext), Buffer.from(associatedData), null, nonce, messageKey));
}
function aeadDecrypt(messageKey, nonce, ciphertext, associatedData) {
    const out = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
        null, Buffer.from(ciphertext), Buffer.from(associatedData), nonce, messageKey);
    if (!out) throw new Error('E2EE_MESSAGE_AUTH_FAILED');
    return Buffer.from(out);
}

// Session state (client-owned; JSON-serializable via serialize/parse).
class DoubleRatchetSession {
    constructor(state) {
        Object.assign(this, state);
        // P1-H: skipped-message-key cache is an insertion-ordered Map (FIFO
        // eviction at MAX_SKIPPED_CACHE entries). Plain objects preserve
        // string-key insertion order too, but a Map makes the bound explicit
        // and survives key deletion orderings cleanly.
        if (!(this.skipped instanceof Map)) {
            this.skipped = new Map(Object.entries(this.skipped || {}).map(([k, v]) => [k, v]));
        }
    }

    static async initiator(sharedKey, theirSignedPreKeyPublicKeyB64) {
        // RatchetInitAlice: a FRESH ratchet pair seeds the first sending chain
        // (the X3DH ephemeral stays in the envelope for session establishment
        // only). DHr = SPKb. (RK, CKs) = KDF_RK(SK, DH(R_A1, SPKb)); the peer
        // mirrors this exact DH in its first receive step.
        const s = await init();
        const ratchet = s.crypto_box_keypair();
        const { rootKey, chainKey } = kdfRk(sharedKey, dh(Buffer.from(ratchet.privateKey), unb64(theirSignedPreKeyPublicKeyB64)));
        return new DoubleRatchetSession({
            rootKey, sendingChainKey: chainKey, receivingChainKey: null,
            dhSelf: { publicKey: Buffer.from(ratchet.publicKey), privateKey: Buffer.from(ratchet.privateKey) },
            dhRemote: unb64(theirSignedPreKeyPublicKeyB64),
            sendCount: 0, recvCount: 0, prevSendCount: 0, skipped: {},
        });
    }

    static async responder(sharedKey, ourSignedPreKeyKeyPair) {
        await init();
        // Spec: Bob starts with DHs = SPKb pair, DHr = null, no chains yet.
        return new DoubleRatchetSession({
            rootKey: Buffer.from(sharedKey), sendingChainKey: null, receivingChainKey: null,
            dhSelf: { publicKey: Buffer.from(ourSignedPreKeyKeyPair.publicKey), privateKey: Buffer.from(ourSignedPreKeyKeyPair.privateKey) },
            dhRemote: null, sendCount: 0, recvCount: 0, prevSendCount: 0, skipped: {},
        });
    }

    _trySkipped(headerKey, counter) {
        const key = `${headerKey.toString('base64')}:${counter}`;
        if (this.skipped.has(key)) {
            const mk = this.skipped.get(key);
            this.skipped.delete(key);
            return mk;
        }
        return null;
    }

    _skipMessageKeys(dhRemote, until) {
        if (this.receivingChainKey === null) return;
        if (until + 1 - this.recvCount > MAX_SKIP) throw new Error('E2EE_TOO_MANY_SKIPPED');
        while (this.recvCount < until) {
            const { messageKey, chainKey } = kdfCk(this.receivingChainKey);
            const cacheKey = `${dhRemote.toString('base64')}:${this.recvCount}`;
            if (this.skipped.size >= MAX_SKIPPED_CACHE) {
                // FIFO eviction: the oldest retained key is dropped. Old
                // messages beyond the cache bound become undecryptable —
                // the documented cost of bounding untrusted state.
                this.skipped.delete(this.skipped.keys().next().value);
            }
            this.skipped.set(cacheKey, messageKey);
            this.receivingChainKey = chainKey;
            this.recvCount += 1;
        }
    }

    encrypt(plaintext, context) {
        // Transactional like decrypt() (P1-G): all state mutation happens on a
        // TRIAL clone and commits only after the AEAD succeeds. An encryption
        // failure therefore cannot consume ratchet state without producing a
        // message — the same state-safety property decrypt() already has.
        const trial = DoubleRatchetSession.parse(JSON.parse(JSON.stringify(this.serialize())));

        // First reply after receiving (sending chain not yet created): perform
        // the sending DH-step with a FRESH ratchet pair. The peer mirrors this
        // exact DH when it next receives a new header.dh from us — the two
        // KDF_RK applications (ours for CKs, theirs for CKr) consume the same
        // DH output and the same root key, so the chains are identical.
        if (trial.sendingChainKey === null) {
            if (trial.dhRemote === null) throw new Error('E2EE_CANNOT_SEND_BEFORE_RECEIVE');
            const s = sodium || _sodium;
            const fresh = s.crypto_box_keypair();
            const { rootKey, chainKey } = kdfRk(trial.rootKey, dh(Buffer.from(fresh.privateKey), trial.dhRemote));
            trial.rootKey = rootKey;
            trial.sendingChainKey = chainKey;
            trial.prevSendCount = trial.sendCount;
            trial.sendCount = 0;
            trial.dhSelf = { publicKey: Buffer.from(fresh.publicKey), privateKey: Buffer.from(fresh.privateKey) };
        }
        const header = { dh: trial.dhSelf.publicKey.toString('base64'), pn: trial.prevSendCount, n: trial.sendCount };
        const { messageKey, chainKey } = kdfCk(trial.sendingChainKey);
        trial.sendingChainKey = chainKey;
        const nonce = messageNonce(messageKey);
        // P0-B: the AEAD authenticates the context binding AND every byte of
        // the canonical header — dh, pn, n cannot be altered undetected.
        const ciphertext = aeadEncrypt(messageKey, nonce, Buffer.from(plaintext, 'utf8'), messageAssociatedData(context, header));
        trial.sendCount += 1;
        Object.assign(this, trial);
        return { header, nonce, ciphertext };
    }

    // Transactional decrypt: state advances ONLY on successful
    // authentication. A replayed or out-of-window message must leave the
    // session untouched — an AEAD failure that had already advanced the chain
    // would permanently corrupt the session (derived message keys are
    // single-use, so a wrong-position key is unfixable later).
    decrypt(envelope, context) {
        const { header, nonce, ciphertext } = envelope;
        const trial = DoubleRatchetSession.parse(JSON.parse(JSON.stringify(this.serialize())));
        const plaintext = trial._decryptInPlace({ header, nonce, ciphertext }, context);
        // Commit the trial state only after successful authentication.
        Object.assign(this, trial);
        return plaintext;
    }

    _decryptInPlace({ header, nonce, ciphertext }, context) {
        // P0-B: rebuilt with the SAME canonical-header binding the sender
        // used. Any dh/pn/n mutation makes authentication fail.
        const ad = messageAssociatedData(context, header);
        const dhRemote = unb64(header.dh);
        const skipped = this._trySkipped(dhRemote, header.n);
        if (skipped) return aeadDecrypt(skipped, nonce, ciphertext, ad).toString('utf8');

        // New remote ratchet key: finish the old chain, then DH-step.
        if (!this.dhRemote || !dhRemote.equals(this.dhRemote)) {
            this._skipMessageKeys(this.dhRemote, header.pn);
            const { rootKey, chainKey } = kdfRk(this.rootKey, dh(this.dhSelf.privateKey, dhRemote));
            this.rootKey = rootKey;
            this.receivingChainKey = chainKey;
            this.dhRemote = dhRemote;
            this.recvCount = 0;
            this.prevSendCount = 0;
        }
        this._skipMessageKeys(dhRemote, header.n);
        const { messageKey, chainKey } = kdfCk(this.receivingChainKey);
        this.receivingChainKey = chainKey;
        const mk = messageKey;
        this.recvCount = header.n + 1;
        return aeadDecrypt(mk, nonce, ciphertext, ad).toString('utf8');
    }

    serialize() {
        return {
            rootKey: b64(this.rootKey),
            sendingChainKey: this.sendingChainKey ? b64(this.sendingChainKey) : null,
            receivingChainKey: this.receivingChainKey ? b64(this.receivingChainKey) : null,
            dhSelf: { publicKey: b64(this.dhSelf.publicKey), privateKey: b64(this.dhSelf.privateKey) },
            dhRemote: this.dhRemote ? b64(this.dhRemote) : null,
            sendCount: this.sendCount, recvCount: this.recvCount, prevSendCount: this.prevSendCount,
            skipped: [...this.skipped.entries()].map(([k, v]) => [k, b64(v)]),
        };
    }

    static parse(data) {
        return new DoubleRatchetSession({
            rootKey: unb64(data.rootKey),
            sendingChainKey: data.sendingChainKey ? unb64(data.sendingChainKey) : null,
            receivingChainKey: data.receivingChainKey ? unb64(data.receivingChainKey) : null,
            dhSelf: { publicKey: unb64(data.dhSelf.publicKey), privateKey: unb64(data.dhSelf.privateKey) },
            dhRemote: data.dhRemote ? unb64(data.dhRemote) : null,
            sendCount: data.sendCount, recvCount: data.recvCount, prevSendCount: data.prevSendCount,
            skipped: new Map((data.skipped || []).map(([k, v]) => [k, unb64(v)])),
        });
    }
}

// Canonical authenticated-header encoding (P0-B). Fixed field order and
// delimiter; no JSON, no whitespace ambiguity — byte-identical across
// implementations.
function canonicalHeader(header) {
    if (!header || typeof header.dh !== 'string' || !Number.isInteger(header.pn) || !Number.isInteger(header.n)) {
        throw new Error('E2EE_INVALID_HEADER');
    }
    return `${HEADER_PREFIX}|${header.dh}|${header.pn}|${header.n}`;
}

// AEAD associated data: context binding || canonical header (Signal: AD' =
// AD || header). A ciphertext is bound to protocol version, conversation,
// sender device, sender identity AND recipient identity, so a valid
// ciphertext cannot be transplanted to another conversation or context and
// remain authentic. Every header byte (dh, pn, n) is authenticated.
function messageAssociatedData(context, header) {
    if (!context || typeof context.conversationId !== 'string'
        || typeof context.senderDeviceId !== 'string'
        || typeof context.senderIdentityKey !== 'string'
        || typeof context.recipientIdentityKey !== 'string') {
        throw new Error('E2EE_INVALID_CONTEXT');
    }
    const ad = `${AD_PREFIX}|${context.conversationId}|${context.senderDeviceId}|${context.senderIdentityKey}|${context.recipientIdentityKey}`;
    return Buffer.concat([Buffer.from(ad, 'utf8'), Buffer.from(canonicalHeader(header), 'utf8')]);
}

module.exports = {
    init, PROTOCOL_VERSION, MAX_SKIP, MAX_SKIPPED_CACHE,
    canonicalHeader, messageAssociatedData,
    hmacSha256, hkdfSha256, b64, unb64, dh,
    verifyDeviceBinding, verifySignedPreKeySignature,
    initiateX3DH, acceptX3DH,
    kdfRk, kdfCk, messageNonce, aeadEncrypt, aeadDecrypt,
    DoubleRatchetSession,
};
