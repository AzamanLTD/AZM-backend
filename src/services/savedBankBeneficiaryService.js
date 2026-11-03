'use strict';

/**
 * SAVED BANK PAYOUT BENEFICIARIES (issue #389 section 4, Agent A)
 * =============================================================================
 * A bank destination is a SECRET, not a display string. The account number is
 * persisted only as a versioned AES-256-GCM envelope (the repo's established
 * fieldCipher abstraction) plus an HMAC-SHA256 fingerprint under a DISTINCT
 * key, which is what uniqueness and lookup use — the ciphertext is never a
 * lookup key. Plaintext is never persisted, logged, echoed or returned after
 * save; the only readable form is the masked tail. Rotation is row-level and
 * explicit: each row records the keyId that encrypted it.
 */

const crypto = require('crypto');
const logger = require('../../src/config/logger');
const fieldCipher = require('../../services/crypto/fieldCipher');

const ACTIVE = 'ACTIVE';
const DELETED = 'DELETED';

class BankBeneficiaryError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'BankBeneficiaryError';
        this.code = code || 'BANK_BENEFICIARY_ERROR';
    }
}

function hmacKey() {
    const raw = process.env.BANK_BENEFICIARY_HMAC_KEY;
    if (raw && raw.trim().length >= 16) return Buffer.from(raw.trim(), 'utf8');
    if (process.env.NODE_ENV === 'test') {
        return Buffer.from('test-only-bank-beneficiary-hmac-key-32bytes', 'utf8');
    }
    throw new BankBeneficiaryError(
        'Bank beneficiary storage is not configured (BANK_BENEFICIARY_HMAC_KEY missing).',
        'BENEFICIARY_KEY_UNAVAILABLE'
    );
}

function currentKeyId() {
    return String(process.env.BANK_BENEFICIARY_KEY_ID || 'k1').slice(0, 32);
}

function normalizeAccountNumber(value) {
    const digits = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!/^[0-9]{6,20}$/.test(digits)) {
        throw new BankBeneficiaryError('Account number must be 6-20 digits.', 'ACCOUNT_NUMBER_INVALID');
    }
    return digits;
}

function fingerprint(accountNumber) {
    return crypto.createHmac('sha256', hmacKey()).update(normalizeAccountNumber(accountNumber)).digest('hex');
}

function mask(accountNumber) {
    const digits = normalizeAccountNumber(accountNumber);
    return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function assertBankInput({ bankCode, bankName }) {
    if (!bankCode || !/^[A-Za-z0-9_-]{2,16}$/.test(String(bankCode))) {
        throw new BankBeneficiaryError('A valid bankCode is required.', 'BANK_CODE_INVALID');
    }
    if (!bankName || String(bankName).trim().length < 2 || String(bankName).length > 80) {
        throw new BankBeneficiaryError('A valid bankName is required.', 'BANK_NAME_INVALID');
    }
}

function toPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        bankCode: row.bankCode,
        bankName: row.bankName,
        accountName: row.accountName || null,
        accountNumberMasked: row.accountNumberMasked,
        nickname: row.nickname || null,
        status: row.status,
        isPrimary: row.isPrimary === true,
        validatedAt: row.validatedAt || null,
        createdAt: row.createdAt,
    };
}

// ── CRUD (owner-scoped, fail-closed) ────────────────────────────────────────
async function createBeneficiary(prisma, userId, input = {}) {
    const { bankCode, bankName, accountNumber, accountName, nickname, isPrimary } = input;
    assertBankInput({ bankCode, bankName });
    const digits = normalizeAccountNumber(accountNumber);
    if (!fieldCipher.isKeyAvailable()) {
        throw new BankBeneficiaryError(
            'Bank beneficiary storage is not configured (encryption key missing).',
            'BENEFICIARY_KEY_UNAVAILABLE'
        );
    }
    const enc = fieldCipher.encrypt(digits);
    const hmac = fingerprint(digits);
    const masked = mask(digits);

    // Uniqueness is per-owner over the FINGERPRINT — the same account saved
    // twice is a duplicate instruction, not two payees.
    const existing = await prisma.savedBankBeneficiary.findUnique({
        where: { userId_accountNumberHmac: { userId, accountNumberHmac: hmac } },
    });
    if (existing && existing.status === ACTIVE) {
        throw new BankBeneficiaryError('This bank account is already saved.', 'BENEFICIARY_DUPLICATE');
    }
    if (existing) {
        const revived = await prisma.savedBankBeneficiary.update({
            where: { id: existing.id },
            data: {
                status: ACTIVE,
                bankCode: String(bankCode),
                bankName: String(bankName).trim(),
                accountNumberEnc: enc,
                accountNumberMasked: masked,
                accountName: accountName ? String(accountName).trim().slice(0, 120) : null,
                nickname: nickname ? String(nickname).trim().slice(0, 40) : null,
                isPrimary: isPrimary === true,
                keyId: currentKeyId(),
                envelopeVersion: 2,
                validatedAt: null,
            },
        });
        return toPublic(revived);
    }

    const created = await prisma.$transaction(async (tx) => {
        if (isPrimary === true) {
            await tx.savedBankBeneficiary.updateMany({
                where: { userId, isPrimary: true },
                data: { isPrimary: false },
            });
        }
        return tx.savedBankBeneficiary.create({
            data: {
                userId,
                bankCode: String(bankCode),
                bankName: String(bankName).trim(),
                accountNumberEnc: enc,
                accountNumberMasked: masked,
                accountNumberHmac: hmac,
                accountName: accountName ? String(accountName).trim().slice(0, 120) : null,
                nickname: nickname ? String(nickname).trim().slice(0, 40) : null,
                isPrimary: isPrimary === true,
                keyId: currentKeyId(),
                envelopeVersion: 2,
            },
        });
    });
    return toPublic(created);
}

async function listBeneficiaries(prisma, userId) {
    const rows = await prisma.savedBankBeneficiary.findMany({
        where: { userId, status: ACTIVE },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toPublic);
}

async function getOwnedBeneficiary(prisma, userId, id) {
    const row = await prisma.savedBankBeneficiary.findFirst({
        where: { id: String(id), userId, status: ACTIVE },
    });
    if (!row) throw new BankBeneficiaryError('Beneficiary not found.', 'BENEFICIARY_NOT_FOUND');
    return row;
}

async function deleteBeneficiary(prisma, userId, id) {
    const row = await getOwnedBeneficiary(prisma, userId, id);
    await prisma.savedBankBeneficiary.update({
        where: { id: row.id },
        data: { status: DELETED, isPrimary: false },
    });
    return { deleted: true, id: row.id };
}

/**
 * Decrypt ONLY at the payout boundary, for the owner's own row. The plaintext
 * never leaves this function's caller (provider dispatch) and is never logged
 * or returned in an HTTP body.
 */
async function revealForPayout(prisma, userId, id) {
    const row = await getOwnedBeneficiary(prisma, userId, id);
    let accountNumber;
    try {
        accountNumber = fieldCipher.decrypt(row.accountNumberEnc);
    } catch (err) {
        logger.error({ err: err.message, id: row.id }, '[bankBeneficiary] decrypt failed');
        throw new BankBeneficiaryError('Saved bank details cannot be read; please re-save the account.', 'BENEFICIARY_DECRYPT_FAILED');
    }
    return {
        id: row.id,
        bankCode: row.bankCode,
        bankName: row.bankName,
        accountName: row.accountName,
        accountNumber,
        accountNumberMasked: row.accountNumberMasked,
        keyId: row.keyId,
    };
}

module.exports = {
    ACTIVE,
    DELETED,
    BankBeneficiaryError,
    normalizeAccountNumber,
    fingerprint,
    mask,
    toPublic,
    createBeneficiary,
    listBeneficiaries,
    getOwnedBeneficiary,
    deleteBeneficiary,
    revealForPayout,
};
