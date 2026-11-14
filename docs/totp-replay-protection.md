# Global TOTP replay protection (§WP-F)

One user, one accepted matched TOTP time-step, one successful use, across every
backend path that verifies the customer's authenticator secret.

## Why one shared authority

WP-D put durable replay claims in PostgreSQL for the app-unlock screen only. The
same authenticator secret was verified by six other routes with no claim at all,
so an in-window code could be spent once per feature: unlock the app, empty a
wallet, disable 2FA. A second claim table would have reproduced that hole, so
WP-F keeps ONE table and ONE service.

```
src/services/totpStepClaimService.js
  verifyAndClaimTotp({ prisma, userId, secret, token, window = 1 })
    → { ok: true, step }              matched step claimed exactly once
    → { ok: false, code: 'TOTP_INVALID' }
    → { ok: false, code: 'TOTP_REPLAYED', step }
    → throws TotpClaimStoreUnavailableError (503, code TOTP_CLAIM_STORE_UNAVAILABLE)
```

The claim is the INSERT. `UNIQUE(userId, step)` makes "exactly one winner" the
database's decision, not a read-then-write race. Nothing is partitioned by
route, controller, endpoint or action.

## Storage

`prisma.totpStepClaim` is the neutral model name; `@@map("AppUnlockTotpClaim")`
keeps the physical table WP-D shipped, so existing claim rows are preserved and
no data migration is involved. The constraint and index names are pinned with
`map:` for the same reason. Only `userId`, `step` and `createdAt` are stored —
never the code, its digest, or the secret.

## Matched step, not the clock step

`totp.verifyDelta` reports which of the honoured steps matched. The claim stores
`currentStep(now) + delta`, so a previous-window code consumes the previous
step, not today's. Claiming the clock step would let an attacker replay the same
code one window later. `window: 1` is unchanged from the previous behaviour.

Verified Speakeasy 2.0.0 semantics: `_counter(options)` computes
`floor((time ?? Date.now()) / 1000 / step)` and `totp.verifyDelta` widens the
window symmetrically (`counter -= window`, `delta -= window`). Its `time` option
is in SECONDS despite being multiplied by 1000 internally — passing milliseconds
silently produces a far-future step.

## Covered call graph

| Route family | Before | After |
|---|---|---|
| `middleware/require2FA.js` (step-up on money routes) | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `controllers/savedMomoController.js` create | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `controllers/securityController.js` enable 2FA | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `controllers/securityController.js` disable 2FA | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `controllers/walletController.js` payout address | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `routes/adminRoutes.js` `/2fa/verify` | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `routes/adminRoutes.js` `/2fa/disable` | `totp.verify`, no claim | `verifyAndClaimTotp` |
| `services/appUnlockService.js` TOTP unlock | private claim helper | `verifyAndClaimTotp` |

`grep -rn "totp.verify"` over `src/ services/ controllers/ middleware/ routes/`
returns nothing: the boolean API is gone from every verification path.

## Failure behaviour

- Store unreachable, table missing, or any unexpected write error → typed 503
  (`TOTP_CLAIM_STORE_UNAVAILABLE` / `APP_UNLOCK_STATE_UNAVAILABLE`). A database
  error is never treated as a successful verification.
- Replay → 409 `TOTP_REPLAYED`, with a message telling the user to wait for a
  fresh code.
- Invalid code → each route's original status and body are unchanged.
- An accepted code consumes its step even if the business action then fails. That
  is deliberate: the alternative is leaving a spent code valid for other routes.
- No process-local Map and no Redis fallback exists for replay authority.

## Route ordering (unchanged)

`protect → require2FA → idempotency → handler`. A replayed code is rejected
inside `require2FA`, before any idempotency claim is created, so a refused
request leaves no financial-operation claim behind.

## Production packaging

The table is created by `infra/install-app-unlock-totp-claim.js`, which runs in
`npm run release` and in CI before the app starts and before the first test. It
is idempotent, never deletes claims, and exits non-zero if the installed shape
does not match the model. `__tests__/app-unlock-claim-installer-wiring.test.js`
proves the wiring, parity with migration `20261110200000_app_unlock_totp_claim`,
and that the WP-E authority installer stays out of the application chain.

## Out of scope here

The SMS OTP path (`smsService`) keeps its own store; PIN attempt counters are
Redis-backed and unchanged; step-up tokens (B5) and the Flutter step-up UX are
separate packages. `middleware/require2FA.js` still has no *password*-attempt
lockout, which was never its job.
