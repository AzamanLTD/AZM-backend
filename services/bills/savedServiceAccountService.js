// services/bills/savedServiceAccountService.js
// =============================================================================
// Saved service accounts: validation, protection and ownership.
//
// Nothing here can pay a bill. There is no provider call, no quote, no debit and
// no receipt — the service exists so a member can store an account reference
// safely while the commercial integration is still being negotiated.
// =============================================================================

const { getService, schemaVersion: TEMPLATE_SCHEMA_VERSION } = require('./serviceRegistry');
const {
    encryptAccountData,
    decryptAccountData,
    accountFingerprint,
    maskIdentity,
} = require('./savedServiceCrypto');

const NICKNAME_MAX = 64;
const VERIFICATION_STATES = new Set(['UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED']);

function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

/**
 * Canonicalisation is per field type and deliberately conservative: lower-case
 * and strip separators for identifiers, E.164-normalise Ghanaian numbers.
 * Anything not explicitly listed is trimmed only.
 */
function canonicaliseField(field, rawValue) {
    const value = String(rawValue == null ? '' : rawValue).trim();
    if (field.type === 'phone') {
        const digits = value.replace(/[\s-]/g, '');
        if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
        if (/^\+233\d{9}$/.test(digits)) return `+233${digits.slice(4)}`;
        return digits;
    }
    if (field.type === 'identifier') {
        return value.replace(/[\s-]/g, '').toUpperCase();
    }
    return value;
}

function validateFields(service, accountFields) {
    if (!accountFields || typeof accountFields !== 'object' || Array.isArray(accountFields)) {
        throw httpError(400, 'INVALID_ACCOUNT_FIELDS', 'accountFields must be an object.');
    }

    const allowed = new Map(service.fields.map((f) => [f.key, f]));
    for (const key of Object.keys(accountFields)) {
        if (!allowed.has(key)) {
            throw httpError(400, 'UNKNOWN_ACCOUNT_FIELD', `Field "${key}" is not part of ${service.serviceCode}.`);
        }
    }

    const out = {};
    for (const field of service.fields) {
        const raw = accountFields[field.key];
        const empty = raw === undefined || raw === null || String(raw).trim() === '';
        if (empty) {
            if (field.required) {
                throw httpError(400, 'MISSING_ACCOUNT_FIELD', `Field "${field.key}" is required.`);
            }
            continue; // eslint-disable-line no-continue
        }
        if (field.maxLength && String(raw).trim().length > field.maxLength) {
            throw httpError(400, 'INVALID_ACCOUNT_FIELD', `Field "${field.key}" is too long.`);
        }
        if (field.pattern && !new RegExp(field.pattern).test(String(raw).trim())) {
            throw httpError(400, 'INVALID_ACCOUNT_FIELD', `Field "${field.key}" has an invalid format.`);
        }
        out[field.key] = canonicaliseField(field, raw);
    }
    return out;
}

function validateNickname(nickname) {
    if (nickname === undefined || nickname === null) return null;
    const trimmed = String(nickname).trim();
    if (trimmed.length === 0 || trimmed.length > NICKNAME_MAX) {
        throw httpError(400, 'INVALID_NICKNAME', `Nickname must be 1-${NICKNAME_MAX} characters.`);
    }
    return trimmed;
}

/** Resolves the registry entry, refusing unknown or mismatched service/provider pairs. */
function resolveService(serviceCode, providerCode) {
    const service = getService(serviceCode);
    if (!service) {
        throw httpError(400, 'UNKNOWN_SERVICE', 'That service is not supported for saved accounts.');
    }
    if (providerCode && String(providerCode).toUpperCase() !== service.providerCode) {
        throw httpError(400, 'PROVIDER_MISMATCH', 'providerCode does not match the selected service.');
    }
    if (!service.capabilities.saveAccount) {
        throw httpError(400, 'SAVING_NOT_SUPPORTED', 'This service does not accept saved accounts yet.');
    }
    return service;
}

/** Sanitised projection. Never includes decrypted fields. */
function toPublicAccount(record, service) {
    return {
        id: record.id,
        serviceCode: record.serviceCode,
        providerCode: record.providerCode,
        categoryCode: service ? service.categoryCode : null,
        label: service ? service.label : null,
        nickname: record.nickname,
        accountMask: record.accountMask,
        serviceTemplateVersion: record.serviceTemplateVersion,
        verificationStatus: record.verificationStatus,
        verifiedAt: record.verifiedAt,
        isPrimary: record.isPrimary,
        lastUsedAt: record.lastUsedAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        capabilities: service ? { ...service.capabilities } : null,
    };
}

function createService({ prisma }) {
    return {
        /**
         * @param {{userId:number, serviceCode:string, providerCode?:string,
         *          nickname?:string, accountFields:object}} input
         */
        async createAccount(input) {
            const userId = input && input.userId;
            if (!Number.isInteger(userId)) {
                throw httpError(401, 'AUTH_REQUIRED', 'Authentication required.');
            }
            const service = resolveService(input.serviceCode, input.providerCode);

            // Reject unexpected per-service serviceCode/providerCode disagreement
            // before any cryptographic work happens.
            const fields = validateFields(service, input.accountFields);
            const nickname = validateNickname(input.nickname) || service.label;
            const identity = fields[service.identityField];
            if (!identity) {
                throw httpError(400, 'MISSING_ACCOUNT_FIELD', `Field "${service.identityField}" is required.`);
            }

            const fingerprint = accountFingerprint({
                userId,
                serviceCode: service.serviceCode,
                providerCode: service.providerCode,
                identity,
            });

            const existing = await prisma.savedServiceAccount.findFirst({
                where: { userId, serviceCode: service.serviceCode, accountFingerprint: fingerprint },
                select: { id: true },
            });
            if (existing) {
                throw httpError(409, 'SAVED_ACCOUNT_EXISTS', 'That account is already saved.');
            }

            const accountDataCiphertext = encryptAccountData(fields);

            try {
                const record = await prisma.savedServiceAccount.create({
                    data: {
                        userId,
                        serviceCode: service.serviceCode,
                        providerCode: service.providerCode,
                        nickname,
                        accountDataCiphertext,
                        accountDataKeyVersion: require('./savedServiceCrypto').keyVersion(),
                        // The field schema this account was validated against,
                        // so a later registry change can be handled, not guessed.
                        serviceTemplateVersion: TEMPLATE_SCHEMA_VERSION,
                        accountFingerprint: fingerprint,
                        accountMask: maskIdentity(identity),
                        // Saving is not verifying. Only a provider lookup may
                        // move this out of UNVERIFIED.
                        verificationStatus: 'UNVERIFIED',
                    },
                });
                return toPublicAccount(record, service);
            } catch (err) {
                // Unique violation from a concurrent create that beat the check.
                if (err && err.code === 'P2002') {
                    throw httpError(409, 'SAVED_ACCOUNT_EXISTS', 'That account is already saved.');
                }
                throw err;
            }
        },

        async listAccounts(userId) {
            const rows = await prisma.savedServiceAccount.findMany({
                where: { userId },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
            });
            return rows.map((row) => toPublicAccount(row, getService(row.serviceCode)));
        },

        /**
         * Only nickname and primary state are mutable. Identity changes are a new
         * account plus a delete, so a saved record never silently becomes a
         * different meter.
         */
        async updateAccount({ userId, id, nickname, isPrimary }) {
            const row = await prisma.savedServiceAccount.findFirst({ where: { id, userId } });
            if (!row) throw httpError(404, 'SAVED_ACCOUNT_NOT_FOUND', 'Saved account not found.');

            const data = {};
            if (nickname !== undefined) {
                const next = validateNickname(nickname);
                if (next === null) throw httpError(400, 'INVALID_NICKNAME', 'Nickname cannot be empty.');
                data.nickname = next;
            }
            if (isPrimary !== undefined) {
                if (typeof isPrimary !== 'boolean') {
                    throw httpError(400, 'INVALID_PRIMARY_FLAG', 'isPrimary must be a boolean.');
                }
                data.isPrimary = isPrimary;
            }
            if (Object.keys(data).length === 0) {
                throw httpError(400, 'NOTHING_TO_UPDATE', 'Provide nickname or isPrimary.');
            }

            let updated;
            try {
                updated = await prisma.$transaction(async (tx) => {
                    if (data.isPrimary === true) {
                        await tx.savedServiceAccount.updateMany({
                            where: { userId, serviceCode: row.serviceCode, isPrimary: true, NOT: { id } },
                            data: { isPrimary: false },
                        });
                    }
                    return tx.savedServiceAccount.update({ where: { id }, data });
                });
            } catch (err) {
                // The partial unique index is the final authority on one primary
                // per member per service. When two promotions race, the loser
                // hits it, and that must reach the caller as a typed conflict
                // rather than a raw Prisma code.
                if (err && err.code === 'P2002') {
                    throw httpError(409, 'PRIMARY_CONFLICT',
                        'Another account for this service was just made primary. Refresh and retry.');
                }
                throw err;
            }

            return toPublicAccount(updated, getService(updated.serviceCode));
        },

        async deleteAccount({ userId, id }) {
            const row = await prisma.savedServiceAccount.findFirst({ where: { id, userId }, select: { id: true } });
            if (!row) throw httpError(404, 'SAVED_ACCOUNT_NOT_FOUND', 'Saved account not found.');
            await prisma.savedServiceAccount.delete({ where: { id } });
            return { id, deleted: true };
        },

        /** Internal read used by nothing yet; exists so a future provider adapter has one audited path. */
        async revealAccountFields({ userId, id }) {
            const row = await prisma.savedServiceAccount.findFirst({ where: { id, userId } });
            if (!row) throw httpError(404, 'SAVED_ACCOUNT_NOT_FOUND', 'Saved account not found.');
            return decryptAccountData(row.accountDataCiphertext);
        },
    };
}

module.exports = {
    createService,
    validateFields,
    resolveService,
    canonicaliseField,
    toPublicAccount,
    VERIFICATION_STATES,
    NICKNAME_MAX,
};
