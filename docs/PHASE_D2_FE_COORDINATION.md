# Phase D-2 / D-3 — Frontend Coordination Notes

> **Status:** D-2 merged (BE PR #59). D-3 **REVERSES the azmBalance deletion** (in review).
> **IMPORTANT:** The FE should NOT drop azmBalance. The original D-2 FE coordination
> instructions below are **OBSOLETE**. See D-3 section at the top.

---

## Phase D-3 — CORRECTION (current state)

Phase D-2 incorrectly deleted the `azmBalance` column. Phase D-3 restores it
as an **independent loyalty-point ledger**. The FE should:

1. **KEEP `azmBalance`** in `User` model, `BalanceData`, socket handlers, etc.
2. **KEEP the AZM display** on profile/hologram card showing the raw `azmBalance`
   value from the API (it is NOT derived from `availableBalance × rate`).
3. **The withdrawal screen** should continue using `_azmBalance` for the crypto
   path for non-vendors (or implement new logic if withdrawal from AZM is
   deprecated — TBD by product decision).

### What D-2 did that STAYS (no FE impact):
- Trade settlement is now in USDC (completeTrade credits `availableBalance`)
- BUY-ad escrow uses `availableBalance → escrowLockedBalance`
- Withdrawal checks use `availableBalance`

### What D-2 did that is REVERTED (no FE change needed):
- `azmBalance` is BACK in all API responses (login, register, SSO, getUserDetails,
  profile, balance endpoint, dashboard, socket balance_update)
- The FE's existing code that reads `azmBalance` from JSON works as-is

---

## ~~Original D-2 instructions (OBSOLETE — DO NOT FOLLOW)~~

~~The `azmBalance` column has been dropped from the `User` table. All
settlement now goes directly to `availableBalance` (USDC). The "AZM"
concept survives purely as a UI display label derived from
`availableBalance * liveUsdToGhs`.~~

**These instructions are superseded by Phase D-3. Do not implement them.**
