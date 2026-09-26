// utils/feeMath.js
// =============================================================================
// Single source of truth for P2P fee-split arithmetic.
// Used by services/p2p.service.js (completeTrade) and __tests__/math.test.js.
//
// Called two ways:
//   • calculateFeeSplit(amount, feePct, adminPct)
//       vendorPct defaults to (1 - adminPct) — the simple complement split.
//       This is the shape __tests__/math.test.js locks in.
//   • calculateFeeSplit(amount, feePct, adminPct, vendorPct)
//       Explicit vendorPct — required by p2p.service.js, where a fee profile
//       can set vendorSplitPct independently of adminSplitPct. Passing it
//       preserves the production behaviour exactly (the inline block this
//       replaces used `feeProfile.vendorSplitPct || (1 - adminPct)`).
//
// All amounts are USDC, rounded to 6 dp (matching the on-chain settlement
// precision) to keep this byte-for-byte identical to the original inline math.
// =============================================================================
function calculateFeeSplit(amountCrypto, feePct, adminPct, vendorPct = 1 - adminPct) {
  const totalFeeUsdc  = parseFloat((amountCrypto * feePct).toFixed(6));
  const adminCutUsdc  = parseFloat((totalFeeUsdc * adminPct).toFixed(6));
  const vendorCutUsdc = parseFloat((totalFeeUsdc * vendorPct).toFixed(6));
  const netUsdc       = parseFloat((amountCrypto - totalFeeUsdc).toFixed(6));
  return { totalFeeUsdc, adminCutUsdc, vendorCutUsdc, netUsdc };
}

module.exports = { calculateFeeSplit };
