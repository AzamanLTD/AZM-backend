'use strict';

// services/e2eeService.js
// =============================================================================
// AZAMAN E2EE v2 — PROTOCOL REFERENCE LIBRARY (r40)
//
// Implements the documented protocol contract in docs/e2ee/PROTOCOL.md:
// Signal's X3DH (session establishment) + Signal's Double Ratchet
// (per-message keys, forward secrecy, out-of-order delivery) built ONLY on
// well-vetted primitives (libsodium + OpenSSL HKDF/HMAC). No ad-hoc
// constructions.
//
// TRUST MODEL — the server is a blind relay:
//   • The server never generates, stores, or sees private key material.
//   • The server never derives or stores session/ratchet state.
//   • The functions below that touch private keys exist for CLIENTS and for
//     the invariant proof suite (they are the documented reference
//     implementation). The server routes (routes/e2eeRoutes.js) use only the
//     public-side helpers (validation, fingerprints, bundle verification).
//
// This module is PURE — no database, no I/O. Ratchet state objects are
// immutable: every operation returns a NEW state object (the Double Ratchet
// is a state machine; making transitions explicit is what makes replay and
// out-of-order behavior provable).
//
// Documented deviations from the Signal specs are listed in PROTOCOL.md §2:
// dual-key identity (Ed25519 signing + X25519 DH) instead of XEdDSA; HKDF
// info strings domain-separate each KDF; the AEAD nonce is deterministic
// (u32be(0) || u64be(n)) — safe because message keys are single-use.
// =============================================================================

const { createHmac, hkdfSync } = require('crypto');
const _sodium = require('libsodium-wrappers');

const PROTOCOL_VERSION = 2;
const MAX_SKIP = 1000; // retained skipped message keys per chain (PROTOCOL.md §5)
const MAX_PREKEY_ID = 0xFFFFFF; // 2^24 - 1

let _s = null;
async function _ready() {
    if (!_s) { await _sodium.ready; _s = _sodium; }
    return _s;
}

// ── Byte helpers ─────────────────────────────────────────────────────────────

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (str) => new Uint8Array(Buffer.from(str, 'base64'));

function u64be(n) {
    const out = new Uint8Array(8);
    let v = n;
    for (let i = 7; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
    return out;
}

function concat(...arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

const utf8 = (str) => new Uint8Array(Buffer.from(str, 'utf8'));

// ── KDFs (PROTOCOL.md §5) ────────────────────────────────────────────────────

const X3DH_INFO = 'AzamanE2EE-v2-X3DH';
const KDF_RK_INFO = 'AzamanE2EE-v2-KDF_RK';
const ZERO_SALT = new Uint8Array(32);

function hkdfSha512(ikm, info, length) {
    const out = hkdfSync('sha512', Buffer.from(ikm), Buffer.from(ZERO_SALT), Buffer.from(info, 'utf8'), length);
    return new Uint8Array(out);
}

// KDF_RK(rk, dh_out) -> (rk', ck) — HKDF-SHA-512, split at 32 bytes.
function kdfRk(rootKey, dhOut) {
    const out = hkdfSha512(concat(rootKey, dhOut), KDF_RK_INFO, 64);
    return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

// KDF_CK(ck) -> (mk, ck') — HMAC-SHA-256 over 0x01 / 0x02.
function kdfCk(chainKey) {
    const mk = new Uint8Array(createHmac('sha256', Buffer.from(chainKey)).update(new Uint8Array([0x01])).digest());
    const next = new Uint8Array(createHmac('sha256', Buffer.from(chainKey)).update(new Uint8Array([0x02])).digest());
    return { messageKey: mk, chainKey: next };
}

// ── X25519 primitives ─────────────────────────────────────────────────────────

function dh(privateKey, publicKey) {
    const out = _s.crypto_scalarmult(privateKey, publicKey);
    if (!out) throw Object.assign(new Error('X25519: low-order public key rejected.'), { code: 'E2EE_INVALID_KEY' });
    return out;
}

function generateDhKeyPair() {
    const kp = _s.crypto_box_keypair();
    return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// ── Key generation (client-side; exported for clients and the proof suite) ───

async function generateIdentityKeys() {
    const s = await _ready();
    const signing = s.crypto_sign_keypair();
    const dhIdentity = s.crypto_box_keypair();
    const identityKeySignature = s.crypto_sign_detached(dhIdentity.publicKey, signing.privateKey);
    return {
        identityKey: { publicKey: b64(signing.publicKey), privateKey: b64(signing.privateKey) },          // Ed25519
        identityDhKey: { publicKey: b64(dhIdentity.publicKey), privateKey: b64(dhIdentity.privateKey) },  // X25519
        identityKeySignature: b64(identityKeySignature),
    };
}

async function generateSignedPreKey(identityPrivateKeyB64) {
    const s = await _ready();
    const kp = s.crypto_box_keypair();
    const signature = s.crypto_sign_detached(kp.publicKey, unb64(identityPrivateKeyB64));
    return {
        keyId: s.randombytes_uniform(MAX_PREKEY_ID),
        publicKey: b64(kp.publicKey),
        privateKey: b64(kp.privateKey),
        signature: b64(signature),
    };
}

async function generateOneTimePreKeys(count) {
    const s = await _ready();
    const keys = [];
    for (let i = 0; i < count; i++) {
        const kp = s.crypto_box_keypair();
        keys.push({
            keyId: s.randombytes_uniform(MAX_PREKEY_ID),
            publicKey: b64(kp.publicKey),
            privateKey: b64(kp.privateKey),
        });
    }
    return keys;
}

// ── Public-side validation (used by the server) ────────────────────────────────

const E32 = 'base64 string of 32 raw bytes';
const SIG = 'base64 string of 64 raw bytes (Ed25519 detached signature)';

function _invalid(msg, code = 'E2EE_INVALID_BUNDLE') {
    return Object.assign(new Error(msg), { code, status: 400 });
}

async function validateBundle({ identityPublicKey, identityDhPublicKey, identityKeySignature, signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature }) {
    const s = await _ready();
    if (typeof identityPublicKey !== 'string' || unb64(identityPublicKey).length !== s.crypto_sign_PUBLICKEYBYTES) {
        throw _invalid(`identityPublicKey must be a ${E32} (Ed25519 public key).`);
    }
    if (typeof identityDhPublicKey !== 'string' || unb64(identityDhPublicKey).length !== s.crypto_scalarmult_BYTES) {
        throw _invalid(`identityDhPublicKey must be a ${E32} (X25519 public key).`);
    }
    if (typeof identityKeySignature !== 'string' || unb64(identityKeySignature).length !== s.crypto_sign_BYTES) {
        throw _invalid(`identityKeySignature must be a ${SIG}.`);
    }
    if (!Number.isSafeInteger(signedPreKeyId) || signedPreKeyId < 0 || signedPreKeyId > MAX_PREKEY_ID) {
        throw _invalid(`signedPreKeyId must be an integer in [0, ${MAX_PREKEY_ID}].`);
    }
    if (typeof signedPreKeyPublicKey !== 'string' || unb64(signedPreKeyPublicKey).length !== s.crypto_scalarmult_BYTES) {
        throw _invalid(`signedPreKeyPublicKey must be a ${E32}.`);
    }
    if (typeof signedPreKeySignature !== 'string' || unb64(signedPreKeySignature).length !== s.crypto_sign_BYTES) {
        throw _invalid(`signedPreKeySignature must be a ${SIG}.`);
    }
    // Cryptographic binding: the identity key must sign BOTH its own DH half
    // and the signed prekey. A bundle that fails either is not this account's.
    if (!verifyBundleSignatures({ identityPublicKey, identityDhPublicKey, identityKeySignature, signedPreKeyPublicKey, signedPreKeySignature })) {
        throw _invalid('Bundle signature verification failed — the identity key does not sign the DH identity key and the signed prekey.');
    }
    return true;
}

function verifyBundleSignatures({ identityPublicKey, identityDhPublicKey, identityKeySignature, signedPreKeyPublicKey, signedPreKeySignature }) {
    const bindingOk = _s.crypto_sign_verify_detached(unb64(identityKeySignature), unb64(identityDhPublicKey), unb64(identityPublicKey));
    const prekeyOk = _s.crypto_sign_verify_detached(unb64(signedPreKeySignature), unb64(signedPreKeyPublicKey), unb64(identityPublicKey));
    return bindingOk && prekeyOk;
}

function validateOneTimePreKeys(payload, maxCount = 100) {
    if (!Array.isArray(payload) || payload.length === 0) {
        throw _invalid('oneTimePreKeys must be a non-empty array of {keyId, publicKey}.');
    }
    if (payload.length > maxCount) {
        throw _invalid(`At most ${maxCount} one-time preKeys per request.`);
    }
    for (const k of payload) {
        if (!k || typeof k !== 'object') throw _invalid('Each one-time preKey must be an object.');
        if (!Number.isSafeInteger(k.keyId) || k.keyId < 0 || k.keyId > MAX_PREKEY_ID) {
            throw _invalid(`oneTimePreKey keyId must be an integer in [0, ${MAX_PREKEY_ID}].`);
        }
        if (typeof k.publicKey !== 'string' || unb64(k.publicKey).length !== _s.crypto_scalarmult_BYTES) {
            throw _invalid(`oneTimePreKey publicKey must be a ${E32}.`);
        }
    }
    return true;
}

// Safety number (PROTOCOL.md §3): BLAKE2b-256 of the Ed25519 identity pub.
async function fingerprint(identityPublicKey) {
    const s = await _ready();
    const hash = s.crypto_generichash(s.crypto_generichash_BYTES, unb64(identityPublicKey));
    return s.to_hex(hash).toUpperCase().match(/.{1,5}/g).join(' ');
}

// ── X3DH (PROTOCOL.md §4) ─────────────────────────────────────────────────────

// Session associated data: initiator's Ed25519 identity pub first.
const sessionAD = (initiatorIdentityPubB64, responderIdentityPubB64) =>
    `${initiatorIdentityPubB64}|${responderIdentityPubB64}`;

function x3dhSecret(dh1, dh2, dh3, dh4) {
    const parts = dh4 ? [ZERO_SALT, dh1, dh2, dh3, dh4] : [ZERO_SALT, dh1, dh2, dh3];
    return hkdfSha512(concat(...parts), X3DH_INFO, 64).slice(0, 32);
}

/**
 * Initiator side (A). A has verified B's bundle (fetched with an atomically
 * claimed one-time prekey if any remained).
 *
 * Terms (PROTOCOL.md §4):
 *   DH1 = DH(identityDhKey_A_priv, signedPreKey_B_pub)
 *   DH2 = DH(ekA_priv, identityDhKey_B_pub)
 *   DH3 = DH(ekA_priv, signedPreKey_B_pub)
 *   DH4 = DH(ekA_priv, oneTimePreKey_B_pub)   [optional]
 */
async function x3dhInitiate({ peerBundle, identityDhPrivateKey, identityPublicKey, peerIdentityPublicKey, ephemeralKeyPair }) {
    await _ready();
    const ek = ephemeralKeyPair || generateDhKeyPair();
    const spk = unb64(peerBundle.signedPreKeyPublicKey);
    const dh1 = dh(unb64(identityDhPrivateKey), spk);
    const dh2 = dh(ek.privateKey, unb64(peerBundle.identityDhPublicKey));
    const dh3 = dh(ek.privateKey, spk);
    let dh4 = null;
    if (peerBundle.oneTimePreKey && peerBundle.oneTimePreKey.publicKey) {
        dh4 = dh(ek.privateKey, unb64(peerBundle.oneTimePreKey.publicKey));
    }
    const rootKey = x3dhSecret(dh1, dh2, dh3, dh4);
    return {
        rootKey,
        ephemeralKeyPair: ek,
        ephemeralPublicKey: b64(ek.publicKey),
        associatedData: sessionAD(identityPublicKey, peerIdentityPublicKey),
        usedOneTimePreKeyId: dh4 && peerBundle.oneTimePreKey ? peerBundle.oneTimePreKey.keyId : null,
    };
}

/**
 * Responder side (B). Mirrors the SAME DH terms with B's private halves, in
 * the SAME concatenation order (each mirrored pair produces identical bytes):
 *   DH1' = DH(signedPreKey_priv, identityDhKey_A_pub)
 *   DH2' = DH(identityDhKey_B_priv, ekA_pub)
 *   DH3' = DH(signedPreKey_priv, ekA_pub)
 *   DH4' = DH(oneTimePreKey_priv, ekA_pub)   [optional]
 */
async function x3dhRespond({ ephemeralPublicKey, initiatorIdentityDhPublicKey, identityDhPrivateKey, signedPreKeyPrivateKey, oneTimePreKeyPrivateKey, identityPublicKey, initiatorIdentityPublicKey }) {
    await _ready();
    const ek = unb64(ephemeralPublicKey);
    const ikA = unb64(initiatorIdentityDhPublicKey);
    const dh1 = dh(unb64(signedPreKeyPrivateKey), ikA);
    const dh2 = dh(unb64(identityDhPrivateKey), ek);
    const dh3 = dh(unb64(signedPreKeyPrivateKey), ek);
    let dh4 = null;
    if (oneTimePreKeyPrivateKey) {
        dh4 = dh(unb64(oneTimePreKeyPrivateKey), ek);
    }
    const rootKey = x3dhSecret(dh1, dh2, dh3, dh4);
    return {
        rootKey,
        associatedData: sessionAD(initiatorIdentityPublicKey, identityPublicKey),
    };
}

// ── Double Ratchet (PROTOCOL.md §5) ────────────────────────────────────────────

// Alice (initiator): DHs = X3DH ephemeral, DHr = B's signed prekey pub.
function initiatorRatchet(rootKey, ephemeralKeyPair, peerSignedPreKeyPublicKey) {
    const { rootKey: rk, chainKey } = kdfRk(rootKey, dh(ephemeralKeyPair.privateKey, unb64(peerSignedPreKeyPublicKey)));
    return {
        protocolVersion: PROTOCOL_VERSION,
        rootKey: rk,
        dhs: { publicKey: ephemeralKeyPair.publicKey, privateKey: ephemeralKeyPair.privateKey },
        dhr: unb64(peerSignedPreKeyPublicKey),
        cks: chainKey,
        ckr: null,
        ns: 0, nr: 0, pn: 0,
        mkSkipped: {}, // `${b64(dhr)}|${n}` -> base64 message key
    };
}

// Bob (responder): DHs = signed prekey pair, DHr = None. His first RECEIVED
// message performs the DH ratchet step that creates his sending chain
// (exactly the Double Ratchet spec's responder initialization).
function responderRatchet(rootKey, signedPreKeyPair) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        rootKey,
        dhs: { publicKey: signedPreKeyPair.publicKey, privateKey: signedPreKeyPair.privateKey },
        dhr: null,
        cks: null,
        ckr: null,
        ns: 0, nr: 0, pn: 0,
        mkSkipped: {},
    };
}

// Deterministic AEAD nonce: u32be(0) || u64be(n). Message keys are single-use,
// so (key, nonce) pairs never repeat (PROTOCOL.md §5).
function messageNonce(n) {
    return concat(new Uint8Array([0, 0, 0, 0]), u64be(n));
}

// AEAD associated data binds the session identities AND the exact ratchet
// header bytes (tampered/mismatched headers fail decryption).
function messageAD(sessionAd, header) {
    return utf8(`${sessionAd}|${header.v}|${header.dh}|${header.pn}|${header.n}`);
}

function aeadEncrypt(messageKey, nonce, plaintext, aad) {
    const ct = _s.crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, messageKey);
    return b64(ct);
}

function aeadDecrypt(messageKey, nonce, cipherTextB64, aad) {
    try {
        // libsodium.js wrapper signature (verified against the installed
        // version): decrypt(secret_nonce, ciphertext, additional_data,
        // public_nonce, key). secret_nonce is always null for ChaCha20-
        // Poly1305 (IETF variant does not use it).
        return _s.crypto_aead_chacha20poly1305_ietf_decrypt(null, unb64(cipherTextB64), aad, nonce, messageKey);
    } catch {
        throw Object.assign(new Error('AEAD authentication failed — ciphertext tampered or wrong key.'), { code: 'E2EE_DECRYPT_FAILED', status: 400 });
    }
}

function _skipMessageKeys(state, until) {
    if (until - state.nr > MAX_SKIP) {
        throw Object.assign(
            new Error(`Out-of-order window exceeded (${until - state.nr} > ${MAX_SKIP}) — refusing to derive unbounded message keys.`),
            { code: 'E2EE_TOO_FAR_BEHIND', status: 400 },
        );
    }
    let { ckr, nr } = state;
    const mkSkipped = { ...state.mkSkipped };
    if (ckr) {
        while (nr < until) {
            const { messageKey, chainKey } = kdfCk(ckr);
            mkSkipped[`${b64(state.dhr)}|${nr}`] = b64(messageKey);
            ckr = chainKey;
            nr += 1;
        }
    }
    return { ckr, nr, mkSkipped };
}

function _dhRatchetStep(state, header) {
    // Receiver-side DH ratchet step (lockstep with the peer, verified by the
    // proof suite): the NEW RECEIVING chain is derived FIRST with the CURRENT
    // (old) own ratchet key — this is the mirror of the peer's sending chain,
    // which it derived as KDF_RK(RK, DH(its_new_key, our_old_public)).
    // Only then does this party rotate its own ratchet keypair and derive its
    // new SENDING chain, which the peer will mirror on its next receive.
    // Deriving them in the other order breaks the lockstep and is exactly the
    // class of bug this rewrite exists to prevent.
    const pn = state.ns; // our previous sending chain length (peer's header.pn)
    const recvStep = kdfRk(state.rootKey, dh(state.dhs.privateKey, unb64(header.dh)));
    const newPair = generateDhKeyPair();
    const sendStep = kdfRk(recvStep.rootKey, dh(newPair.privateKey, unb64(header.dh)));
    return {
        ...state,
        rootKey: sendStep.rootKey,
        dhs: newPair,
        dhr: unb64(header.dh),
        cks: sendStep.chainKey,
        ckr: recvStep.chainKey,
        ns: 0, nr: 0, pn,
    };
}

/**
 * Encrypt one message. Returns header, base64 ciphertext, and the NEW state.
 * The old state is NOT mutated — callers must persist the returned state.
 * The message key is consumed by advancing the chain, so a second call on
 * the same state can never re-derive it: nonce reuse is impossible under
 * this API.
 */
function ratchetEncrypt(state, plaintext, sessionAd) {
    if (!state.cks) {
        throw Object.assign(new Error('No sending chain — this party must receive a message first (Double Ratchet initialization).'), { code: 'E2EE_NO_SENDING_CHAIN', status: 400 });
    }
    const { messageKey, chainKey } = kdfCk(state.cks);
    const header = { v: PROTOCOL_VERSION, dh: b64(state.dhs.publicKey), pn: state.pn, n: state.ns };
    const cipherText = aeadEncrypt(messageKey, messageNonce(state.ns), utf8(plaintext), messageAD(sessionAd, header));
    return {
        header,
        cipherText,
        state: { ...state, cks: chainKey, ns: state.ns + 1 },
    };
}

/**
 * Decrypt one message (out-of-order delivery via MKSKIPPED; DH ratchet step
 * on new remote ratchet keys). Returns plaintext and the NEW state.
 */
function ratchetDecrypt(state, header, cipherText, sessionAd) {
    if (!header || typeof header !== 'object' || header.v !== PROTOCOL_VERSION) {
        throw Object.assign(new Error('Unsupported or missing ratchet header version.'), { code: 'E2EE_BAD_HEADER', status: 400 });
    }
    if (typeof header.dh !== 'string' || !Number.isSafeInteger(header.pn) || !Number.isSafeInteger(header.n) || header.pn < 0 || header.n < 0) {
        throw Object.assign(new Error('Malformed ratchet header.'), { code: 'E2EE_BAD_HEADER', status: 400 });
    }
    let s = state;

    // Out-of-order within a known chain: the message key was retained.
    const skippedKey = `${header.dh}|${header.n}`;
    if (s.mkSkipped[skippedKey] !== undefined) {
        const mk = unb64(s.mkSkipped[skippedKey]);
        const mkSkipped = { ...s.mkSkipped };
        delete mkSkipped[skippedKey];
        const plaintextBytes = aeadDecrypt(mk, messageNonce(header.n), cipherText, messageAD(sessionAd, header));
        return { plaintext: Buffer.from(plaintextBytes).toString('utf8'), state: { ...s, mkSkipped } };
    }

    // New remote ratchet key → close the old receiving chain, ratchet.
    if (!s.dhr || b64(s.dhr) !== header.dh) {
        const skipped = _skipMessageKeys(s, header.pn);
        s = { ...s, ckr: skipped.ckr, nr: skipped.nr, mkSkipped: skipped.mkSkipped };
        s = _dhRatchetStep(s, header);
    }

    // Skip to the message's position in the current receiving chain.
    const skipped2 = _skipMessageKeys(s, header.n);
    s = { ...s, ckr: skipped2.ckr, nr: skipped2.nr, mkSkipped: skipped2.mkSkipped };
    const { messageKey, chainKey } = kdfCk(s.ckr);
    const plaintextBytes = aeadDecrypt(messageKey, messageNonce(header.n), cipherText, messageAD(sessionAd, header));
    return {
        plaintext: Buffer.from(plaintextBytes).toString('utf8'),
        state: { ...s, ckr: chainKey, nr: header.n + 1 },
    };
}

// ── State serialization (client persistence; byte-stable) ─────────────────────

function serializeState(state) {
    return {
        protocolVersion: state.protocolVersion,
        rootKey: b64(state.rootKey),
        dhs: { publicKey: b64(state.dhs.publicKey), privateKey: b64(state.dhs.privateKey) },
        dhr: state.dhr ? b64(state.dhr) : null,
        cks: state.cks ? b64(state.cks) : null,
        ckr: state.ckr ? b64(state.ckr) : null,
        ns: state.ns, nr: state.nr, pn: state.pn,
        mkSkipped: state.mkSkipped,
    };
}

function deserializeState(ser) {
    return {
        protocolVersion: ser.protocolVersion,
        rootKey: unb64(ser.rootKey),
        dhs: { publicKey: unb64(ser.dhs.publicKey), privateKey: unb64(ser.dhs.privateKey) },
        dhr: ser.dhr ? unb64(ser.dhr) : null,
        cks: ser.cks ? unb64(ser.cks) : null,
        ckr: ser.ckr ? unb64(ser.ckr) : null,
        ns: ser.ns, nr: ser.nr, pn: ser.pn,
        mkSkipped: { ...ser.mkSkipped },
    };
}

// ── Dispute evidence (unchanged contract; operates on client-supplied
// plaintext history for ADMIN dispute processing — explicitly NOT ordinary
// user-message confidentiality; see PROTOCOL.md §6 exclusions) ────────────────

async function encryptEvidenceForAdmin(adminPublicKey, messages) {
    const s = await _ready();
    return s.to_base64(s.crypto_box_seal(s.from_string(JSON.stringify(messages)), unb64(adminPublicKey)));
}

async function decryptEvidence(adminKeyPair, evidenceB64) {
    const s = await _ready();
    const opened = s.crypto_box_seal_open(unb64(evidenceB64), unb64(adminKeyPair.publicKey), unb64(adminKeyPair.privateKey));
    return JSON.parse(s.to_string(opened));
}

module.exports = {
    PROTOCOL_VERSION,
    MAX_SKIP,
    MAX_PREKEY_ID,
    // client + proofs
    generateIdentityKeys,
    generateSignedPreKey,
    generateOneTimePreKeys,
    x3dhInitiate,
    x3dhRespond,
    initiatorRatchet,
    responderRatchet,
    ratchetEncrypt,
    ratchetDecrypt,
    serializeState,
    deserializeState,
    sessionAD,
    // server-side (public data only)
    validateBundle,
    validateOneTimePreKeys,
    verifyBundleSignatures,
    fingerprint,
    // dispute evidence
    encryptEvidenceForAdmin,
    decryptEvidence,
};
