# Azaman E2EE v2 — Protocol Contract (r40)

Status: **authoritative contract**. This document is the single source of truth
for the end-to-end encryption protocol implemented by the backend reference
library (`services/e2eeService.js`), the Flutter client
(`lib/services/e2ee_service.dart`), and any future native client. Wire-level
details are byte-precise on purpose: two independent implementations that
follow this document interoperate without any other coordination.

## 1. Why v2 exists (and what it fixes)

The pre-r40 E2EE code failed its own security model:

1. **X3DH derivation mismatch.** `establishSession()` (sender side) derived
   `DH(IK_A, SPK_B) || DH(EK_A, SPK_B) [|| DH(EK_A, OPK_B)]`, while
   `acceptSession()` (receiver side) derived `DH(IK_B, IK_A) ||
   DH(SPK_B, EK_A) [|| DH(OPK_B, EK_A)]`. The DH terms do not match, so sender
   and receiver could never derive the same secret.
2. **Server-generated private keys.** `/api/e2ee/keys/init` generated identity,
   signed-prekey, and one-time-prekey keypairs **server-side**, persisted the
   private halves in PostgreSQL, and returned them to the client — while the
   Flutter client believed it registered its own device-generated public key
   (its `clientPublicKey` field was silently ignored).
3. **Server-held session state.** `E2EEPreKeyBundle.activeRootKey`,
   `activeChainKey`, and the entire `E2EESession` table (root/chain keys per
   peer pair) made the server a decryption authority; `GET
   /api/e2ee/session/:peerId` literally returned the keys.
4. **No ciphertext envelope.** `Message.content` stored plaintext, and the
   conversation APIs returned `msg.content` directly.

v2 is a protocol re-architecture, not a patch of those symptoms.

## 2. Protocol selection (explicit decision)

The chosen protocol is the **Signal Protocol as published**: X3DH
(Extended Triple Diffie-Hellman, Signal's X3DH specification) for session
establishment and the **Double Ratchet** (Signal's Double Ratchet
specification) for per-message key derivation, out-of-order delivery, and
forward secrecy. This is the same protocol family used by Signal and WhatsApp.

It is implemented on well-vetted cryptographic **primitives** — no custom
constructions:

| Primitive | Backend (Node) | Client (Flutter) |
|---|---|---|
| X25519 DH | `libsodium-wrappers` `crypto_scalarmult` | `cryptography` package `X25519` |
| Ed25519 signatures | `crypto_sign(_verify)_detached` | `cryptography` package `Ed25519` |
| HKDF-SHA-512 (RFC 5869) | Node `crypto.hkdfSync` (OpenSSL) | `cryptography` package `Hkdf/hmac sha512` |
| HMAC-SHA-256 | Node `crypto.createHmac` (OpenSSL) | `cryptography` package `Hmac(sha256)` |
| AEAD | `crypto_aead_chacha20poly1305_ietf` | `cryptography` package `Chacha20.poly1305Aead` |

**Explicit library decisions:**

- The existing Flutter dependency `pinenacl` **cannot** safely support this
  protocol: it exposes Box (XSalsa20-Poly1305) with no raw X25519 scalarmult,
  no detached Ed25519 signing, no HKDF, and no ChaCha20-Poly1305 AEAD. The
  Flutter E2EE module therefore uses the actively maintained pure-Dart
  `cryptography` package (v2.x), which provides every primitive above with
  byte-level control. This decision is deliberate and documented here.
- The backend keeps `libsodium-wrappers` (standard libsodium) plus Node's
  built-in OpenSSL HKDF/HMAC.

**Documented deviation from the Signal X3DH spec (deliberate):** Signal's spec
uses a single Curve25519 identity key with XEdDSA for signing. XEdDSA is not
exposed by `libsodium-wrappers` or by the Dart packages. v2 therefore uses the
**dual-key identity model** (the same approach Wire uses): each account has an
**Ed25519 signing identity key** and a separate **X25519 DH identity key**,
both generated on-device. The signing key signs (a) the DH identity key
(identity binding) and (b) every signed prekey. The X25519 identity key
participates in X3DH. The binding signature means a valid bundle proves both
keys belong to the same account registration.

## 3. Keys and identifiers

All key material is **base64 (standard alphabet, padded)** of the raw byte
strings below.

| Name | Type | Generated | Private half stored |
|---|---|---|---|
| `identityKey` (Ed25519) | signing keypair (32B pub / 64B priv) | device | device secure storage ONLY |
| `identityDhKey` (X25519) | DH keypair (32B/32B) | device | device secure storage ONLY |
| `identityKeySignature` | Ed25519 sig over `identityDhPublicKey` (64B) | device | n/a |
| `signedPreKey` (X25519) | DH keypair, `signedPreKeyId` ∈ [0, 2^24) | device | device secure storage ONLY |
| `signedPreKeySignature` | Ed25519 sig over `signedPreKeyPublicKey` (64B) | device | n/a |
| `oneTimePreKey` (X25519) | DH keypair, `keyId` ∈ [0, 2^24) | device | device secure storage ONLY |

The server stores **only the public halves** (plus the two signatures).
Private keys never leave the device, never transit the API, and never touch
the database. The server therefore cannot derive any X3DH output.

**Safety number** (`fingerprint`): BLAKE2b-256 (libsodium `crypto_generichash`,
32 bytes) of the raw Ed25519 identity public key, hex-encoded uppercase,
grouped into 5-character chunks separated by single spaces. Both users compare
out-of-band to bind the chat to the right human.

## 4. X3DH session establishment

Roles: **initiator A** (starts the session), **responder B**.

Preconditions: A has B's prekey bundle (fetched from `GET /api/e2ee/keys/:id`,
which atomically claims a one-time prekey if any remain). Both have valid
registered bundles.

Step 1 — A verifies B's bundle: `signedPreKeySignature` must verify against
B's `identityPublicKey` (Ed25519), and `identityKeySignature` must verify over
B's `identityDhPublicKey`. A failure aborts the session.

Step 2 — A generates a fresh ephemeral X25519 keypair `(ekA_pub, ekA_priv)`.

Step 3 — the four DH operations (exact terms; this is the Signal X3DH mapping
onto the dual-key model — `DH(x_priv, y_pub)` is X25519 scalarmult):

- `DH1 = DH(identityDhKey_A_priv, signedPreKey_B_pub)`
- `DH2 = DH(ekA_priv, identityDhKey_B_pub)`
- `DH3 = DH(ekA_priv, signedPreKey_B_pub)`
- `DH4 = DH(ekA_priv, oneTimePreKey_B_pub)` — only if a one-time prekey was
  claimed (omitted otherwise)

Step 4 — `SK = HKDF-SHA-512(ikm = F || DH1 || DH2 || DH3 [|| DH4],
salt = 32 zero bytes, info = "AzamanE2EE-v2-X3DH", L = 64)`, where `F` is 32
zero bytes (the X3DH spec's `F` convention for Curve25519). Output bytes
`[0..32)` are the **root key `SK_root`**; bytes `[32..64)` are reserved
(not used by v2).

B performs the identical computation with its private halves
(`DH(identityDhKey_B_priv, ...)` is the mirror of `DH2`, etc.). The DH terms
are pairwise mirrors: A's `DH2 = DH(ekA_priv, IK_B)` equals B's mirror
`DH(IK_B_priv, ekA_pub)`, and so on. **Invariant (proof-tested): both sides
derive byte-identical `SK_root`.**

**Associated data for the whole session:** `AD = concat(identityPublicKey_A_b64, "|", identityPublicKey_B_b64)` — the Ed25519 identity keys, in the fixed order (initiator first). AD is bound into every AEAD operation below.

## 5. Double Ratchet

State per (session, direction) held **on the devices only** — never sent to,
stored by, or derivable from the server. Notation follows Signal's Double
Ratchet spec. `MAX_SKIP = 1000` skipped message keys retained per chain for
out-of-order delivery; older gaps are refused with `E2EE_TOO_FAR_BEHIND`.

Key-derivation functions (all keys 32 bytes):

- `KDF_RK(rk, dh_out) = HKDF-SHA-512(ikm = rk || dh_out, salt = 32 zero
  bytes, info = "AzamanE2EE-v2-KDF_RK", L = 64)` → `(rk', ck)` split at 32.
- `KDF_CK(ck)`: `mk = HMAC-SHA-256(key = ck, data = 0x01)`,
  `ck' = HMAC-SHA-256(key = ck, data = 0x02)`.
- AEAD: ChaCha20-Poly1305 (IETF) with message key `mk`.
  **Nonce is deterministic — 12 bytes: `u32be(0) || u64be(n)`** where `n` is
  the header message number. Message keys are single-use (the chain advances on
  every encrypt), so `(mk, nonce)` pairs never repeat.

Init (A, initiator): `rk = SK_root`; `DHs = ekA` (the X3DH ephemeral becomes
A's first ratchet keypair); `DHr = signedPreKey_B_pub`;
`rk, CKs = KDF_RK(rk, DH(ekA_priv, DHr))`; `CKr = null`; `Ns = Nr = PN = 0`;
`MKSKIPPED = {}`.

Init (B, responder): `rk = SK_root`; `DHs = signedPreKey_B` (keypair);
`DHr = ekA_pub`; `rk, CKr = KDF_RK(rk, DH(SPK_priv, DHr))`; `CKs = null`;
`Ns = Nr = PN = 0`; `MKSKIPPED = {}`.

Encrypt (sender side, any party with a sending chain): advance `CKs` via
`KDF_CK`, `n = Ns; Ns += 1`; header = `{v: 2, dh: b64(DHs_pub), pn: PN, n}`.
`AEAD = Chacha20.poly1305Aead(mk, nonce(n), plaintext, AD_session_bytes)`.
On a DH ratchet step (receiving a message with a new `dh`), the receiver
performs the standard two-step ratchet: store skipped keys for the closing
receiving chain, then `rk, CKs = KDF_RK(rk, DH(DHs_priv, dh_new))` /
`PN = Nr` / `DHr = dh_new` / `rk, CKr = KDF_RK(rk, DH(new DHs_priv, DHr))`.
A party whose `CKs` is `null` (has not ratcheted yet) MUST perform a DH ratchet
step (generate a new ratchet keypair) before its first reply, exactly as in the
spec.

`AD_session_bytes` additionally authenticates the ratchet header bytes to
prevent header manipulation: `AEAD_AD = AD || "|" || v || "|" || dh_b64 ||
"|" || pn || "|" || n` (UTF-8 of the ASCII serialization; identical string on
both sides).

## 6. Ciphertext envelope (wire + storage format)

An encrypted TEXT message replaces plaintext `content` with this envelope.
Serialization is JSON; every field is byte-stable.

```
e2ee: {
  "version": 2,
  "header": { "v": 2, "dh": "<b64 ratchet pub>", "pn": <int>, "n": <int> },
  "cipherText": "<b64 (ciphertext||tag), ChaCha20-Poly1305 IETF>",
  "envelopeId": "<uuid v4, client-generated>"
}
```

- `Message.content` for an encrypted message is the **empty string**. The
  server never receives or stores the plaintext of an encrypted message.
- `envelopeId` is the replay anchor: the server dedups on it (unique index).
  A retry of the same send (timeout, reconnect, reload) reuses the same
  `envelopeId` and receives the original message row back — it can never create
  a duplicate delivery.
- The ratchet header is transmitted in the clear by design (as in Signal): it
  contains no secret, only public ratchet material and counters.
- **Out-of-scope in v2 (explicit):** media attachments (IMAGE/VIDEO/AUDIO/
  DOCUMENT messages) are NOT covered by this envelope — media URLs travel via
  the existing media path. Groups and trade conversations are not E2EE (pairwise
  personal conversations only). Money/escrow messages are server-processed
  financial records by design and remain server-visible structured tickets.
  All three exclusions are deliberate, documented guarantees limits — not
  accidental gaps.

## 7. Server trust model and API

The server is a **blind relay for encrypted personal messages**:

- `POST /api/e2ee/keys/init` — register a client-generated, public-only
  bundle: `{identityPublicKey, identityDhPublicKey, identityKeySignature,
  signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature,
  oneTimePreKeys: [{keyId, publicKey}, ...]}`. The server validates every
  format (32-byte X25519 / Ed25519 base64, Ed25519 signatures verify, `keyId`
  integers in range, at most 100 one-time prekeys) before storing. It returns
  the published bundle. If the caller's identity key changed since the last
  registration, the response carries `identityChanged: true` and the previous
  identity is preserved as the audit trail.
- `GET /api/e2ee/keys/:userId` — returns the peer's public bundle and
  **atomically claims** one unused one-time prekey (`UPDATE ... FOR UPDATE
  SKIP LOCKED` inside a transaction). Two concurrent callers can never receive
  the same one-time prekey (proof-tested).
- `POST /api/e2ee/keys/prekeys` — replenish: `{oneTimePreKeys: [{keyId,
  publicKey}, ...]}` (client-generated; the server never generates key
  material; no `count`-driven memory amplification path exists).
- `GET /api/e2ee/fingerprint` / `GET /api/e2ee/fingerprint/:userId` —
  safety numbers from public keys.
- **Removed in v2:** `POST/GET /api/e2ee/session/:peerId` (server-held
  ratchet state — the P0), `POST /api/e2ee/keys/register` and `GET
  /api/e2ee/keys/public/:userId` (the legacy "simple ECDH" surface that
  polluted the bundle schema; native clients must implement this v2 contract).

**Plaintext refusal (fail-closed):** once BOTH participants of a PERSONAL
conversation have registered E2EE bundles, the message send paths (REST
`POST /:conversationId/messages` and the WebSocket `message:send`) reject a
plaintext TEXT message with `409 E2EE_REQUIRED` and only accept the
ciphertext envelope. Read paths return the envelope (never `content`) for
encrypted rows.

## 8. Rotation, key change, recovery, and old messages

- **Signed prekey rotation:** the client generates a new signed prekey and
  re-registers (keeping the old private half locally until all live sessions
  have ratcheted). `signedPreKeyId` makes rotation explicit to senders.
- **Identity change (reinstall / new device):** detected at bundle fetch by
  `identityDhPublicKey`/`identityPublicKey` differing from the cached peer
  value → clients MUST surface the "security code changed" banner and require
  out-of-band safety-number re-verification before re-establishing trust.
  The server preserves `previousIdentityPublicKey` for audit.
- **Old messages after rotation:** ratchet state is device-local; decryption
  of existing history is unaffected (old sessions keep their state until
  deleted).
- **Recovery/reinstall (honest limitation):** private keys live only in
  device secure storage. A reinstall without a client-side encrypted backup
  loses E2EE history (new identity). Server-side plaintext-equivalent key
  escrow is deliberately NOT provided — it would contradict this protocol's
  trust model. Optional future work: passphrase-encrypted client-side export
  (documented; must never involve the server).
- **One device per account** in v2 (multi-device ratchet sync is out of
  scope; documented limitation).

## 9. Invariant proof suite

`__tests__/r40-e2ee-protocol-authority.test.js` (protocol, no DB) and
`__tests__/r40-e2ee-server-authority.test.js` (real PostgreSQL) prove the
13 required invariants; see `docs/audit/r40-e2ee-architecture.md` for the
audit narrative.
