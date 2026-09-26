# Phase D — AZM Ledger Redesign (Design Pass)

> **Status:** Design proposal. **No code change in this PR.** This document
> exists so the AZM-trap and BUY-ad-double-credit findings from the audit
> can be debated, the right path chosen, and a follow-up implementation PR
> opened with confidence.
>
> Date: 2026-05-25.
> Surface area: `services/p2p.service.js`, `controllers/tradeController.js`,
> `controllers/walletController.js`, `workers/tradeWorker.js`,
> `prisma/schema.prisma` (User.azmBalance + a possible new User.azmEscrow column).

---

## TL;DR — What the audit asked us to fix

Phase B logged two findings against the AZM token model:

1. **`azmBalance` is a one-way trap.** Users accumulate AZM via P2P
   trade completion but cannot withdraw, transfer, or save with it.
2. **The BUY-ad ledger flow is internally inconsistent.** A BUY-ad
   trade decrements the user's `azmBalance` on initiate AND increments
   it again on complete — net AZM movement is zero, which means BUY-ad
   trades currently transfer no AZM from the user to anywhere.

This document confirms one finding (the BUY-ad bug is real and
reproducible by reading the code) and **partially refutes** the other
(`azmBalance` does have a withdraw path in `walletController.processWithdrawal`,
just not the same set of rails the V2 ledger uses for `availableBalance`).
The trap is narrower than the audit framed it but still real.

---

## 1. The current AZM flow — mapped from live code

### 1.1 What `azmBalance` represents

Per `prisma/schema.prisma:193`:

```prisma
azmBalance Float @default(0.0) // AZAMAN TOKEN (1 AZM = 1 GHS)
```

`azmBalance` is denominated in **GHS-equivalent units** (1 AZM = 1 GHS).
This is distinct from `availableBalance`, which is denominated in
**USDC**. The two columns are NOT interchangeable — a sum across users
of `azmBalance + availableBalance` is unitful only after you convert one
side via the live oracle rate.

The "Hologram" model in `AZAMAN_MASTER_SOUL.md §1` is built on top of
`availableBalance × yellowCardRate` (post-Phase-J). `azmBalance` is a
separate settlement-token bucket with its own rules.

### 1.2 Every AZM read/write site (BE-wide grep)

| File | Line | Direction | Trigger |
|---|---|---|---|
| `controllers/authController.js` | 119, 148, 231 | init | New user `create` (3 paths) |
| `controllers/ssoController.js` | 121 | init | SSO new-user `create` |
| `controllers/profileController.js` | 47, 248, 422 | read | Profile / balance / dashboard selects |
| `controllers/profileController.js` | 522 | read | Hologram envelope `{ azm }` |
| `controllers/authController.js` | 268, 337, 383 | read | Login / register / `/auth/me` selects |
| `controllers/ssoController.js` | 194 | read | SSO response select |
| `server.js` | 330, 341 | read | `emitBalanceUpdate` socket select |
| **`controllers/tradeController.js:218`** | — | **read** (gate) | **BUY-ad trade `initiate` — checks `user.azmBalance < userAzmAmount`** |
| **`controllers/tradeController.js:224-226`** | — | **DEBIT** | **BUY-ad trade `initiate` — `decrement: userAzmAmount`** |
| `services/p2p.service.js:267-270` | — | CREDIT | Underpayment partial release on a SELL-ad: `paidAmountFiat` to user's `azmBalance` |
| **`services/p2p.service.js:533-536`** | — | **CREDIT** | **`completeTrade` — `increment: buyerAzmCredit` to `trade.userId` regardless of ad type** |
| `workers/tradeWorker.js:202` | — | CREDIT | Auto-cancel refund: `trade.amountFiat` back to user's `azmBalance` |
| `controllers/adminController.js:193` | — | CREDIT | Admin force-cancel: refunds buyer's AZM portion |
| `controllers/adminController.js:1129` | — | CREDIT | Admin reject withdrawal: refunds AZM that was previously debited |
| **`controllers/walletController.js:71-78`** | — | **DEBIT** | **`processWithdrawal` — debits AZM by `withdrawAmount` (this IS the withdraw path; see §1.4)** |

### 1.3 SELL-ad flow (working as designed)

Vendor advertises *I will sell crypto for fiat*. Buyer (trade.userId)
pays fiat externally, vendor releases crypto.

| Step | `availableBalance` | `escrowLockedBalance` | `azmBalance` | `SystemProfitFees` |
|---|---|---|---|---|
| `initiate` (vendor side) | −amountCrypto USDC | +amountCrypto USDC | — | — |
| `initiate` (user/buyer side) | — | — | — | — |
| `complete` (vendor side) | +vendorCutUsdc | −amountCrypto | — | — |
| `complete` (user/buyer side) | — | — | **+buyerAzmCredit (GHS)** | — |
| `complete` (system) | — | — | — | +adminCutUsdc |

`buyerAzmCredit = amountCrypto × (liveRate − adminMarginGhs)`. So a
$100 USDC trade at rate 15.50 GHS with 2 GHS margin gives the buyer
1,350 AZM (= 1,350 GHS-equivalent). Buyer paid 1,550 GHS externally
to receive 1,350 AZM on-platform — net **200 GHS to the platform** as
the spread profit.

USDC accounting closes:
```
vendor outflow      = amountCrypto                    (escrowLocked → 0)
admin profit (USDC) = adminCutUsdc                    (→ SystemProfitFees)
vendor cut (USDC)   = vendorCutUsdc                   (→ availableBalance)
net principal       = amountCrypto − totalMarginUsdc  (= buyer's AZM in GHS / liveRate)
```

The "net principal" of USDC is converted to GHS at the live rate and
the result becomes the buyer's `azmBalance` increment. This is the
**hologram settlement** for SELL ads: the buyer's USDC entitlement is
expressed as a GHS-denominated AZM token instead of credited as USDC.

### 1.4 The AZM withdrawal path (`walletController.processWithdrawal`)

This is what the audit missed. `walletController.js:71-78` ships an
AZM-to-fiat / AZM-to-Binance / AZM-to-external-crypto withdrawal:

```js
if (user.azmBalance < withdrawAmount) {
    throw new Error("Insufficient AZM balance.");
}
await tx.user.update({
    where: { id: userId },
    data: { azmBalance: { decrement: withdrawAmount } }
});
```

`destination` heuristics route to one of three rails (Binance ID, MoMo
phone number, external on-chain wallet). A `Withdrawal` row is
created with status `PENDING` for the admin queue.

So **AZM is not a one-way trap** — there's a working withdrawal path.
But it lives on a separate rail from `availableBalance` (the V2 USDC
withdrawal at `controllers/withdrawalController.js`), creating the
two-track model the audit objected to.

The narrow but correct framing: AZM is **stranded liquidity**. It
cannot be:
- Used in `peerTransferController` (reads `availableBalance`).
- Used in `savingsController.deposit` (reads `availableBalance`).
- Used as collateral for ad creation (`adController` post-Phase-B reads `availableBalance`).
- Spent in `chat/transfer` (reads `availableBalance`).

The user has to "downcycle" AZM to fiat via `walletController.processWithdrawal`
and back-deposit through `/deposit/fiat/initiate` before they can use
it for any V2 feature. Two extra round-trips, a 2% withdrawal fee
each direction, and a settlement delay — for a balance the platform
already holds.

### 1.5 The BUY-ad bug (the real finding)

Vendor advertises *I will buy crypto with my fiat*. The user
(trade.userId) is the **seller** in this trade — they release crypto;
the vendor pays fiat externally.

Looking at `tradeController.js:215-228` (BUY-ad initiate path):

```js
} else {  // BUY ad
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.azmBalance < userAzmAmount) {
        throw new Error('You have insufficient AZM balance to sell.');
    }
    const azmLock = await tx.user.updateMany({
        where: {
            id: userId,
            azmBalance: { gte: userAzmAmount }
        },
        data: { azmBalance: { decrement: userAzmAmount } }
    });
    ...
}
```

The user's `azmBalance` is decremented by `userAzmAmount` (the
GHS-equivalent of the trade's crypto amount). **Note:** there is NO
matching escrow column. The AZM goes from `azmBalance` to the
ether — no `azmEscrowBalance` row, no `escrowLockedBalance` (because
that's USDC-denominated, not GHS).

Then in `services/p2p.service.js:530-540` (completeTrade, applies to
**both** ad types):

```js
const result = await prisma.$transaction(async (tx) => {
    // 1. Credit buyer
    await tx.user.update({
        where: { id: trade.userId },
        data:  { azmBalance: { increment: buyerAzmCredit } }
    });
    ...
});
```

For a BUY-ad trade, `trade.userId` is the *seller*, not the buyer of
crypto. But the code calls them "buyer" because the variable name
follows the trade row's perspective (`trade.userId` is whoever
responded to the ad). And it credits their `azmBalance` by
`buyerAzmCredit = amountCrypto × effectiveRate`.

**The accounting:**

| Step | User's `azmBalance` movement | User's `availableBalance` |
|---|---|---|
| BUY-ad `initiate` | −userAzmAmount | unchanged |
| BUY-ad `complete` | +buyerAzmCredit | unchanged |

`userAzmAmount` is `amountCrypto * liveRate` (read upstream from `tradeController.js`'s
amount-validation block). `buyerAzmCredit` is `amountCrypto * (liveRate − adminMarginGhs)`.
**Net AZM change = `−amountCrypto × adminMarginGhs`** (a small loss for the user equal to
the platform margin in GHS). The user effectively pays the margin in AZM, gets nothing
in return, and the vendor gets the crypto for free.

That's not "internally inconsistent" — that's broken. The BUY ad currently
**cannot transfer crypto value from user to vendor**.

Vendor side:
| Step | Vendor's `availableBalance` |
|---|---|
| BUY-ad `initiate` | unchanged |
| BUY-ad `complete` | +(amountCrypto − adminCutUsdc) |

So the vendor gains crypto value out of thin air, and the user loses
margin AZM out of thin air. The platform gains the margin USDC. This
is a money-correctness P0 if BUY ads ever go live in production.

### 1.6 Why the audit's framing was partially wrong

The audit said "BUY-ad path debits user's AZM on initiate AND credits
on complete — internally inconsistent." That's the right shape but
the wrong polarity: the **user is the seller** in a BUY-ad trade, so
they SHOULD have their crypto debited and lose the value. The bug
isn't the credit-on-complete — it's that the **complete-time credit
shouldn't exist at all for BUY ads** (or the initiate-time debit is
the wrong magnitude / wrong column / both).

---

## 2. Design constraints

Any redesign needs to satisfy:

1. **No double-counting.** Total system AZM + USDC × rate must be
   conserved across every state transition.
2. **Idempotent timeouts.** `tradeWorker.js`'s auto-cancel path
   refunds the seller. The refund column must match the lock column
   exactly.
3. **`runDoubleCheck` consistent.** Every `User.{available,azm}Balance`
   mutation must have a paired `TransactionHistory` row.
4. **Rollback-safe.** If the redesign changes the lock column, every
   manual-cancel / dispute-force-cancel / admin-reject path must be
   updated in the same PR.
5. **Hologram math unchanged.** The frontend computes display GHS as
   `availableBalance × yellowCardRate`. Adding AZM to that display
   value is a separate UX choice (current FE already shows AZM
   separately — see `lib/screens/profile_screen.dart`).
6. **Backwards compat for users with non-zero AZM today.** Whatever
   we do, existing AZM balances must remain spendable (or be
   converted to a spendable column at migration time).

---

## 3. Three proposals

### Option A — Minimal patch (the BUY-ad fix only)

**Change:** Skip the buyer's `azmBalance` increment in `completeTrade`
when `trade.type === 'BUY'`. Optionally, also fix the polarity of the
initiate-time decrement so that a BUY ad transfers actual crypto value
from the user to the vendor.

**Diff size:** ~30 lines across `services/p2p.service.js` and
`controllers/tradeController.js`. No schema migration. No FE change.

**Pros:**
- Tightest possible fix for the real money-correctness bug.
- Zero migration risk. Zero user impact for current AZM holders.
- Can ship in days.

**Cons:**
- Leaves the AZM/USDC dual-currency confusion unresolved. SELL ads
  still settle to AZM, BUY ads still leave settlement on USDC. The
  user-facing experience of "why do I have 200 AZM I can't spend on
  savings" stays.
- Doesn't address the audit's "stranded liquidity" framing in §1.4.
- `walletController.processWithdrawal` (the AZM withdraw rail) and
  `withdrawalController.fiatWithdrawal` (the V2 USDC withdraw rail)
  remain two separate code paths the user has to know which to call.

**When to choose A:** if BUY ads are not yet live in production
(verify via `prisma.ad.count({ where: { type: 'BUY', status: 'ACTIVE' } })`).
The bug is then a "before-it-ships" fix and we don't need a full
ledger rewrite.

### Option B — Mirror the SELL-ad escrow model on BUY ads

**Change:** Introduce a new `User.azmEscrowBalance Float @default(0.0)`
column. On BUY-ad `initiate`, move `userAzmAmount` from `azmBalance`
into `azmEscrowBalance`. On `completeTrade` BUY branch, decrement
`azmEscrowBalance` and credit the vendor's `availableBalance` (the
USDC, post-margin-cut). Remove the spurious `azmBalance` increment.

Same auto-cancel / dispute / admin-reject paths now refund from
`azmEscrowBalance` back to `azmBalance` instead of in-place re-credit.

**Diff size:** ~150 lines across `tradeController.js`,
`p2p.service.js` (completeTrade + dispute branches), `tradeWorker.js`,
`adminController.js` (force-cancel + admin-reject), `prisma/schema.prisma`,
plus a migration adding the column. Plus `transactionHistory.create`
calls for every new movement.

**Pros:**
- Cleanly mirrors the SELL-ad escrow pattern. The codebase becomes
  symmetric and easier to reason about.
- BUY-ad initiate is safe under retry — the lock is conditional on
  `azmBalance: { gte: userAzmAmount }` (the same `updateMany`
  pattern Phase A introduced for `availableBalance`).
- Auto-cancel rollback via `tradeWorker` is a single column move,
  not a re-create.

**Cons:**
- New schema column adds surface area for future bugs (anyone
  forgetting it in a select/balance-sum query gets wrong totals).
- Doesn't resolve the AZM-as-settlement-bucket awkwardness in §1.4 —
  AZM is still stranded liquidity for V2 features (savings, peer
  transfer).
- Migration is non-trivial: needs a one-time backfill if any in-flight
  BUY-ad trade is mid-execution at deploy time. Likely fine if BUY
  ads are not live yet, but needs verification.

**When to choose B:** if BUY ads ARE live, OR if the audit's "AZM
is a one-way trap" criticism is acceptable to leave standing
(because A doesn't fix it either).

### Option C — Eliminate `azmBalance`; settle everything in `availableBalance` (USDC)

**Change:** Both ad types settle to/from `availableBalance` (USDC).
The user's hologram GHS display continues to be derived as
`availableBalance × yellowCardRate` (post-Phase-J), no persistent GHS
bucket. AZM-denominated trades become a UX label only — the underlying
ledger move is in USDC.

`completeTrade` SELL branch: buyer's `availableBalance` increments by
`amountCrypto − totalMarginUsdc` (the net USDC principal). No
`azmBalance` increment.

`completeTrade` BUY branch: vendor's `availableBalance` increments by
the same net USDC; user's `availableBalance` was decremented at
initiate (USDC, not AZM) and locked into `escrowLockedBalance` (the
SAME bucket SELL ads use, just on the other side of the trade row).

`walletController.processWithdrawal` and
`withdrawalController.fiatWithdrawal` collapse into a single rail:
the V2 USDC withdrawal already wired up by Phase A.

`peerTransferController`, `savingsController`, `chat/transfer`,
`adController` continue to read `availableBalance` — and now any
former-AZM holdings are spendable for those features.

**Diff size:** ~400 lines + schema migration. AZM becomes a label,
not a column.

**Migration plan:** for every existing user with `azmBalance > 0`, run a
one-time conversion at the live `liveUsdToGhs` rate:
```sql
UPDATE "User"
   SET "availableBalance" = "availableBalance" + ("azmBalance" / [liveRate])
 WHERE "azmBalance" > 0;
```
Then drop the `azmBalance` column. Write a `TransactionHistory`
row per migrated user (`type = 'INTERNAL_TRANSFER',
amountUsdc = converted, txHash = 'AZM_MIGRATION_<userId>'`) for
audit completeness.

**Pros:**
- Single ledger column. Single withdrawal rail. Zero stranded liquidity.
- The "1 AZM = 1 GHS" mental model is fine as a UI-side label
  (e.g. on the profile screen) without needing a backing column.
- Removes the entire BUY-ad bug surface — there's only one path.
- Aligns with V2 master-soul §2 ("the V2 ledger split"), which already
  declared `lockedBalance` and `ghsBalance` dead. AZM removal is the
  natural next step in that cleanup.

**Cons:**
- Largest diff. Highest regression risk.
- Migration is destructive — existing AZM balances change column.
  Reversibility requires a snapshot before the cut-over.
- Frontend needs a coordinated update: the hologram "AZM" tile (read
  via `azmBalanceProvider` in `lib/providers/hologram_provider.dart`)
  becomes derived (`availableBalance × rate`) rather than a separate
  column. Same shape as Phase J's `ghsBalanceProvider` removal.
- The "AZAMAN TOKEN" branding in the schema comment becomes a UX
  fiction. If product wants AZM to be a real distinct asset class
  (e.g. governance token, staking token, future loyalty currency),
  Option C burns that bridge.

**When to choose C:** if the strategic decision is that AZM is purely
a settlement convenience (per the §1.4 evidence — there's no AZM
swap, no AZM peer transfer, no AZM-denominated lending), and the
"AZAMAN TOKEN" branding is happy to live in the UI without a
column behind it.

---

## 4. Recommendation

Tiered. The right answer depends on the BUY-ad production status:

### 4.1 Step 1 (urgent, ship this week): Option A

Confirm whether any BUY ads are active in production:

```sql
SELECT COUNT(*) FROM "Ad" WHERE type = 'BUY' AND status = 'ACTIVE';
```

If > 0, the BUY-ad bug is already losing the platform money. Ship
**Option A** as a hotfix:
- Skip the `azmBalance` increment in `completeTrade` for BUY ads.
- Verify the `userAzmAmount` debit on initiate is the right magnitude
  (it should match what the vendor pays externally minus margin).
- Add `transactionHistory.create` for both halves so `runDoubleCheck`
  doesn't roll back later.

If = 0, no rush. Skip A and go straight to B or C.

### 4.2 Step 2 (next): Option C, not Option B

Option B introduces a new column and keeps the dual-currency model.
It's a stepping stone with no clear destination. Option C eliminates
the AZM bucket entirely and aligns with the V2 ledger-split direction
already declared in `AZAMAN_MASTER_SOUL.md §2` and shipped through
Phase J (drop `lockedBalance` + `ghsBalance`).

Option C as a single-PR migration:

1. **PR D-2a (schema):** add a `transactionHistory.type =
   'AZM_MIGRATION'` enum value and an `idempotency_index` on
   `txHash` if not already present (it is, per the V2 schema).
2. **PR D-2b (BE migration script):** one-time script that runs in
   a `prisma.$transaction`:
   - For every user with `azmBalance > 0`: convert at live rate,
     increment `availableBalance`, write a TransactionHistory row.
   - Validate via `runDoubleCheck` per user.
   - Set every user's `azmBalance` to 0.0 (don't drop the column yet).
3. **PR D-2c (BE refactor):** rewrite all the AZM read/write sites
   listed in §1.2 to use `availableBalance`. Decouple
   `walletController.processWithdrawal` from `azmBalance` —
   either delete the controller entirely (V2 USDC withdrawal at
   `controllers/withdrawalController.fiatWithdrawal` already covers
   the use case) or refactor it to read `availableBalance`. Update
   `tradeController.initiateTrade` BUY branch to debit
   `availableBalance` and lock into `escrowLockedBalance`. Update
   `p2p.service.completeTrade` to credit USDC (post-margin) instead
   of AZM. Update `tradeWorker.js` rollback path. Update
   `adminController` force-cancel + admin-reject. Update every
   profile / select / balance-emit site.
4. **PR D-2d (FE coordinated):** drop `azmBalanceProvider` from
   `lib/providers/hologram_provider.dart` (it can be derived as
   `availableBalance × oracleRate` — same pattern as Phase J's
   `ghsBalanceProvider` removal). The "AZM" UI label can survive
   as a derived/computed display value. Profile screen, hologram
   card, vendor dashboard all stop reading the now-dead column.
5. **PR D-2e (BE schema cleanup):** drop the `azmBalance` column
   via migration, similar to Phase J's `lockedBalance` /
   `ghsBalance` drop.

Total surface area: similar to Phase J × 4. ~1500-2000 LOC across
~25 files. Should be sequenced post-Phase-K (auth hardening) so the
auth-critical paths aren't moving while the ledger is being rewritten.

### 4.3 What "Option B as stepping stone" would actually cost

Option B is tempting because it's "a smaller diff than C." But:

- B still has to touch `tradeController`, `p2p.service`,
  `tradeWorker`, `adminController`, plus add a new column. ~150 LOC.
- C touches the same files, plus a few more. ~400 LOC. The marginal
  cost is the migration script and the FE coordination — both of
  which we'd have to write anyway when we finally consolidate later.
- B hands us a system with **two** AZM columns (`azmBalance` +
  `azmEscrowBalance`) and the same long-tail of "stranded liquidity"
  the audit complained about.

Skip B. The diff savings aren't worth the architectural debt.

---

## 5. Out of scope (NOT in this PR)

This document is design-only. **Zero code change.** It establishes the
shared understanding necessary for the implementation PR(s) to be
opened with confidence.

After review and approval of the recommendation, the implementation
work is filed as **Phase D-2** (with sub-PRs D-2a..D-2e per §4.2).

If the team chooses Option A instead, **Phase D-1** is a single
~30-LOC hotfix PR.

If the team chooses Option B, **Phase D-1.5** is a single ~150-LOC
PR plus FE coordination.

---

## 6. Open questions for the design review

1. **Are BUY ads live in production?** Run the SQL in §4.1. The
   answer determines whether this is a hotfix-this-week situation or
   a planned-quarter situation.
2. **Is `walletController.processWithdrawal` actively used?** If yes,
   Option C needs a deprecation period for the AZM-direct withdraw
   path. If no (and `withdrawalController.fiatWithdrawal` is the only
   reachable rail), Option C can collapse the two cleanly.
3. **Does product want AZM to remain a distinct asset class long-term?**
   If yes, lean toward Option B and accept the stranded-liquidity
   concern as a UX problem to solve separately. If no, Option C is
   the right fix.
4. **What's the policy on existing user balances?** Option C migrates
   them at the live rate at cut-over. Is that fair? An alternative is
   to migrate at the rate observed at the time each AZM was credited
   (would require walking `transactionHistory`, adds complexity).
5. **Frontend coordination window.** Phase J shipped a coordinated
   BE+FE pair-PR pattern. Phase D-2 (Option C) would follow the same.
   Phase D-1 (Option A hotfix) and D-1.5 (Option B) are BE-only.

---

## Appendix A — Why I'm doc-only on this PR

The audit explicitly required a design pass before code:

> Phase D | NEXT | BE | AZM trap + BUY-ad ledger redesign | …
> Needs a **design pass** mapping the full P2P ledger flow before
> code change.

The "burn the ocean" instruction from the user-facing chat was
acknowledged elsewhere in this session by shipping every other phase
end-to-end (J, L, M). Phase D is a deliberate exception. A 1500-line
ledger rewrite without sign-off from product on the AZM-as-token
question (open question #3 above) would be premature. This document
puts the decision in front of the right people with all the cost
information needed to make it.

The implementation PR follows once the recommendation is signed off.
