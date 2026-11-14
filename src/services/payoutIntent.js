/**
 * Payout-intent binding for funding quotes (issue #389 P1-2).
 *
 * A shortfall quote is a CONSENT: "charge me this USDC to fund a GHS payout
 * that goes HERE for THIS much". A quote that carries only an amount is a
 * consent to fund *a* payout, not *this* payout — the same quote could then
 * fund a different rail, a different payee, or a different amount that happens
 * to need the same shortfall. The money split would still be correct, so
 * nothing would look wrong; the customer would simply have paid for something
 * they did not approve.
 *
 * So the quote's opaque identity token carries a digest of the intent it was
 * minted for, and consumption refuses unless the payout it is about to fund
 * produces the same digest.
 *
 * ONE normalizer, used by the mint side and the consume side, because a
 * binding that two call sites derive differently is not a binding.
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');

const INTENT_VERSION = 'pi1';

/**
 * The payee identity a payout actually reaches.
 *
 * BANK: the acceptance-time HMAC fingerprint of the account number — the same
 * value an operator sees, and stable across masking.
 * MOMO: the destination number in canonical digits (spaces, dashes and a
 * leading + are presentation, not identity).
 * Null when the caller has not named a payee: an amount-only quote stays
 * amount-only, and it cannot then be spent on a named payee.
 */
function destinationIdentityOf({ destinationType = 'MOMO', destination = null, destinationSnapshot = null, beneficiaryId = null } = {}) {
    const rail = String(destinationType || 'MOMO').toUpperCase();
    if (rail === 'BANK') {
        const fingerprint = destinationSnapshot?.fingerprint;
        const bankCode = destinationSnapshot?.bankCode;
        // Account digits are only unique WITHIN a bank: the same number at two
        // banks is two different payees. Fingerprint alone would let a quote
        // minted for one bank fund the other.
        if (fingerprint) {
            return bankCode ? `fp:${fingerprint}@${String(bankCode).toUpperCase()}` : `fp:${fingerprint}`;
        }
        if (beneficiaryId !== null && beneficiaryId !== undefined) return `bene:${beneficiaryId}`;
        return null;
    }
    const raw = String(destination ?? '').trim();
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    return digits || raw.toLowerCase();
}

/**
 * Digest over the intent a funding quote is bound to. Amounts are exact pesewas
 * (2dp), the rail is explicit, and the version tag is part of the input so a
 * future change to this function cannot silently accept an old binding.
 */
function payoutIntentDigest({ rail, recipientGhs, feeGhs = 0, destinationIdentity = null } = {}) {
    const canonical = [
        INTENT_VERSION,
        String(rail || 'MOMO').toUpperCase(),
        new Prisma.Decimal(recipientGhs).toFixed(2),
        new Prisma.Decimal(feeGhs ?? 0).toFixed(2),
        destinationIdentity === null || destinationIdentity === undefined
            ? '-'
            : String(destinationIdentity).trim(),
    ].join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

module.exports = {
    INTENT_VERSION,
    destinationIdentityOf,
    payoutIntentDigest,
};
