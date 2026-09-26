// services/e2eeService.js
// =============================================================================
// End-to-End Encryption Service — Signal-style Protocol
//
// Implements:
//   1. X3DH-like key agreement (using libsodium crypto_box for DH exchange)
//   2. Double Ratchet (simplified — per-message keys derived via KDF chain)
//   3. PreKey bundle generation and registration
//   4. Message encryption/decryption
//
// Key Flow:
//   • Each user generates an Ed25519 identity key pair (for signing)
//   • Identity key is converted to X25519 for DH key agreement
//   • PreKeys are X25519 keypairs (used for DH exchange)
//   • To start a session, sender fetches receiver's preKey bundle
//   • X3DH derives shared secret → root key → chain keys → message keys
//   • Each message advances the ratchet, deriving a new message key
//
// Trade-offs:
//   • E2EE means server can't do message search → client-side search
//   • Dispute evidence: both parties upload message history encrypted with admin key
//
// Reference: Signal Protocol, WhatsApp (Signal Protocol), Wire (E2EE enterprise)
// =============================================================================

const _sodium = require('libsodium-wrappers');

let sodium = null;
async function init() {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  return sodium;
}

// ── Key Generation ────────────────────────────────────────────────────────────

/**
 * Generate a user's identity key pair (Ed25519 for signing).
 * The public key is also convertible to X25519 for DH key agreement.
 */
async function generateIdentityKeyPair() {
  const s = await init();
  const kp = s.crypto_sign_keypair();
  return {
    publicKey: s.to_base64(kp.publicKey),
    privateKey: s.to_base64(kp.privateKey),
  };
}

/**
 * Convert an Ed25519 public key to X25519 (Curve25519) for DH.
 */
async function ed25519PubToCurve25519(ed25519PubB64) {
  const s = await init();
  const ed = s.from_base64(ed25519PubB64);
  const curve = s.crypto_sign_ed25519_pk_to_curve25519(ed);
  return s.to_base64(curve);
}

/**
 * Convert an Ed25519 private key to X25519 (Curve25519) for DH.
 */
async function ed25519PrivToCurve25519(ed25519PrivB64) {
  const s = await init();
  const ed = s.from_base64(ed25519PrivB64);
  const curve = s.crypto_sign_ed25519_sk_to_curve25519(ed);
  return s.to_base64(curve);
}

/**
 * Generate a signed preKey (X25519 keypair signed with Ed25519 identity key).
 * The signed preKey is used for DH; its public key is signed for authenticity.
 */
async function generateSignedPreKey(identityPrivateKey) {
  const s = await init();
  const kp = s.crypto_box_keypair(); // X25519
  const privKey = s.from_base64(identityPrivateKey); // Ed25519
  const signature = s.crypto_sign_detached(kp.publicKey, privKey);

  return {
    keyId: s.randombytes_uniform(0xFFFFFF),
    publicKey: s.to_base64(kp.publicKey),
    privateKey: s.to_base64(kp.privateKey),
    signature: s.to_base64(signature),
  };
}

/**
 * Generate a batch of one-time preKeys (X25519 keypairs, consumed on each session start).
 */
async function generatePreKeys(count = 50) {
  const s = await init();
  const keys = [];
  for (let i = 0; i < count; i++) {
    const kp = s.crypto_box_keypair();
    keys.push({
      keyId: s.randombytes_uniform(0xFFFFFF),
      publicKey: s.to_base64(kp.publicKey),
      privateKey: s.to_base64(kp.privateKey),
    });
  }
  return keys;
}

// ── Session Establishment (X3DH-like) ────────────────────────────────────────

/**
 * Establish a session using the receiver's preKey bundle.
 * Derives a shared root key using DH + KDF.
 *
 * @param {Object} receiverBundle - { identityPublicKey (Ed25519), signedPreKeyPublicKey (X25519), signedPreKeySignature, oneTimePreKeyPublicKey (X25519) }
 * @param {Object} senderIdentity - { publicKey (Ed25519), privateKey (Ed25519) }
 * @returns {Object} { rootKey, ephemeralPublicKey (X25519) }
 */
async function establishSession(receiverBundle, senderIdentity) {
  const s = await init();

  // 1. Verify the signed preKey signature with receiver's Ed25519 identity key
  const identityPub = s.from_base64(receiverBundle.identityPublicKey);
  const signedPreKeyPub = s.from_base64(receiverBundle.signedPreKeyPublicKey);
  const signature = s.from_base64(receiverBundle.signedPreKeySignature);

  if (!s.crypto_sign_verify_detached(signature, signedPreKeyPub, identityPub)) {
    throw new Error('Signed preKey signature verification failed');
  }

  // 2. Convert sender's Ed25519 identity key to X25519 for DH
  const senderCurvePriv = s.crypto_sign_ed25519_sk_to_curve25519(
    s.from_base64(senderIdentity.privateKey)
  );

  // 3. Generate ephemeral X25519 key pair for this session
  const ephemeralKp = s.crypto_box_keypair();

  // 4. DH: sender_identity_priv × receiver_signed_prekey_pub
  const dh1 = s.crypto_scalarmult(senderCurvePriv, signedPreKeyPub);

  // 5. DH: ephemeral_priv × receiver_signed_prekey_pub
  const dh2 = s.crypto_scalarmult(ephemeralKp.privateKey, signedPreKeyPub);

  // 6. Optionally: DH: ephemeral_priv × receiver_one_time_prekey_pub
  let dh3 = null;
  if (receiverBundle.oneTimePreKeyPublicKey) {
    const otpPub = s.from_base64(receiverBundle.oneTimePreKeyPublicKey);
    dh3 = s.crypto_scalarmult(ephemeralKp.privateKey, otpPub);
  }

  // 7. KDF: combine DH outputs into root key
  const dhCombined = dh3
    ? new Uint8Array([...dh1, ...dh2, ...dh3])
    : new Uint8Array([...dh1, ...dh2]);

  const rootKey = s.crypto_generichash(
    s.crypto_generichash_BYTES, // 32 bytes
    dhCombined
  );

  return {
    rootKey: s.to_base64(rootKey),
    ephemeralPublicKey: s.to_base64(ephemeralKp.publicKey),
  };
}

/**
 * Accept a session on the receiver side using the sender's ephemeral key
 * and the receiver's signed preKey private key (+ one-time preKey private key).
 *
 * @param {string} ephemeralPublicKey - Sender's ephemeral X25519 public key
 * @param {string} signedPreKeyPrivateKey - Receiver's signed preKey private key (X25519)
 * @param {string} oneTimePreKeyPrivateKey - Receiver's one-time preKey private key (X25519, optional)
 * @param {string} senderIdentityPublicKey - Sender's Ed25519 public key
 * @param {string} receiverIdentityPrivateKey - Receiver's Ed25519 private key (for DH conversion)
 * @returns {Object} { rootKey }
 */
async function acceptSession(ephemeralPublicKey, signedPreKeyPrivateKey, oneTimePreKeyPrivateKey, senderIdentityPublicKey, receiverIdentityPrivateKey) {
  const s = await init();
  const ephPub = s.from_base64(ephemeralPublicKey);
  const spkPriv = s.from_base64(signedPreKeyPrivateKey);

  // 1. Convert receiver's Ed25519 identity key to X25519 for DH
  const receiverCurvePriv = s.crypto_sign_ed25519_sk_to_curve25519(
    s.from_base64(receiverIdentityPrivateKey)
  );

  // 2. Convert sender's Ed25519 identity key to X25519 for DH
  const senderCurvePub = s.crypto_sign_ed25519_pk_to_curve25519(
    s.from_base64(senderIdentityPublicKey)
  );

  // 3. DH: receiver_identity_priv × sender_identity_pub (both X25519)
  const dh1 = s.crypto_scalarmult(receiverCurvePriv, senderCurvePub);

  // 4. DH: receiver_signed_prekey_priv × sender_ephemeral_pub
  const dh2 = s.crypto_scalarmult(spkPriv, ephPub);

  // 5. Optionally: DH: receiver_onetime_prekey_priv × sender_ephemeral_pub
  let dh3 = null;
  if (oneTimePreKeyPrivateKey) {
    const otpPriv = s.from_base64(oneTimePreKeyPrivateKey);
    dh3 = s.crypto_scalarmult(otpPriv, ephPub);
  }

  // 6. KDF: combine DH outputs into root key (same order as establishSession)
  const dhCombined = dh3
    ? new Uint8Array([...dh1, ...dh2, ...dh3])
    : new Uint8Array([...dh1, ...dh2]);

  const rootKey = s.crypto_generichash(
    s.crypto_generichash_BYTES,
    dhCombined
  );

  return { rootKey: s.to_base64(rootKey) };
}

// ── Double Ratchet (Simplified) ─────────────────────────────────────────────

/**
 * Derive the next message key from the current chain key.
 * KDF chain: chainKey → KDF(chainKey, 0x01) = messageKey
 *                    → KDF(chainKey, 0x02) = newChainKey
 */
async function deriveMessageKey(chainKey) {
  const s = await init();
  const ck = s.from_base64(chainKey);

  const messageKey = s.crypto_generichash(32, new Uint8Array([...ck, 0x01]));
  const newChainKey = s.crypto_generichash(32, new Uint8Array([...ck, 0x02]));

  return {
    messageKey: s.to_base64(messageKey),
    chainKey: s.to_base64(newChainKey),
  };
}

/**
 * Initialize a ratchet from the root key.
 * Derives initial sending chain key.
 */
async function initRatchet(rootKey) {
  const s = await init();
  const rk = s.from_base64(rootKey);

  const chainKey = s.crypto_generichash(32, new Uint8Array([...rk, 0x03]));
  const nextRootKey = s.crypto_generichash(32, new Uint8Array([...rk, 0x04]));

  return {
    rootKey: s.to_base64(nextRootKey),
    chainKey: s.to_base64(chainKey),
    messageNumber: 0,
  };
}

// ── Message Encryption/Decryption ────────────────────────────────────────────

/**
 * Encrypt a message using crypto_secretbox (authenticated symmetric encryption).
 *
 * @param {string} messageKey - Base64 32-byte key
 * @param {string} plaintext - Message to encrypt
 * @returns {Object} { ciphertext, nonce } — both base64
 */
async function encryptMessage(messageKey, plaintext) {
  const s = await init();
  const key = s.from_base64(messageKey);
  const message = s.from_string(plaintext);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);

  const ciphertext = s.crypto_secretbox_easy(message, nonce, key);

  return {
    ciphertext: s.to_base64(ciphertext),
    nonce: s.to_base64(nonce),
  };
}

/**
 * Decrypt a message using crypto_secretbox.
 */
async function decryptMessage(messageKey, ciphertextB64, nonceB64) {
  const s = await init();
  const key = s.from_base64(messageKey);
  const ciphertext = s.from_base64(ciphertextB64);
  const nonce = s.from_base64(nonceB64);

  const decrypted = s.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (!decrypted) {
    throw new Error('Decryption failed — message may have been tampered with');
  }

  return s.to_string(decrypted);
}

// ── Full Encrypt/Decrypt Flow (ratchet + encrypt) ────────────────────────────

/**
 * Full encrypt: derive next message key from chain, then encrypt plaintext.
 * Returns the encrypted payload + updated chain state.
 *
 * @param {Object} session - { chainKey, messageNumber }
 * @param {string} plaintext
 * @returns {Object} { ciphertext, nonce, messageNumber, newChainKey }
 */
async function encrypt(session, plaintext) {
  const { messageKey, chainKey } = await deriveMessageKey(session.chainKey);
  const { ciphertext, nonce } = await encryptMessage(messageKey, plaintext);

  return {
    ciphertext,
    nonce,
    messageNumber: session.messageNumber,
    newChainKey: chainKey,
  };
}

/**
 * Full decrypt: given the same chain state, derive the message key and decrypt.
 */
async function decrypt(session, ciphertextB64, nonceB64) {
  const { messageKey } = await deriveMessageKey(session.chainKey);
  return decryptMessage(messageKey, ciphertextB64, nonceB64);
}

// ── Dispute Evidence ─────────────────────────────────────────────────────────

/**
 * Encrypt message history for dispute evidence using an admin public key.
 * Uses crypto_box_seal (sealed box — sender anonymous, receiver can open).
 *
 * @param {string} adminPublicKey - Admin's X25519 public key (base64)
 * @param {Array} messages - Array of { plaintext, timestamp, senderId }
 * @returns {string} Encrypted evidence blob (base64)
 */
async function encryptEvidenceForAdmin(adminPublicKey, messages) {
  const s = await init();
  const pubKey = s.from_base64(adminPublicKey);
  const data = s.from_string(JSON.stringify(messages));

  const sealed = s.crypto_box_seal(data, pubKey);
  return s.to_base64(sealed);
}

/**
 * Decrypt dispute evidence using admin key pair.
 */
async function decryptEvidence(adminKeyPair, evidenceB64) {
  const s = await init();
  const pubKey = s.from_base64(adminKeyPair.publicKey);
  const privKey = s.from_base64(adminKeyPair.privateKey);
  const evidence = s.from_base64(evidenceB64);

  const decrypted = s.crypto_box_seal_open(evidence, pubKey, privKey);
  return JSON.parse(s.to_string(decrypted));
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Generate a fingerprint for a public key (for safety number verification).
 * Users compare fingerprints to verify they're talking to the right person.
 */
async function fingerprint(publicKey) {
  const s = await init();
  const key = s.from_base64(publicKey);
  const hash = s.crypto_generichash(s.crypto_generichash_BYTES, key);
  const hex = s.to_hex(hash).toUpperCase();
  return hex.match(/.{1,5}/g).join(' ');
}

module.exports = {
  init,
  generateIdentityKeyPair,
  ed25519PubToCurve25519,
  ed25519PrivToCurve25519,
  generateSignedPreKey,
  generatePreKeys,
  establishSession,
  acceptSession,
  deriveMessageKey,
  initRatchet,
  encryptMessage,
  decryptMessage,
  encrypt,
  decrypt,
  encryptEvidenceForAdmin,
  decryptEvidence,
  fingerprint,
};
