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

        return this.prisma.$transaction(async (tx) => {
            const device = await tx.e2eeDevice.upsert({
                where: { userId_deviceId: { userId, deviceId } },
                create: {
                    userId, deviceId, signingPublicKey, identityPublicKey,
                    bindingSignature: identityBindingSignature,
                    signedPreKeyId: signedPreKey.keyId,
                    signedPreKeyPublicKey: signedPreKey.publicKey,
                    signedPreKeySignature: signedPreKey.signature,
                },
                update: {
                    signingPublicKey, identityPublicKey,
                    bindingSignature: identityBindingSignature,
                    signedPreKeyId: signedPreKey.keyId,
                    signedPreKeyPublicKey: signedPreKey.publicKey,
                    signedPreKeySignature: signedPreKey.signature,
                },
            });
            // Re-registration replaces the device's pending one-time prekeys.
            await tx.e2eeOneTimePreKey.deleteMany({ where: { userId, keyId: { in: otpks.map(k => k.keyId) } } });
            if (otpks.length) {
                await tx.e2eeOneTimePreKey.createMany({
                    data: otpks.map(k => ({ userId, keyId: k.keyId, publicKey: k.publicKey })),
                });
            }
            return { deviceId: device.deviceId, registeredAt: device.updatedAt };
        });
    }

    // Fetch a user's prekey bundle. Atomically claims one unused one-time
    // prekey: a single statement, row-lock + SKIP LOCKED — concurrent
    // fetches receive DISTINCT keys (proven by a PostgreSQL concurrency test).
    async fetchBundle(userId) {
        const device = await this.prisma.e2eeDevice.findFirst({
            where: { userId, isActive: true },
            orderBy: { updatedAt: 'desc' },
        });
        if (!device) return null;

        const claimed = await this.prisma.$queryRaw`
            UPDATE "E2EEOneTimePreKey" SET "isUsed" = true, "usedAt" = now()
            WHERE "id" = (
                SELECT "id" FROM "E2EEOneTimePreKey"
                WHERE "userId" = ${userId} AND "isUsed" = false
                ORDER BY "createdAt" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING "keyId", "publicKey"`;

        return {
            deviceId: device.deviceId,
            signingPublicKey: device.signingPublicKey,
            identityPublicKey: device.identityPublicKey,
            signedPreKey: {
                keyId: device.signedPreKeyId,
                publicKey: device.signedPreKeyPublicKey,
                signature: device.signedPreKeySignature,
            },
            oneTimePreKey: claimed.length ? { keyId: claimed[0].keyId, publicKey: claimed[0].publicKey } : null,
        };
    }

    // Replenish one-time prekeys (public keys only, strictly bounded).
    async replenishOneTimePreKeys({ userId, oneTimePreKeys }) {
        const otpks = assertKeyIds(oneTimePreKeys, 'oneTimePreKeys');
        await this.prisma.$transaction(async (tx) => {
            await tx.e2eeOneTimePreKey.deleteMany({ where: { userId, keyId: { in: otpks.map(k => k.keyId) } } });
            await tx.e2eeOneTimePreKey.createMany({ data: otpks.map(k => ({ userId, keyId: k.keyId, publicKey: k.publicKey })) });
        });
        return { count: otpks.length };
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
