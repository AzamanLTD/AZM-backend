'use strict';

/**
 * SAVED BANK PAYOUT BENEFICIARIES (issue #389 section 4, withdrawal workstream)
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
 * Ask the provider (the adapter workstream's adapter, injected as `port`) what account this
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
/**
 * §P1-3 ACCOUNT POLICY: a bounded payee list.
 *
 * A saved-payee list is a payout surface. Unbounded, it becomes a place to keep
 * hundreds of accounts — which is not a customer saving an account, it is a
 * disbursement list nobody is reviewing. The cap is enforced inside the write
 * transaction so two concurrent saves cannot both slip under it.
 */
const MAX_ACTIVE_BENEFICIARIES = 25;

/**
 * Is this Prisma error the primary-exclusivity index (a concurrency collision
 * that a retry resolves) rather than the payee duplicate key (a real answer)?
 */
function _isPrimaryCollision(err) {
    if (!err || err.code !== 'P2002') return false;
    const text = `${JSON.stringify(err.meta?.target ?? '')} ${err.message || ''}`.toLowerCase();
    if (text.includes('accountnumberhmac')) return false;
    return text.includes('oneprimary') || text.includes('one_primary') || text.includes('userid');
}

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

    // One transactional write for BOTH paths. Saving an account and reviving a
    // deleted one differ only in which row is written; keeping them apart is how
    // the revival path lost the primary-exclusivity rule in the first place
    // (it set isPrimary with nobody demoted, so a customer could end up with two
    // primaries). Uniqueness is per-owner over the FINGERPRINT — the same
    // account saved twice is a duplicate instruction, not two payees.
    const writeOnce = async () => prisma.$transaction(async (tx) => {
        const existing = await tx.savedBankBeneficiary.findUnique({
            where: { userId_accountNumberHmac: { userId, accountNumberHmac: hmac } },
        });
        if (existing && existing.status === ACTIVE) {
            throw new BankBeneficiaryError('This bank account is already saved.', 'BENEFICIARY_DUPLICATE');
        }
        // Policy is checked against the state this write would produce.
        const activeCount = await tx.savedBankBeneficiary.count({ where: { userId, status: ACTIVE } });
        if (activeCount >= MAX_ACTIVE_BENEFICIARIES) {
            throw new BankBeneficiaryError(
                `You can keep up to ${MAX_ACTIVE_BENEFICIARIES} saved bank accounts. Remove one to add another.`,
                'BENEFICIARY_LIMIT_REACHED'
            );
        }
        if (isPrimary === true) {
            // Demote first: within this transaction the index never sees two.
            await tx.savedBankBeneficiary.updateMany({
                where: { userId, status: ACTIVE, isPrimary: true },
                data: { isPrimary: false },
            });
        }
        if (existing) {
            return tx.savedBankBeneficiary.update({
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
                    // changed, so the old evidence no longer describes this
                    // payee. A NEW provider validation in this same call may
                    // re-establish it.
                    validatedAt,
                },
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

    let created;
    try {
        created = await writeOnce();
    } catch (err) {
        if (_isPrimaryCollision(err)) {
            // Two concurrent saves both wanted to be primary. The winner is
            // committed; this attempt demotes it on the retry, so the last
            // instruction wins and exactly one primary remains.
            created = await writeOnce();
        } else if (err && err.code === 'P2002') {
            // The payee unique key, hit by a concurrent save of the same account.
            throw new BankBeneficiaryError('This bank account is already saved.', 'BENEFICIARY_DUPLICATE');
        } else {
            throw err;
        }
    }
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


// ── §P1C BANK DIRECTORY ──────────────────────────────────────────────────────
// The list of banks is PROVIDER data, never a hardcoded table: a bank code the
// adapter does not know cannot be paid, and codes are opaque strings (leading
// zeroes are meaningful: "030100" is not 30100).
async function listBankDirectory(port, { forceRefresh = false } = {}) {
    if (!port || typeof port.listBanks !== 'function') {
        throw new BankBeneficiaryError('The bank directory is not available right now.', 'BANK_DIRECTORY_UNAVAILABLE');
    }
    let result;
    try {
        result = await port.listBanks({ forceRefresh: forceRefresh === true });
    } catch (err) {
        logger.warn({ err: err?.message }, '[bankBeneficiary] directory unavailable');
        throw new BankBeneficiaryError('The bank directory is not available right now.', 'BANK_DIRECTORY_UNAVAILABLE');
    }
    const raw = Array.isArray(result?.banks) ? result.banks : (Array.isArray(result) ? result : null);
    if (!raw) {
        throw new BankBeneficiaryError('The bank directory returned an unusable response.', 'BANK_DIRECTORY_UNAVAILABLE');
    }
    const banks = raw
        .filter((b) => b && b.code !== undefined && b.code !== null && typeof b.name === 'string' && b.name.trim() !== '')
        .map((b) => ({ code: String(b.code), name: b.name.trim() }));
    if (banks.length === 0) {
        throw new BankBeneficiaryError('The bank directory returned no usable banks.', 'BANK_DIRECTORY_UNAVAILABLE');
    }
    return {
        banks,
        source: result.source || 'MOOLRE',
        retrievedAt: result.retrievedAt || result.fetchedAt || new Date().toISOString(),
        // Honest freshness: a cached directory is reported as cached, and it is
        // never allowed to establish a verified beneficiary (see
        // verifyAccountWithProvider, which refuses a stale directory outright).
        stale: result.stale === true,
    };
}

// ── §P1C SAFE UPDATE ─────────────────────────────────────────────────────────
// A saved payee's DESTINATION is immutable. Changing the account number or bank
// must be a new payee, because a payout quote/consent binds to the exact
// destination that was verified; an in-place edit would mutate the meaning of
// every quote the customer already approved. Only presentation and preference
// fields are updatable.
const UPDATABLE_FIELDS = ['nickname', 'isPrimary'];
const IMMUTABLE_FIELDS = ['accountNumber', 'bankCode', 'bankName', 'accountName', 'validatedAt', 'status'];

async function updateBeneficiary(prisma, userId, id, patch = {}) {
    const keys = Object.keys(patch || {});
    const forbidden = keys.filter((k) => !UPDATABLE_FIELDS.includes(k));
    if (forbidden.length) {
        const immutable = forbidden.filter((k) => IMMUTABLE_FIELDS.includes(k));
        throw new BankBeneficiaryError(
            immutable.length
                ? `These fields identify the payee and cannot be changed: ${immutable.join(', ')}. Save the new account as a new beneficiary.`
                : `These fields cannot be updated: ${forbidden.join(', ')}.`,
            immutable.length ? 'BENEFICIARY_FIELD_IMMUTABLE' : 'BENEFICIARY_FIELD_NOT_UPDATABLE'
        );
    }
    if (keys.length === 0) {
        throw new BankBeneficiaryError('Nothing to update.', 'BENEFICIARY_UPDATE_EMPTY');
    }
    const row = await getOwnedBeneficiary(prisma, userId, id);
    if (row.status !== ACTIVE) {
        throw new BankBeneficiaryError('This beneficiary is no longer active.', 'BENEFICIARY_NOT_FOUND');
    }
    const data = {};
    if (patch.nickname !== undefined) {
        data.nickname = patch.nickname === null ? null : String(patch.nickname).trim().slice(0, 40);
    }
    if (patch.isPrimary !== undefined) data.isPrimary = patch.isPrimary === true;

    const write = async () => prisma.$transaction(async (tx) => {
        // ONE WINNER: the partial unique index (user_id WHERE is_primary) makes
        // two concurrent promotions impossible, and the demote-then-promote runs
        // in the same transaction so a refusal leaves the old primary intact.
        if (data.isPrimary === true) {
            await tx.savedBankBeneficiary.updateMany({
                where: { userId, status: ACTIVE, isPrimary: true, NOT: { id: row.id } },
                data: { isPrimary: false },
            });
        }
        return tx.savedBankBeneficiary.update({ where: { id: row.id }, data });
    });

    let updated;
    try {
        updated = await write();
    } catch (err) {
        if (_isPrimaryCollision(err)) {
            updated = await write();
        } else {
            throw err;
        }
    }
    return toPublic(updated);
}

// ── §P1C REVALIDATION ────────────────────────────────────────────────────────
// The provider's evidence is bound to the EXACT stored account number and bank
// code: the number is decrypted server-side, never taken from the client, and the
// name that gets stored is the provider's, never a customer-supplied string.
async function revalidateBeneficiary(prisma, userId, id, { port } = {}) {
    const row = await getOwnedBeneficiary(prisma, userId, id);
    if (row.status !== ACTIVE) {
        throw new BankBeneficiaryError('This beneficiary is no longer active.', 'BENEFICIARY_NOT_FOUND');
    }
    const revealed = await revealForPayout(prisma, userId, id);
    const verification = await verifyAccountWithProvider(port, {
        accountNumber: revealed.accountNumber,
        bankCode: row.bankCode,
    });
    if (!verification.verified) {
        // A FAILED revalidation must not leave the row looking verified, so a
        // definitive provider answer on a stored account is recorded by
        // withdrawing the evidence rather than by editing the number.
        if (verification.definitive) {
            await prisma.savedBankBeneficiary.update({ where: { id: row.id }, data: { validatedAt: null } });
        }
        throw new BankBeneficiaryError(
            verification.reason === 'VALIDATION_UNAVAILABLE' || verification.reason === 'DIRECTORY_UNAVAILABLE'
                ? 'Bank account verification is unavailable right now. Nothing was changed.'
                : 'The provider could not verify this account. Nothing was changed.',
            verification.reason === 'VALIDATION_UNAVAILABLE' || verification.reason === 'DIRECTORY_UNAVAILABLE'
                ? 'VALIDATION_UNAVAILABLE'
                : (verification.definitive ? verification.reason : 'VALIDATION_UNDETERMINED')
        );
    }
    const updated = await prisma.savedBankBeneficiary.update({
        where: { id: row.id },
        data: {
            // Provider-owned evidence only, bound to the stored destination.
            accountName: verification.accountName || row.accountName,
            bankName: verification.bankName || row.bankName,
            validatedAt: verification.validatedAt || new Date(),
        },
    });
    return { beneficiary: toPublic(updated), verification: _verificationView(verification) };
}

module.exports = {
    ACTIVE,
    MAX_ACTIVE_BENEFICIARIES,
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
    listBankDirectory,
    updateBeneficiary,
    revalidateBeneficiary,
    deleteBeneficiary,
    revealForPayout,
};
