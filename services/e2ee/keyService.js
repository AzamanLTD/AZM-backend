// services/e2ee/keyService.js
// =============================================================================
// E2EE key directory — server-blind storage (docs/e2ee-protocol.md).
//
// The server stores PUBLIC key material only and never generates, stores,
// transforms or returns private keys. One-time prekeys are claimed ATOMICALLY
// (single UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING) so two concurrent
// bundle fetches can never receive the same key.
// =============================================================================

'use strict';

const protocol = require('./protocol');

const MAX_PREKEYS_PER_BATCH = 100;
const MAX_KEY_ID = 0x7fffffff;
const B64_32 = /^[A-Za-z0-9+/]{43}={1}$/; // base64 of exactly 32 bytes

function e2eeError(message, statusCode = 400, code = 'E2EE_INVALID_REQUEST') {
    return Object.assign(new Error(message), { statusCode, code });
}

function assertBase64Key(value, field) {
    if (typeof value !== 'string' || !B64_32.test(value)) {
        throw e2eeError(field + ' must be base64 of exactly 32 bytes.');
    }
    return value;
}

function assertKeyIds(entries, field) {
    if (!Array.isArray(entries) || entries.length === 0) throw e2eeError(field + ' must be a nonempty array.');
    if (entries.length > MAX_PREKEYS_PER_BATCH) throw e2eeError(field + ' accepts at most ' + MAX_PREKEYS_PER_BATCH + ' keys.');
    return entries.map((entry) => {
        if (!entry || typeof entry !== 'object') throw e2eeError(field + ' entries must be objects.');
        const keyId = entry.keyId;
        if (!Number.isInteger(keyId) || keyId < 0 || keyId > MAX_KEY_ID) {
            throw e2eeError(field + '.keyId must be an integer between 0 and ' + MAX_KEY_ID + '.');
        }
        return { keyId, publicKey: assertBase64Key(entry.publicKey, field + '.publicKey') };
    });
}

class E2EEKeyService {
    constructor(prisma) { this.prisma = prisma; }

    // Register / rotate a device's PUBLIC key material. The server verifies
    // the identity binding and the signed-prekey signature before storing.
    async registerDevice({ userId, deviceId, signingPublicKey, identityPublicKey, identityBindingSignature, signedPreKey, oneTimePreKeys }) {
        if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId)) {
            throw e2eeError('deviceId must be 8-128 alphanumeric/._:- characters.');
        }
        assertBase64Key(signingPublicKey, 'signingPublicKey');
        assertBase64Key(identityPublicKey, 'identityPublicKey');
        if (typeof identityBindingSignature !== 'string' || identityBindingSignature.length > 200) {
            throw e2eeError('identityBindingSignature is required.');
        }
        if (!signedPreKey || typeof signedPreKey !== 'object') throw e2eeError('signedPreKey is required.');
        if (!Number.isInteger(signedPreKey.keyId) || signedPreKey.keyId < 0 || signedPreKey.keyId > MAX_KEY_ID) {
            throw e2eeError('signedPreKey.keyId must be an integer between 0 and ' + MAX_KEY_ID + '.');
        }
        assertBase64Key(signedPreKey.publicKey, 'signedPreKey.publicKey');
        if (typeof signedPreKey.signature !== 'string' || signedPreKey.signature.length > 200) {
            throw e2eeError('signedPreKey.signature is required.');
        }
        const otpks = oneTimePreKeys === undefined ? [] : assertKeyIds(oneTimePreKeys, 'oneTimePreKeys');

        // Server-side verification BEFORE persistence: fail closed on any
        // forged or misbound key (docs/e2ee-protocol.md §3).
        if (!protocol.verifyDeviceBinding({ signingPublicKeyB64: signingPublicKey, identityPublicKeyB64: identityPublicKey, bindingSignatureB64: identityBindingSignature })) {
            throw e2eeError('Identity binding signature verification failed.', 400, 'E2EE_BINDING_INVALID');
        }
        if (!protocol.verifySignedPreKeySignature({ signingPublicKeyB64: signingPublicKey, signedPreKeyId: signedPreKey.keyId, signedPreKeyPublicKeyB64: signedPreKey.publicKey, signatureB64: signedPreKey.signature })) {
            throw e2eeError('Signed prekey signature verification failed.', 400, 'E2EE_SPK_SIGNATURE_INVALID');
        }

        // Model A (P0-C): ONE ACTIVE DEVICE PER USER. Registration of a new
        // deviceId atomically retires the previous active device AND consumes
        // its pending one-time prekeys — a bundle can never mix material from
        // two devices. The partial unique index (overlay) enforces the
        // active-device invariant at the storage layer; a concurrent
        // registration that loses the race is retried against the winner.
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    // 1. Retire every currently active device of this user.
                    await tx.e2eeDevice.updateMany({
                        where: { userId, isActive: true },
                        data: { isActive: false },
                    });
                    // 2. Retire the old device's pending one-time prekeys:
                    // their private halves live on the retired device.
                    await tx.e2eeOneTimePreKey.updateMany({
                        where: { userId, isUsed: false },
                        data: { isUsed: true, usedAt: new Date() },
                    });
                    // 3. Activate (upsert) the registered device.
                    const device = await tx.e2eeDevice.upsert({
                        where: { userId_deviceId: { userId, deviceId } },
                        create: {
                            userId, deviceId, signingPublicKey, identityPublicKey,
                            bindingSignature: identityBindingSignature,
                            signedPreKeyId: signedPreKey.keyId,
                            signedPreKeyPublicKey: signedPreKey.publicKey,
                            signedPreKeySignature: signedPreKey.signature,
                            isActive: true,
                        },
                        update: {
                            signingPublicKey, identityPublicKey,
                            bindingSignature: identityBindingSignature,
                            signedPreKeyId: signedPreKey.keyId,
                            signedPreKeyPublicKey: signedPreKey.publicKey,
                            signedPreKeySignature: signedPreKey.signature,
                            isActive: true,
                        },
                    });
                    // 4. Seed the new device's one-time prekeys (immutable-
                    // ID semantics: same key+same pubkey = idempotent skip,
                    // different pubkey = conflict — never silent replacement).
                    await this._upsertPreKeys(tx, userId, deviceId, otpks);
                    return { deviceId: device.deviceId, registeredAt: device.updatedAt };
                });
            } catch (err) {
                // Unique-index race on the one-active-device invariant: a
                // concurrent registration committed first. Retry cleanly.
                if ((err.code === 'P2002') && attempt < 3) continue;
                throw err;
            }
        }
    }

    // P1-D: prekey IDs identify STABLE key material. Inserting a keyId that
    // already exists with the same public key is idempotent (skip); the same
    // keyId with a DIFFERENT public key is a typed conflict. Used/pending
    // rows are never silently replaced.
    async _upsertPreKeys(tx, userId, deviceId, otpks) {
        for (const k of otpks) {
            // r40.2: identity is DEVICE-scoped (userId, deviceId, keyId) —
            // the same keyId on a DIFFERENT device is distinct material,
            // never a conflict and never a silent replacement.
            const existing = await tx.e2eeOneTimePreKey.findUnique({
                where: { userId_deviceId_keyId: { userId, deviceId, keyId: k.keyId } },
            });
            if (!existing) {
                await tx.e2eeOneTimePreKey.create({
                    data: { userId, deviceId, keyId: k.keyId, publicKey: k.publicKey },
                });
            } else if (existing.publicKey !== k.publicKey) {
                throw e2eeError(
                    `One-time prekey ${k.keyId} already exists with different key material.`,
                    409, 'E2EE_PREKEY_CONFLICT');
            }
            // Same publicKey for an existing keyId: idempotent no-op (the key
            // may be claimed already; replacement is never allowed).
        }
    }

    // Fetch a user's prekey bundle. Atomically claims one unused one-time
    // prekey: a single statement, row-lock + SKIP LOCKED — concurrent
    // fetches receive DISTINCT keys (proven by a PostgreSQL concurrency test).
    // r40.3/r40.4 (audit P1 — OPK exhaustion + fail-closed boundary): a
    // bundle fetch CONSUMES one of the target's one-time prekeys, so it is
    // not a free public-key read: it is a resource claim against the
    // target's session-freshness pool. The claimant is MANDATORY and must
    // share an existing PERSONAL conversation with the target — the same
    // pairwise contract the message path already enforces
    // (E2EE_NOT_PAIRWISE): an E2EE session is only ever established inside
    // an existing personal conversation, so a bundle for a non-conversation
    // peer is by definition unusable. This is a DELIBERATE consumption
    // gate, not a removal of OPKs from the protocol; unauthenticated
    // fetches were already impossible (protect). The route additionally
    // rate-limits claims per (claimant, target) — see e2eeBundleLimiter in
    // middleware/rateLimitMiddleware.js (r40.4: fail-safe tier — a Redis
    // outage degrades to in-process limiting instead of unlimited claims).
    async fetchBundle(userId, { claimantId } = {}) {
        // r40.4 (audit: fail-closed service boundary): a bundle fetch CONSUMES
        // a target resource, so the claimant is MANDATORY at the service
        // boundary — the security parameter is not something a caller may
        // forget to pass. There is deliberately NO unrestricted internal
        // variant; every claim must name who it is for.
        if (!Number.isInteger(claimantId) || claimantId <= 0) {
            const err = new Error('fetchBundle requires a claimantId — bundle claims are not anonymous.');
            err.statusCode = 500; err.code = 'E2EE_CLAIMANT_REQUIRED';
            throw err;
        }
        if (claimantId === userId) {
            const self = new Error('E2EE bundles are fetched by a conversation peer, never by the key owner.');
            self.statusCode = 403; self.code = 'E2EE_NO_RELATIONSHIP';
            throw self;
        }
        const shared = await this.prisma.conversation.findFirst({
            where: {
                type: 'PERSONAL',
                AND: [
                    { participants: { some: { id: claimantId } } },
                    { participants: { some: { id: userId } } },
                ],
            },
        });
        if (!shared) {
            const err = new Error('No personal conversation with this user — E2EE sessions can only be established with an existing conversation peer.');
            err.statusCode = 403; err.code = 'E2EE_NO_RELATIONSHIP';
            throw err;
        }

        // r40.4 (audit: bundle/device-rotation race). The device snapshot and
        // the one-time-prekey claim are now ONE ATOMIC STATEMENT: the CTE
        // locks the selected active device row FOR UPDATE and claims the OPK
        // inside the same snapshot. Device rotation (registerDevice) retires
        // the active device by UPDATING that same row inside its own
        // transaction, so the two are serialized by the row lock:
        //   • a claim that selects device A holds A's row lock — rotation
        //     cannot retire A until the claim has committed, so the returned
        //     bundle can never be for a device already retired;
        //   • a rotation that commits first marks A inactive — the claim's
        //     locked read re-evaluates the row (READ COMMITTED re-check
        //     semantics) and refuses to serve the retired device. Because the
        //     claim's statement snapshot predates the new device row, the
        //     claim FAILS CLOSED (no bundle → 404) when it loses the race;
        //     the client retries and is served the new active device. Never a
        //     retired device, never mixed material — the only safe answers.
        // P0-C is preserved: the claimed OPK is bound to the selected device
        // (the claim joins the locked device snapshot). r40.3: claimedBy
        // records WHO consumed the key (abuse forensics).
        const bundle = await this.prisma.$queryRaw`
            WITH active_device AS (
                SELECT "deviceId", "signingPublicKey", "identityPublicKey",
                       "signedPreKeyId", "signedPreKeyPublicKey", "signedPreKeySignature"
                FROM "E2EEDevice"
                WHERE "userId" = ${userId} AND "isActive" = true
                ORDER BY "updatedAt" DESC
                LIMIT 1
                FOR UPDATE
            ), claim AS (
                UPDATE "E2EEOneTimePreKey"
                SET "isUsed" = true, "usedAt" = now(), "claimedBy" = ${claimantId}
                WHERE "id" = (
                    SELECT opk."id" FROM "E2EEOneTimePreKey" opk
                    WHERE opk."userId" = ${userId}
                      AND opk."deviceId" = (SELECT "deviceId" FROM active_device)
                      AND opk."isUsed" = false
                    ORDER BY opk."createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING "keyId", "publicKey"
            )
            SELECT ad."deviceId" AS "deviceId",
                   ad."signingPublicKey" AS "signingPublicKey",
                   ad."identityPublicKey" AS "identityPublicKey",
                   ad."signedPreKeyId" AS "signedPreKeyId",
                   ad."signedPreKeyPublicKey" AS "signedPreKeyPublicKey",
                   ad."signedPreKeySignature" AS "signedPreKeySignature",
                   c."keyId" AS "otpkKeyId",
                   c."publicKey" AS "otpkPublicKey"
            FROM active_device ad
            LEFT JOIN claim c ON true`;
        if (!bundle.length) return null;
        const b = bundle[0];
        return {
            deviceId: b.deviceId,
            signingPublicKey: b.signingPublicKey,
            identityPublicKey: b.identityPublicKey,
            signedPreKey: {
                keyId: b.signedPreKeyId,
                publicKey: b.signedPreKeyPublicKey,
                signature: b.signedPreKeySignature,
            },
            oneTimePreKey: b.otpkKeyId !== null ? { keyId: b.otpkKeyId, publicKey: b.otpkPublicKey } : null,
        };
    }

    // Replenish one-time prekeys (public keys only, strictly bounded).
    // P1-D: a keyId identifies stable material WITHIN a device — same key +
    // same public key is idempotent; the same keyId with a different public
    // key on the SAME device is a 409 conflict. Keys are device-scoped to
    // the ACTIVE device (r40.2: the unique index is (userId, deviceId,
    // keyId), so a fresh device may reuse keyIds of retired devices).
    // Concurrent replenishment cannot become last-writer-wins (no
    // delete/recreate).
    async replenishOneTimePreKeys({ userId, oneTimePreKeys }) {
        const otpks = assertKeyIds(oneTimePreKeys, 'oneTimePreKeys');
        const device = await this.prisma.e2eeDevice.findFirst({
            where: { userId, isActive: true }, orderBy: { updatedAt: 'desc' },
        });
        if (!device) throw e2eeError('No active device. Register a device first.', 409, 'E2EE_NO_ACTIVE_DEVICE');
        let inserted = 0;
        await this.prisma.$transaction(async (tx) => {
            for (const k of otpks) {
                // r40.2: identity is DEVICE-scoped — a retired device's
                // same keyId never conflicts with the active device's.
                const existing = await tx.e2eeOneTimePreKey.findUnique({
                    where: { userId_deviceId_keyId: { userId, deviceId: device.deviceId, keyId: k.keyId } },
                });
                if (!existing) {
                    await tx.e2eeOneTimePreKey.create({
                        data: { userId, deviceId: device.deviceId, keyId: k.keyId, publicKey: k.publicKey },
                    });
                    inserted += 1;
                } else if (existing.publicKey !== k.publicKey) {
                    throw e2eeError(
                        `One-time prekey ${k.keyId} already exists with different key material.`,
                        409, 'E2EE_PREKEY_CONFLICT');
                }
            }
        });
        return { count: otpks.length, inserted };
    }

    async deactivateDevice({ userId, deviceId }) {
        const device = await this.prisma.e2eeDevice.updateMany({
            where: { userId, deviceId }, data: { isActive: false },
        });
        if (device.count === 0) throw e2eeError('Device not found.', 404, 'E2EE_DEVICE_NOT_FOUND');
        return { deactivated: true };
    }

    async identityFingerprint(userId) {
        const device = await this.prisma.e2eeDevice.findFirst({
            where: { userId, isActive: true }, orderBy: { updatedAt: 'desc' },
        });
        if (!device) return null;
        const sodium = await protocol.init();
        const hash = sodium.crypto_generichash(32, protocol.unb64(device.identityPublicKey));
        const hex = Buffer.from(hash).toString('hex').toUpperCase();
        return { fingerprint: hex.match(/.{1,5}/g).join(' '), identityPublicKey: device.identityPublicKey };
    }
}

module.exports = { E2EEKeyService, assertKeyIds, assertBase64Key, MAX_PREKEYS_PER_BATCH };
