// services/payoutDestinationClassification.js
// =============================================================================
// THE single authoritative payout-destination classification contract.
//
// OWNER-APPROVED CONTRACT (2026-10-27, PR "payout destination type contract"):
// destinations are classified by an EXPLICIT, validated `destinationType`
// request field. Numeric destinations are inherently ambiguous — a realistic
// 10-digit Ghana MoMo number and an 8–12 digit Binance Pay ID are the same
// string — so they are NEVER silently classified by digit length. A numeric
// destination without an explicit type is refused with
// DESTINATION_TYPE_REQUIRED; a type that contradicts the destination's
// format is refused with DESTINATION_TYPE_MISMATCH; an unrecognized format
// is refused with DESTINATION_FORMAT_UNRECOGNIZED.
//
// Authorization gating (middleware/fxTransactionGateMiddleware.js
// MOMO_PAYOUT_DESTINATION scope) and payout dispatch
// (controllers/walletController.js requestWithdrawal) resolve a destination
// through THIS module — the gate decision and the provider dispatch can
// never disagree, and both produce the SAME refusal for an unresolvable
// destination (financial-core blocker A).
//
// Unambiguous formats remain callable WITHOUT a type so existing clients
// are not broken wholesale: TRC20 addresses ('T' + 34 chars) and EVM
// addresses ('0x' + 42 chars) resolve exactly as before. Numeric
// destinations (phone numbers, Binance Pay IDs) REQUIRE the explicit type.
//
// Enum:
//   MOMO            numeric, 9–15 digits (optional leading '+')
//                   → payoutMethod MOMO — the GHS cross-border payout leg,
//                   FX-fresh-rate-gated.
//   BINANCE_PAY_ID  numeric, 8–12 digits
//                   → payoutMethod BINANCE_ID — zero-fee, same-asset USDC.
//   TRC20           'T' + 34 chars → EXTERNAL_WALLET / TRC20.
//   ERC20           '0x' + 42 chars → EXTERNAL_WALLET / ERC20.
//   BEP20           '0x' + 42 chars → EXTERNAL_WALLET / BEP20.
//
// Result status:
//   RESOLVED      — classification is authoritative; payoutMethod is set.
//   AMBIGUOUS     — numeric destination without a type. Refuse.
//   UNRECOGNIZED  — format matches no destination class at all. Refuse.
//   INVALID_TYPE  — the given destinationType is not in the enum. Refuse.
//   MISMATCH      — the given type contradicts the destination's format.
//                   Refuse.
// =============================================================================

const DESTINATION_TYPES = Object.freeze([
    'MOMO',
    'BINANCE_PAY_ID',
    'TRC20',
    'ERC20',
    'BEP20',
]);

// The ONE refusal contract shared by the FX gate and the dispatch
// controller — same codes, same messages, so a refusal can never disagree.
function payoutDestinationRefusal(result) {
    switch (result.status) {
        case 'AMBIGUOUS':
            return {
                code: 'DESTINATION_TYPE_REQUIRED',
                message: 'Numeric payout destinations are ambiguous between mobile money and Binance Pay IDs. Provide destinationType: MOMO or BINANCE_PAY_ID.',
            };
        case 'UNRECOGNIZED':
            return {
                code: 'DESTINATION_FORMAT_UNRECOGNIZED',
                message: 'Unrecognized payout destination format.',
            };
        case 'INVALID_TYPE':
            return {
                code: 'DESTINATION_TYPE_INVALID',
                message: `destinationType must be one of: ${DESTINATION_TYPES.join(', ')}.`,
            };
        case 'MISMATCH':
            return {
                code: 'DESTINATION_TYPE_MISMATCH',
                message: `destinationType ${result.destinationType} does not match the destination format.`,
            };
        default:
            return { code: 'DESTINATION_UNRESOLVED', message: 'Payout destination could not be resolved.' };
    }
}

function _isNumeric(s) {
    return /^\d+$/.test(s);
}

function _momoNumber(s) {
    const t = s.startsWith('+') ? s.slice(1) : s;
    return _isNumeric(t) && t.length >= 9 && t.length <= 15 ? t : null;
}

function resolvePayoutDestination(destination, destinationType, networkPref) {
    const cleanDest = String(destination ?? '').trim();
    const type = destinationType ? String(destinationType).trim().toUpperCase() : null;

    if (type !== null && !DESTINATION_TYPES.includes(type)) {
        return { status: 'INVALID_TYPE', destinationType: type, payoutMethod: null, detectedNetwork: null };
    }

    // Unambiguous formats resolve with or without an explicit type.
    if (cleanDest.startsWith('T') && cleanDest.length === 34) {
        if (type === 'BINANCE_PAY_ID' || type === 'MOMO') {
            return { status: 'MISMATCH', destinationType: type, payoutMethod: null, detectedNetwork: null };
        }
        return { status: 'RESOLVED', destinationType: type || 'TRC20', payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: 'TRC20' };
    }
    if (cleanDest.startsWith('0x') && cleanDest.length === 42) {
        if (type === 'BINANCE_PAY_ID' || type === 'MOMO' || type === 'TRC20') {
            return { status: 'MISMATCH', destinationType: type, payoutMethod: null, detectedNetwork: null };
        }
        const evmNetwork = type === 'ERC20' ? 'ERC20' : (type === 'BEP20' ? 'BEP20' : (networkPref === 'ERC20' ? 'ERC20' : 'BEP20'));
        return { status: 'RESOLVED', destinationType: type || evmNetwork, payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: evmNetwork };
    }

    const momo = _momoNumber(cleanDest);
    const isBinanceWindow = _isNumeric(cleanDest) && cleanDest.length >= 8 && cleanDest.length <= 12;

    if (type === 'MOMO') {
        return momo !== null
            ? { status: 'RESOLVED', destinationType: 'MOMO', payoutMethod: 'MOMO', detectedNetwork: networkPref || 'MTN' }
            : { status: 'MISMATCH', destinationType: type, payoutMethod: null, detectedNetwork: null };
    }
    if (type === 'BINANCE_PAY_ID') {
        return isBinanceWindow
            ? { status: 'RESOLVED', destinationType: 'BINANCE_PAY_ID', payoutMethod: 'BINANCE_ID', detectedNetwork: 'BINANCE_PAY' }
            : { status: 'MISMATCH', destinationType: type, payoutMethod: null, detectedNetwork: null };
    }
    if (type === 'TRC20' || type === 'ERC20' || type === 'BEP20') {
        // TRC20/EVM formats were handled above — reaching here means the
        // destination is not that format.
        return { status: 'MISMATCH', destinationType: type, payoutMethod: null, detectedNetwork: null };
    }

    // No type. Numeric strings are NEVER digit-length-guessed: a phone
    // number and a Binance Pay ID are indistinguishable by format.
    if (momo !== null || isBinanceWindow || _isNumeric(cleanDest)) {
        return { status: 'AMBIGUOUS', destinationType: null, payoutMethod: null, detectedNetwork: null };
    }
    return { status: 'UNRECOGNIZED', destinationType: null, payoutMethod: null, detectedNetwork: null };
}

// The FX-gate predicate: a destination is FX-dependent exactly when it
// resolves to the MOMO payout method (the GHS cross-border leg). Never a
// superset or subset — the SAME resolution, so the gate can never refuse a
// same-asset dispatch nor pass a GHS-converting one. Unresolvable
// destinations are NOT the gate's business to pass: the shared refusal
// (payoutDestinationRefusal) answers them identically at both layers.
function isMomoPayoutDestination(destination, destinationType, networkPref) {
    const r = resolvePayoutDestination(destination, destinationType, networkPref);
    return r.status === 'RESOLVED' && r.payoutMethod === 'MOMO';
}

module.exports = {
    DESTINATION_TYPES,
    resolvePayoutDestination,
    isMomoPayoutDestination,
    payoutDestinationRefusal,
};
