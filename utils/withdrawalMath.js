// utils/withdrawalMath.js
// =============================================================================
// Pure functions for withdrawal exit-fee and influencer-split arithmetic.
// Extracted from services/finance.service.js.
//
// Convention (matches finance.service.js):
//   • EXIT_FEE_PERCENT = 2% on the gross withdrawal amount.
//   • The fee splits 50/50: 1% to the influencer (if referredByCode resolves),
//     1% to SystemProfitFees. If no referrer, the full 2% goes to SystemProfitFees.
//   • The user receives amount × (1 − EXIT_FEE_PERCENT), i.e. 98% of the gross.
//   • AZM fee discounts can reduce the exit fee (25%, 50%, or 100% off).
// =============================================================================

const EXIT_FEE_PERCENT = 0.02;
const _round6 = (n) => parseFloat(Number(n).toFixed(6));

/**
 * Compute the exit fee breakdown for a fiat withdrawal.
 *
 * @param {number} grossAmount - The gross USD amount being withdrawn
 * @param {object} [opts]
 * @param {number} [opts.feePctOverride] - Override the default 2% exit fee
 * @param {number} [opts.feeDiscountMultiplier] - 0.25, 0.50, or 1.00 (from AZM spend)
 * @param {boolean} [opts.hasReferrer] - Whether the user has a valid influencer referral
 * @returns {object} - { exitFee, influencerCut, platformCut, netToUser, feePctUsed }
 */
function calculateExitFee(grossAmount, opts = {}) {
  const feePct = opts.feePctOverride != null ? Number(opts.feePctOverride) : EXIT_FEE_PERCENT;
  const discountMult = Math.min(1.0, Math.max(0, Number(opts.feeDiscountMultiplier) || 0));
  const effectiveFeePct = feePct * (1 - discountMult);

  const exitFee = _round6(grossAmount * effectiveFeePct);
  const netToUser = _round6(grossAmount - exitFee);

  let influencerCut = 0;
  let platformCut = exitFee;

  if (opts.hasReferrer && exitFee > 0) {
    // 50/50 split
    influencerCut = _round6(exitFee * 0.5);
    platformCut = _round6(exitFee - influencerCut);
  }

  return { exitFee, influencerCut, platformCut, netToUser, feePctUsed: effectiveFeePct };
}

/**
 * Compute the AZM fee discount multiplier for a given tier.
 * Returns 0.25, 0.50, or 1.00.
 */
function getFeeDiscountMultiplier(tierId) {
  const tiers = {
    tier_25: 0.25,
    tier_50: 0.50,
    tier_100: 1.00,
  };
  return tiers[tierId] ?? 0;
}

module.exports = { calculateExitFee, getFeeDiscountMultiplier, EXIT_FEE_PERCENT };
