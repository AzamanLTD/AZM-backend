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

// AZAMAN POLICY, NOT A PROVIDER OR GHANA-WIDE FACT.
// -------------------------------------------------
// Neither Moolre's documentation nor Ghanaian banking practice establishes a
// universal account-number length. This 10-16 digit window is Azaman's own
// product boundary: it sits strictly inside the provider adapter's 6-20 digit
// transport safety bound, so every number we accept is one the provider
// contract can express, while obviously-implausible strings ("123456") are
// refused before they become a saved payee. The window does NOT establish that
// an account exists — only the provider's validation does (see
// verifyAccountWithProvider), and an unvalidated beneficiary is refused at
// payout time.
const ACCOUNT_NUMBER_MIN_DIGITS = 10;
const ACCOUNT_NUMBER_MAX_DIGITS = 16;

function normalizeAccountNumber(value) {
    const digits = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!new RegExp(`^[0-9]{${ACCOUNT_NUMBER_MIN_DIGITS},${ACCOUNT_NUMBER_MAX_DIGITS}}$`).test(digits)) {
        throw new BankBeneficiaryError(
            `Account number must be ${ACCOUNT_NUMBER_MIN_DIGITS}-${ACCOUNT_NUMBER_MAX_DIGITS} digits (Azaman policy).`,
            'ACCOUNT_NUMBER_INVALID'
        );
    }
    return digits;
}

/**
 * Ask the provider (Agent B's adapter, injected as `port`) what account this
 * number is. The provider's answer is the ONLY thing that can make a
 * beneficiary verified; a stale directory, an outage, an AVD02 and an
 * inconclusive answer are all distinct, and none of them counts as verified.
 *
 * Returns { verified, reason, accountName?, bankName?, bankCode?, validatedAt?,
 *           definitive? }.
 */
async function verifyAccountWithProvider(port, { accountNumber, bankCode }) {
    if (!port || typeof port.listBanks !== 'function' || typeof port.validateBankAccount !== 'function') {
        return { verified: false, reason: 'VALIDATION_UNAVAILABLE' };
    }
    let directory;
    try {
        directory = await port.listBanks();
    } catch (err) {
        return { verified: false, reason: err?.code || 'DIRECTORY_UNAVAILABLE' };
    }
    // A stale directory may not validate anything: a bank code checked against
    // yesterday's list is not evidence (the adapter says stale:true explicitly).
    if (!directory || directory.stale === true) {
        return { verified: false, reason: 'DIRECTORY_STALE' };
    }
    const banks = Array.isArray(directory.banks) ? directory.banks : [];
    const canonical = banks.find((b) => b && String(b.code) === String(bankCode));
    if (!canonical) {
        return { verified: false, reason: 'BANK_CODE_UNKNOWN', definitive: true };
    }
    try {
        const v = await port.validateBankAccount({ accountNumber, bankCode: canonical.code });
        if (v && v.valid === true && typeof v.accountName === 'string' && v.accountName.trim() !== '') {
            return {
                verified: true,
                reason: null,
                // The PROVIDER's name, not the customer's typed string.
                accountName: v.accountName.trim().replace(/\s+/g, ' '),
                bankName: canonical.name || null,
                bankCode: String(canonical.code),
                validatedAt: v.validatedAt ? new Date(v.validatedAt) : new Date(),
            };
        }
        return { verified: false, reason: 'VALIDATION_INCONCLUSIVE' };
    } catch (err) {
        if (err?.code === 'ACCOUNT_NOT_FOUND') {
            // The provider's documented answer: this account does not exist at
            // this bank. That is definitive, so the save is refused.
            return { verified: false, reason: 'ACCOUNT_NOT_FOUND', definitive: true };
        }
        return { verified: false, reason: err?.code || 'VALIDATION_UNDETERMINED' };
    }
}

/**
 * The account name is the customer's assertion about whose account this is.
 * It is NOT evidence, and until a real bank name-enquiry verifies it we must
 * never present it as verified. Typed here so obviously-wrong values (blank,
 * digits only, a single character) are refused at save time.
 */
function assertAccountName(accountName) {
    if (accountName == null) return null;
    const name = String(accountName).trim().replace(/\s+/g, ' ');
    if (name === '') return null;
    if (name.length < 2 || name.length > 60) {
        throw new BankBeneficiaryError('Account name must be 2-60 characters.', 'ACCOUNT_NAME_INVALID');
    }
    if (!/[A-Za-z]/.test(name)) {
        throw new BankBeneficiaryError('Account name must contain letters.', 'ACCOUNT_NAME_INVALID');
    }
    if (!/^[A-Za-z][A-Za-z .'-]*$/.test(name)) {
        throw new BankBeneficiaryError('Account name contains unsupported characters.', 'ACCOUNT_NAME_INVALID');
    }
    return name;
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
        // null validatedAt => the name is the CUSTOMER'S ASSERTION. Callers
        // must show it as unverified; nothing here may imply a bank confirmed it.
        accountNameVerified: !!(row.validatedAt),
        accountNumberMasked: row.accountNumberMasked,
        nickname: row.nickname || null,
        status: row.status,
        isPrimary: row.isPrimary === true,
        validatedAt: row.validatedAt || null,
        createdAt: row.createdAt,
    };
}

// ── CRUD (owner-scoped, fail-closed) ────────────────────────────────────────
async function createBeneficiary(prisma, userId, input = {}, options = {}) {
    const { bankCode, bankName, accountNumber, nickname, isPrimary } = input;
    assertBankInput({ bankCode, bankName });
    const typedName = assertAccountName(input.accountName);
    const digits = normalizeAccountNumber(accountNumber);

    // §P0-3: server-owned provider validation. A client-supplied
    // accountNameVerified is NEVER read — verification exists only as the
    // provider's answer, timestamped, against the provider's own bank code.
    const verification = await verifyAccountWithProvider(options.port, { accountNumber: digits, bankCode });
    if (verification.definitive === true) {
        if (verification.reason === 'ACCOUNT_NOT_FOUND') {
            throw new BankBeneficiaryError(
                'The provider could not find that account at this bank. Check the number and bank.',
                'ACCOUNT_NOT_FOUND'
            );
        }
        if (verification.reason === 'BANK_CODE_UNKNOWN') {
            throw new BankBeneficiaryError(
                'That bank code is not in the provider bank directory.',
                'BANK_CODE_UNKNOWN'
            );
        }
    }
    const resolvedBankName = verification.verified && verification.bankName
        ? String(verification.bankName).trim()
        : String(bankName).trim();
    // Verified => the provider's name and timestamp. Unverified => the customer's
    // assertion stays, with validatedAt null so nothing can present it as checked.
    const effectiveName = verification.verified ? verification.accountName : typedName;
    const validatedAt = verification.verified ? verification.validatedAt : null;
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
                bankCode: verification.verified ? verification.bankCode : String(bankCode),
                bankName: resolvedBankName,
                accountNumberEnc: enc,
                accountNumberMasked: masked,
                accountName: effectiveName,
                nickname: nickname ? String(nickname).trim().slice(0, 40) : null,
                isPrimary: isPrimary === true,
                keyId: currentKeyId(),
                envelopeVersion: 2,
                // Re-saving invalidates any earlier verification: the value
                // changed, so the old evidence no longer describes this payee.
                // A NEW provider validation in this same call may re-establish it.
                validatedAt,
            },
        });
        return { ...toPublic(revived), verification: _verificationView(verification) };
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
                bankCode: verification.verified ? verification.bankCode : String(bankCode),
                bankName: resolvedBankName,
                accountNumberEnc: enc,
                accountNumberMasked: masked,
                accountNumberHmac: hmac,
                accountName: effectiveName,
                nickname: nickname ? String(nickname).trim().slice(0, 40) : null,
                isPrimary: isPrimary === true,
                keyId: currentKeyId(),
                envelopeVersion: 2,
                validatedAt,
            },
        });
    });
    return { ...toPublic(created), verification: _verificationView(verification) };
}

function _verificationView(verification) {
    if (!verification) return { status: 'UNVERIFIED', reason: 'VALIDATION_UNAVAILABLE' };
    return verification.verified
        ? { status: 'VERIFIED', provider: 'MOOLRE', validatedAt: verification.validatedAt }
        : { status: 'UNVERIFIED', reason: verification.reason };
}

/**
 * §P0-3: a bank payout may only go to a beneficiary the PROVIDER has verified.
 * The refusal is explicit and carries the reason, so the client can re-run
 * validation instead of retrying a payout that cannot settle.
 */
function assertPayableVerification(row) {
    if (!row || !row.validatedAt) {
        throw new BankBeneficiaryError(
            'This bank account has not been verified by the provider yet. Re-validate the account, then try again.',
            'BENEFICIARY_NOT_VERIFIED'
        );
    }
    return true;
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
        // Carried so callers can disclose verification state from evidence
        // rather than hardcoding "unverified" forever.
        validatedAt: row.validatedAt || null,
        accountNameVerified: !!(row.validatedAt),
        keyId: row.keyId,
    };
}

module.exports = {
    ACTIVE,
    ACCOUNT_NUMBER_MIN_DIGITS,
    ACCOUNT_NUMBER_MAX_DIGITS,
    verifyAccountWithProvider,
    assertPayableVerification,
    DELETED,
    BankBeneficiaryError,
    normalizeAccountNumber,
    assertAccountName,
    fingerprint,
    mask,
    toPublic,
    createBeneficiary,
    listBeneficiaries,
    getOwnedBeneficiary,
    deleteBeneficiary,
    revealForPayout,
};
