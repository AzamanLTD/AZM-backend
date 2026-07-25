// utils/escrowMath.js
// =============================================================================
// Pure functions for escrow fee arithmetic.
// Extracted from services/escrowService.js.
//
// Convention: fee is charged on the principal amount at the escrow fee pct
// (default 0.5%). The fee goes to SystemProfitFees. The payer's locked
// amount = principal + fee.
// =============================================================================

const SMART_ESCROW_FEE_PCT_DEFAULT = 0.005;
const _round6 = (n) => parseFloat(Number(n).toFixed(6));

/**
 * Compute the escrow fee and locked amounts.
 *
 * @param {number} amountUsdc - The principal amount
 * @param {number} [feePct] - Fee percentage (defaults to 0.5%)
 * @returns {object} - { feeUsdc, principalUsdc, totalLockedUsdc, feePctUsed }
 */
function calculateEscrowFee(amountUsdc, feePct = SMART_ESCROW_FEE_PCT_DEFAULT) {
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amountUsdc must be a positive number.');
  }

  const pct = Number(feePct);
  const feeUsdc = _round6(amount * pct);
  const totalLockedUsdc = _round6(amount + feeUsdc);

  return {
    feeUsdc,
    principalUsdc: _round6(amount),
    totalLockedUsdc,
    feePctUsed: pct,
  };
}

module.exports = { calculateEscrowFee, SMART_ESCROW_FEE_PCT_DEFAULT };
