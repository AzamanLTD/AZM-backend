# AZAMAN E2EE Protocol v1 — Contract

Status: **P0 architecture remediation (r40)**. Replaces the previous
`e2eeService.js` construction, which was internally inconsistent (the X3DH
terms used by `establishSession()` and `acceptSession()` were different DH
exchanges, so the two sides could never derive the same secret) and stored
server-side private key material, which made the server a decryption
authority.

This document is the binding contract between the backend
(`services/e2ee/protocol.js` — reference implementation) and any client
implementation (Flutter `packages/e2ee_protocol`). Both must pass the same
byte-level test vectors (`__tests__/e2ee-protocol.test.js`,
`packages/e2ee_protocol/test/e2ee_protocol_test.dart`).

## 1. Design decision (audit item H)

The protocol is the **published Signal X3DH and Double Ratchet
specifications**, implemented on standard, audited primitives:

| Purpose | Primitive | Backend | Client |
|---|---|---|---|
| DH agreement | X25519 (raw scalarmult output) | libsodium `crypto_scalarmult` | `cryptography` X25519 |
| Identity signing | Ed25519 detached signatures | libsodium `crypto_sign_detached` | `cryptography` Ed25519 |
| Root/chain KDF | HKDF-SHA256 / HMAC-SHA256 (RFC 5869 / RFC 2104) | `node:crypto` | `cryptography` Hmac/Hkdf |
| Message AEAD | ChaCha20-Poly1305 (IETF, RFC 8439), 12-byte nonce, 32-byte key | libsodium `crypto_aead_chacha20poly1305_ietf` | `cryptography` Chacha20.poly1305Aead |

No new cryptographic construction is invented: the KDF constructions are
the Signal specifications' own; HKDF/HMAC/ChaCha20-Poly1305 are IETF RFCs.

## 2. Key model (server-blind)

The server is a **key directory only**. It stores and serves public keys; it
never generates, stores, transforms or returns private key material.
Private keys live only in the client OS keystore/secure storage.

- **Signing identity** `IKsig`: Ed25519 keypair, per device. Public key is the
  durable identity anchor and safety-number source.
- **DH identity** `IK`: X25519 keypair, per device, bound to `IKsig` at
  registration (§4). This is the DH identity used by X3DH.
- **Signed prekey (SPK)**: X25519 keypair, rotated by the client. Signed by
  `IKsig` (§4).
- **One-time prekeys (OPK)**: X25519 keypairs; public parts uploaded in
  batches and atomically claimed by the server on bundle fetch (§5).
- **Device**: a `(user, deviceId)` pair with its own keys. v1 supports one
  active device per user; the model is per-device from day one.

## 3. Registration (POST /api/e2ee/devices)

Client sends `deviceId`, `signingPublicKey` (Ed25519 pub, b64),
`identityPublicKey` (X25519 pub, b64), `identityBindingSignature`,
`signedPreKey { keyId, publicKey (X25519 pub, b64), signature }`,
`oneTimePreKeys [{ keyId, publicKey }]` (≤100).

The server verifies (fail-closed 400 otherwise):
- binding signature: Ed25519-verify over
  `"azaman-e2ee-v1-device-bind|" + b64(identityPublicKey) + "|" + b64(signingPublicKey)`
- SPK signature: Ed25519-verify over
  `"azaman-e2ee-v1-spk|" + String(keyId) + "|" + b64(spk.publicKey)`

Store: public fields only. A re-registration with the same deviceId replaces
the device's keys (key rotation path).

## 4. X3DH (session establishment)

Exactly the Signal X3DH spec. Initiator (Alice) fetches Bob's bundle
(`signingPublicKey, identityPublicKey, signedPreKey, oneTimePreKey?`).
She verifies the SPK signature and the device binding before use.

Alice generates ephemeral `EKa` and computes:

```
DH1 = X25519(IKa_priv,  SPKb_pub)
DH2 = X25519(EKa_priv,  IKb_pub)
DH3 = X25519(EKa_priv,  SPKb_pub)
DH4 = X25519(EKa_priv,  OPKb_pub)   // omitted only if no OPK available
SK  = HKDF-SHA256(ikm = F || DH1 || DH2 || DH3 [|| DH4],
                  salt = 0x00 * 32, info = "AZAMAN-X3DH-v1", L = 32)
F   = 32 bytes of 0xFF (Signal's KDF input prefix)
```

Bob computes the mirror DHs (`DH(SPKb_priv, IKa_pub)`, `DH(IKb_priv, EKa_pub)`,
`DH(SPKb_priv, EKa_pub)`, `DH(OPKb_priv, EKa_pub)`), same KDF → identical SK.
Both sides derive the **same** SK — proven by an explicit per-term test.

## 5. One-time prekey claim (GET /api/e2ee/keys/:userId)

A bundle fetch CONSUMES one of the target's one-time prekeys, so it is a
resource claim, not a free public-key read. It is therefore
authorization-gated AND rate-limited (r40.3):

1. **Relationship gate.** The authenticated caller must share an existing
   `PERSONAL` conversation with the target user; otherwise the claim is
   refused with `403 E2EE_NO_RELATIONSHIP` and NOTHING is consumed. This is
   the same pairwise contract the message path enforces
   (`E2EE_NOT_PAIRWISE`, §8): an E2EE session can only be established inside
   an existing personal conversation, so a bundle for a non-conversation peer
   is by definition unusable — strangers can never drain a victim's OPK
   pool, no matter how many times they probe. Self-fetch is refused the same
   way (an E2EE session with yourself is meaningless; the device already
   holds its own keys). The fingerprint endpoints (`GET /fingerprint/:userId`)
   stay open by design: safety numbers are made to be shared and consume no
   resources.
2. **Per-pair rate limit.** `e2eeBundleLimiter`: at most **10 claims per
   15 minutes per (claimant, target) pair** — a user who DOES share a
   conversation with the victim cannot hammer the endpoint to drain their
   pool either; the limit is per pair, so one abusive relationship never
   throttles a claimant's sessions with other peers. Fail-safe tier (the
   same posture as the financial tier): a Redis outage degrades the limiter
   to an in-process memory limiter with identical thresholds, never to
   unlimited claims. The claimant is MANDATORY at the service boundary too
   (`fetchBundle` refuses an anonymous claim with `E2EE_CLAIMANT_REQUIRED`) —
   the security parameter is not something a caller may omit.
3. **Claim audit trail.** Each claim records `claimedBy` (the claimant's
   user id) on the consumed OPK row, so OPK-drain abuse is forensically
   attributable.

The claim itself is atomic: one unused OPK with a single
`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`
statement. Concurrent bundle fetches receive distinct OPKs — proven by a
concurrent PostgreSQL test, and a hostile-probe test proves an
unrelated/abusive caller cannot exhaust an arbitrary user's pool.

## 6. Double Ratchet (message state)

Signal Double Ratchet spec, per session (one session per pair of devices):

- `KDF_RK(rk, dh_out)` = HKDF-SHA256(ikm = dh_out, salt = rk,
  info = `"AZAMAN-DR-v1-rk"`, L = 64) → `(rk', ck')` (32 || 32).
- `KDF_CK(ck)` = HMAC-SHA256(ck, 0x01) → `mk`; HMAC-SHA256(ck, 0x02) → `ck'`.
- Alice init: `DHs = EKa pair, DHr = SPKb_pub`,
  `(RK, CKs) = KDF_RK(SK, X25519(EKa_priv, SPKb_pub))`, `CKr = null, Ns=0,Nr=0,PN=0`.
- Bob init: `DHs = SPKb pair, DHr = null, RK = SK, CKs = CKr = null`.
- Encrypt: if `CKr == null && DHr != null` (or on reply turnaround) follow the
  spec's DH-step (`(RK, CKr) = KDF_RK(RK, X25519(DHs_priv, header.dh))` before
  deriving sending chains). Header: `{ dh (ratchet pub), pn, n }`.
- Out-of-order delivery: skipped message keys cached per
  `(header.dh, n)`. TWO bounds (both must be implemented by every client):
  - **MAX_SKIP = 1000** per chain — a message may jump at most 1000
    positions ahead of the receiving chain head (`until + 1 - recvCount >
    MAX_SKIP` throws `E2EE_TOO_MANY_SKIPPED`). This is the Signal spec's
    SKIP cap.
  - **MAX_SKIPPED_CACHE = 2000** globally across ALL chains — total
    retained skipped-key state is capped; the cache evicts FIFO
    (oldest-insert first) once full. Signal bounds skipped key material
    globally, not just per-chain: without this second bound an attacker can
    force unbounded retained key state via many sparse headers.
- Replay: an accepted `(dh, n)` is consumed; the skipped-key cache rejects
  duplicates; message keys are single-use.

## 7. Message encryption and envelope

- Message key `mk` (32 bytes) encrypts the UTF-8 plaintext with
  ChaCha20-Poly1305 (IETF). **Nonce** = first 12 bytes of
  HMAC-SHA256(`mk`, `"AZAMAN-DR-v1-nonce"`). Because `mk` is single-use
  (chain advance), nonce reuse is impossible by construction.
- **Canonical header encoding** (byte-identical in every implementation —
  no JSON, no whitespace ambiguity; UTF-8 ASCII, `|`-delimited):
  `"azaman-dr-v1|" + header.dh + "|" + header.pn + "|" + header.n"`
  where `dh` is the b64 ratchet public key string exactly as it appears in
  the envelope, and `pn`/`n` are plain decimal integers. A header is valid
  only if `dh` is a string and `pn`/`n` are integers — anything else throws
  `E2EE_INVALID_HEADER` before any crypto runs.
- **Associated data (AD)** authenticated by the AEAD. Following the Signal
  spec (AD' = AD || header), the AEAD associated data is the exact
  byte concatenation of two UTF-8 strings:

  1. Context binding:
     `"azaman-e2ee-v1|" + conversationId + "|" + senderDeviceId + "|"
      + senderIdentityKey + "|" + recipientIdentityKey"`
     where `conversationId` and `senderDeviceId` are the plain strings from
     the message transport (§8), and `senderIdentityKey` /
     `recipientIdentityKey` are the b64 X25519 identity public keys of the
     sender and recipient as stored in the key directory.
  2. Canonical header encoding (above), including its own
     `"azaman-dr-v1|"` prefix.

  So the full AD is:
  `"azaman-e2ee-v1|" + conversationId + "|" + senderDeviceId + "|"
   + senderIdentityKey + "|" + recipientIdentityKey
   + "azaman-dr-v1|" + dh + "|" + pn + "|" + n`

  This binds every ciphertext to the conversation, the sender's DEVICE and
  identity, the recipient's identity, AND every header byte (`dh`, `pn`,
  `n`) — a valid ciphertext cannot be transplanted to another conversation,
  another sender device, or another header and remain authentic (proven by
  cross-conversation / bad-context tests).

Wire/persistence envelope (JSON, stored verbatim in `Message.e2eeEnvelope`):

```json
{
  "v": 1,
  "deviceId": "<sender device id>",
  "ik": "<b64 sender X25519 identity pub>",
  "ek": "<b64 sender ephemeral pub — present only on the session-initiating message>",
  "spkId": <int>,
  "otpkId": <int | null>,
  "h": { "dh": "<b64 ratchet pub>", "pn": <int>, "n": <int> },
  "nonce": "<b64 12 bytes>",
  "ct": "<b64 ciphertext+tag>"
}
```

## 8. Message transport (conversation API)

- `POST /:conversationId/messages` with `body.e2ee` (envelope): the server
  validates shape/ownership/size only, stores `content = ''`,
  `e2eeEnvelope = envelope`, and returns/emits the envelope. Specifically:
  - `E2EE_NOT_PAIRWISE` (400): E2EE is only accepted for `PERSONAL`
    conversations (§5 uses the same pairwise contract at bundle claim).
  - `E2EE_SENDER_IDENTITY_MISMATCH` (403): `envelope.deviceId` and
    `envelope.ik` must match one of the caller's OWN active registered
    devices — the API caller must own the cryptographic sender identity.
  - The serialized envelope must be ≤ **131072 bytes** (`E2EE envelope too
    large.`, 400).
  - If `text` and `e2ee` are both present the request is rejected (no
    silent plaintext leak). Plaintext `text` remains available for non-E2EE
    clients (explicit legacy mode).
- `GET /:conversationId/messages` returns `e2eeEnvelope` and `isE2EE: true`
  for envelope messages (`text` is empty). The server cannot decrypt them.

## 9. Rotation, key change, recovery

- **Rotation**: client re-registers (same or new deviceId) with new keys.
  The old device row is replaced/deactivated; peers see a changed
  `identityPublicKey` and show the key-change banner (client-side check).
  Old sessions keep working until a new session is established.
- **Reinstallation**: private keys are unrecoverable by design; a reinstall
  registers as a new device. Old ciphertexts stay decryptable only by the
  device that participated in the session — losing the device loses the
  history (documented, standard E2EE trade-off).
- **Server compromise**: the key directory gives the attacker no ability to
  decrypt any envelope — proven by a test that reconstructs a message from
  database state alone and fails.

## 10. Scope

- v1 covers TEXT messages. Attachments/media and dispute evidence are
  **explicitly excluded** from the E2EE guarantee and remain plaintext/url
  references; they must be addressed by a future contract revision before
  being covered.
