// services/payoutDestinationClassification.js
// =============================================================================
// THE single authoritative payout-destination classification contract.
//
// Financial-core consolidation (review blocker A): authorization gating
// (middleware/fxTransactionGateMiddleware.js MOMO_PAYOUT_DESTINATION scope)
// and payout dispatch (controllers/walletController.js requestWithdrawal)
// MUST classify a destination identically — the gate decision and the
// provider dispatch can never disagree. Both call THIS module; neither
// re-implements the detection.
//
// The detection itself is a FAITHFUL extraction of the historical
// walletController "address detective" semantics — the dispatch contract is
// unchanged by this refactor, it is only deduplicated:
//
//   numeric, length 8-12   → BINANCE_ID  (Binance Pay ID window)
//   'T' + 34 chars         → EXTERNAL_WALLET (TRC20)
//   '0x' + 42 chars        → EXTERNAL_WALLET (ERC20/BEP20, network hint)
//   numeric, length >= 13  → MOMO (GHS mobile-money payout)
//   anything else          → UNKNOWN
//
// KNOWN CONTRACT GAP (reported to the owner, deliberately NOT changed here):
// a numeric destination in the 8-12 window is ambiguous — a realistic
// 10-digit Ghana MoMo number and a 9-12 digit Binance Pay ID are
// indistinguishable by the current request contract ({ destination,
// networkPref }: networkPref is a display-network hint, not an
// authoritative destination-type discriminator). The dispatcher has always
// resolved that ambiguity by digit length (Binance wins the 8-12 window),
// so the gate follows the SAME rule: gate exactly what the system will
// actually dispatch as a GHS payout. A durable fix needs an explicit
// destination-type request field (a contract change requiring product
// approval) — it must not be invented here, and digit-length guessing must
// not be "corrected" on one side only.
// =============================================================================

const BINANCE_ID_MIN = 8;
const BINANCE_ID_MAX = 12;

function classifyPayoutDestination(destination, networkPref) {
    const cleanDest = String(destination ?? '').trim();
    const isNumeric = /^\d+$/.test(cleanDest);

    if (isNumeric && cleanDest.length >= BINANCE_ID_MIN && cleanDest.length <= BINANCE_ID_MAX) {
        return { payoutMethod: 'BINANCE_ID', detectedNetwork: 'BINANCE_PAY' };
    }
    if (cleanDest.startsWith('T') && cleanDest.length === 34) {
        return { payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: 'TRC20' };
    }
    if (cleanDest.startsWith('0x') && cleanDest.length === 42) {
        // ERC20 vs BEP20 is a network PREFERENCE on the same external-wallet
        // classification; the caller resolves the gas fee from it.
        return { payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: networkPref || 'BEP20' };
    }
    // Numeric and outside the Binance Pay ID window. Reached only for
    // length >= 13 (length 1-7 numeric falls through to UNKNOWN, exactly as
    // the historical detective did: its MoMo branch demanded >= 9 digits,
    // and every 9-12 digit string was already claimed by BINANCE_ID above).
    if (isNumeric && cleanDest.length >= 9) {
        return { payoutMethod: 'MOMO', detectedNetwork: networkPref || 'MTN' };
    }
    return { payoutMethod: 'UNKNOWN', detectedNetwork: networkPref || 'UNKNOWN' };
}

// The FX-gate predicate: a destination is FX-dependent exactly when the
// dispatcher will execute a GHS mobile-money payout for it. Never a superset
// or subset — the SAME classification, so the gate can never refuse a
// same-asset dispatch nor pass a GHS-converting one.
function isMomoPayoutDestination(destination) {
    return classifyPayoutDestination(destination).payoutMethod === 'MOMO';
}

module.exports = { classifyPayoutDestination, isMomoPayoutDestination };
