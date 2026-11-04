// services/p2p/feePolicy.js
// =============================================================================
// Single pure resolver for the P2P fee policy.
//
// Before this module, settlement (services/p2p.service.js) and the trade-
// creation earnings projection (controllers/tradeController.js) each resolved
// the fee independently. Both used the same sources but in drifting ways:
// settlement applied GlobalSettings.feeByPaymentMethod when no fee profile
// matched, while the projection ignored that map and advertised a different
// number from the one the trade would actually pay.
//
// Precedence is unchanged and deliberate:
//   1. A MATCHED AdminFeeProfile is authoritative, including legitimate 0.
//   2. Otherwise GlobalSettings.p2pFeePct, then a per-payment-method override.
//   3. Otherwise the caller's hard-coded fallbacks.
//
// `matchedProfile` is the ONLY signal of a match: a matched profile can carry
// 0 in every field, so zero must never be read as "no profile".
// =============================================================================

const normaliseMethodKey = (paymentMethod) => String(paymentMethod)
    .toUpperCase()
    .replace(/[\s-]/g, '_');

/**
 * @param {object}  args
 * @param {object}  args.settings      GlobalSettings row (may be null)
 * @param {object}  args.feeProfile    resolveFeeProfile() result (may be null)
 * @param {string}  args.paymentMethod trade payment method
 * @param {number|string} args.amountCrypto
 * @param {object}  args.defaults      { p2pFeePct, tierThreshold, adminOver1k, adminUnder1k }
 * @returns {{ feePct:number, adminPct:number, vendorPct:number, feeSource:string, matchedProfile:boolean }}
 */
function resolveP2pFeePolicy({ settings, feeProfile, paymentMethod, amountCrypto, defaults }) {
    const d = defaults || {};
    const hasProfile = feeProfile?.matchedProfile === true;

    const baseFeePct = hasProfile
        ? Number(feeProfile.platformFeePct)
        : Number(settings?.p2pFeePct ?? d.p2pFeePct);

    let feePct = baseFeePct;
    let feeSource = hasProfile ? 'FEE_PROFILE' : 'GLOBAL_SETTINGS';

    // A matched profile is more specific than the per-method map, so the map
    // only applies on the fallback path.
    if (!hasProfile && paymentMethod && settings?.feeByPaymentMethod) {
        let methodMap = null;
        try {
            methodMap = typeof settings.feeByPaymentMethod === 'string'
                ? JSON.parse(settings.feeByPaymentMethod)
                : settings.feeByPaymentMethod;
        } catch (err) {
            // A malformed admin setting must not throw inside a settlement
            // transaction; the base percentage already resolved above.
            methodMap = null;
        }
        if (methodMap) {
            const methodKey = normaliseMethodKey(paymentMethod);
            if (methodMap[methodKey] !== undefined) {
                feePct = Number(methodMap[methodKey]);
                feeSource = 'PAYMENT_METHOD_OVERRIDE';
            }
        }
    }

    const tierThreshold = Number(settings?.tierThreshold ?? d.tierThreshold);
    const legacyAdminPct = Number(amountCrypto) >= tierThreshold
        ? (1 - Number(settings?.vendorShareOver1k ?? (1 - d.adminOver1k)))
        : (1 - Number(settings?.vendorShareUnder1k ?? (1 - d.adminUnder1k)));

    // A profile's split is PAIRED (admin + vendor = 1); never mix it with the
    // legacy tier formula, which can over-allocate the fee.
    const adminPct = hasProfile ? Number(feeProfile.adminSplitPct) : legacyAdminPct;
    const vendorPct = hasProfile ? Number(feeProfile.vendorSplitPct) : (1 - adminPct);

    return { feePct, adminPct, vendorPct, feeSource, matchedProfile: hasProfile };
}

module.exports = { resolveP2pFeePolicy, normaliseMethodKey };
