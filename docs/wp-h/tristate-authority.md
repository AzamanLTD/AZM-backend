# WP-H — database-enforced tri-state authority

## The defect this replaces

`isAuthorityModeActive()` answered a **Boolean** built from two writable places:
`GlobalSettings.fiatLiquidityAuthorityEnabled` and the nullable
`FiatLiquidityState.authorityActivatedAt` column, which the runtime role owns and can
`UPDATE`. A Boolean cannot say *"the invariant could not be proved"*, so every failure had to
be squeezed into `false` — and `false` means **legacy USDC** to every caller. An inspection
failure therefore relabelled GHS-backed liabilities as USDC. The previously prepared patch
(`docs/wp-h/authority-live-decision.patch`) preserved that collapse and is **not** applied.

## Three states, one meaning each

| State | Meaning | Unit | `active` |
|---|---|---|---|
| `ENFORCED_INACTIVE` | Protected table present, ownership and privileges as designed, immutability triggers enabled, **no** activation record, and the legacy latch does not claim otherwise | `USDC` | `false` |
| `ENFORCED_ACTIVE` | The same positive verification **plus** one valid, immutable activation record | `GHS` | `true` |
| `UNKNOWN` | Anything else | `null` | `null` |

`UNKNOWN` is not a flavour of `false`. It carries **no** unit, no balance and no rate, so no
caller can read a currency out of a refusal. The only legal reaction is the typed failure
`AUTHORITY_STATE_UNAVAILABLE` (`statusCode: 503`).

Implementation: `src/services/authorityState.js` (`resolveAuthorityState`,
`requireAuthorityState`, `AuthorityStateUnavailable`).

### What is `UNKNOWN` (mandatory)

Table missing or unreadable · unexpected schema or owner · owner login-capable · runtime holds
write/ownership/DDL/trigger privileges · runtime can become owner · unexpected memberships ·
trigger absent, disabled or altered · operator wider than intended · record malformed
(non-singleton id, non-timestamp `activatedAt`, blank evidence, non-SHA-256 digest) ·
inspection throws or returns incomplete data · legacy latch says "activated" while the
protected table holds no record.

The **inactive** state is *proved*, never assumed: it requires the same inspection evidence as
the active state. A missing table is `UNKNOWN`, never "inactive".

## Advisory-lock protocol (release-critical)

One identity for the regime lock: `AUTHORITY_LOCK_KEY = 'azm.p5d.authority.activation'`,
identical to the activation sequence's `ACTIVATION_LOCK_KEY` (asserted equal in the suite, and
`lockRegime()` throws on drift).

- **Economic path**: `lockAuthorityShared(tx)` → `pg_advisory_xact_lock_shared(hashtext(key))`
  **first**, then read the state **with the same transaction client**, hold through the
  consequential write and `COMMIT`. Wrapper: `withAuthoritySnapshot(tx, fn)`.
- **Activation path**: `pg_advisory_xact_lock(hashtext(key))` **exclusive** before inserting,
  held through commit (`lockRegime`).
- The **no-record case is covered by the advisory lock**, not by a row lock — there is no row
  to lock, which is precisely the race the review identified.
- Transaction-scoped, so PostgreSQL releases them on COMMIT/ROLLBACK. No process-local cache:
  every decision re-reads inside its own transaction.

External provider I/O must not be held inside the locking transaction: quote outside, then
revalidate state and commit inside the transaction that performs the economic write.

## Deployment prerequisites (not provisioned by this branch)

1. DBA bootstrap, run once with an administrative connection:
   `node infra/install-authority-activation-roles.js --owner <nologin-owner> --runtime <runtime> --operator <operator>`.
2. Four distinct identities: **migrator** (DDL), **owner** (NOLOGIN, owns the table and the
   trigger function), **runtime** (SELECT only on the protected table), **operator**
   (SELECT + INSERT only).
3. The ordinary release chain must **not** grant itself ownership or `CREATEROLE`. It does not
   today.
4. Render currently supplies a single `DATABASE_URL` used by `preDeployCommand` and
   `npm start`, so in that arrangement one role is migrator + runtime + table owner and the gate
   stays **closed**. That is an infrastructure change, deliberately not made here.

Operational consequence of an unavailable state: money paths refuse with
`AUTHORITY_STATE_UNAVAILABLE`; nothing is booked, nothing is relabelled. Diagnosis: the
refusal's `.problems` and `.diagnostics` carry the inspection evidence server-side;
`.reason` names the class (`TABLE_MISSING`, `ENFORCEMENT_NOT_ESTABLISHED`,
`ACTIVATION_MALFORMED`, `LEGACY_CONTRADICTS_INACTIVE`, `ACTIVATION_UNREADABLE`,
`LEGACY_UNREADABLE`, `INSPECTION_FAILED`).

## Rollout switch

`AUTHORITY_ENFORCEMENT_MODE=tri_state` makes `readMode`, `isAuthorityModeActive` (and therefore
every consumer) resolve through the tri-state boundary and refuse on `UNKNOWN`. The default is
`legacy` so that an unprovisioned database does not start refusing every money path the moment
this branch is deployed. **Flipping it is the activation gate**: it must only be set after the
bootstrap in step 1 has been verified on that database.

## Status

Implemented and proven here: the tri-state resolver, the typed failure, the shared/exclusive
advisory protocol, the activation-side lock identity check, and a real-role suite.

Not yet done in this branch (tracked in the PR): consumer-by-consumer wiring (parking vs
refusal) for workers, payout execution, liquidation, reversal, reconciliation and treasury;
and the conversion of the 63 historically failing fixtures to provisioned roles. Those are
blocked on the role bootstrap existing in CI, which is why the suite provisions its own
disposable database and roles.

## Caller inventory (generated from this tree)

| File | matches |
|---|---|
| `controllers/adminController.js` | 3 |
| `controllers/adminProfitBreakdownController.js` | 1 |
| `controllers/finance.controller.js` | 1 |
| `services/finance.service.js` | 4 |
| `src/services/authorityActivationEnforcement.js` | 1 |
| `src/services/authorityState.js` | 1 |
| `src/services/fiatLiquidityActivationService.js` | 10 |
| `src/services/fiatLiquidityService.js` | 1 |
| `workers/payoutBatchWorker.js` | 1 |

## The five-role boundary (as installed)

| Role | Login | Purpose | Holds |
|---|---|---|---|
| table owner | `NOLOGIN` | owns `FiatLiquidityAuthorityActivation` and the immutability trigger function | all on its own objects |
| function owner | `NOLOGIN` | owns the `SECURITY DEFINER` activation function | exactly the column privileges the body needs |
| runtime | `LOGIN` | the application connection | `SELECT` on the protected record, nothing else |
| operator | `LOGIN` | the sanctioned activation caller | `EXECUTE` on the activation function, **no** direct DML on the record |
| migrator | `LOGIN` | schema provisioning | DDL only, never runtime |

The table/trigger owner and the activation-function owner are **distinct trusted roles**. If one
role holds both, a compromise of the definer body is a compromise of the record's owner.

## One resolver, one answer

`infra/lib/authority-roles.js` is the only place a role identity is decided. Precedence, highest
first: **explicit option → environment (`AUTHORITY_OWNER_ROLE`, `AUTHORITY_RUNTIME_ROLE`,
`AUTHORITY_OPERATOR_ROLE`, `AUTHORITY_FN_OWNER_ROLE`) → canonical default**, with the function
owner DERIVED from the resolved owner (`<owner>_fn`) rather than defaulted separately. Every
entry point uses it: both installers, every programmatic call, and the CLIs. Colliding identities
are refused before any DDL.

## Restore is not provisioning

A bare overlay run (the `npm run release` chain, a CI schema restore) names no roles and
therefore returns `SKIPPED_NOT_PROVISIONED` with `provisioned: false` **before** creating or
altering any role, function, grant or ownership. This is deliberate: a restore that silently
provisioned an authority boundary would make a schema pipeline the owner of a security decision.
It also means the release chain no longer provisions the authority roles, so production must run
the explicit command below.

## DBA provisioning command

```
node infra/install-authority-activation-roles.js \
  --owner azm_authority_owner \
  --runtime azm_app_runtime \
  --operator azm_authority_operator \
  --function-owner azm_authority_fn_owner
```

Every role must be named explicitly. A named install fails non-zero on any missing prerequisite,
role collision, mismatched identity, absent grant, unsafe role attribute or unexpected ownership.
It never reassigns an unexplained object, and it refuses to create or replace the activation
function under a role that failed its ownership audit (any pre-existing copy has `EXECUTE`
revoked from PUBLIC and the operator).

## Release / runtime connection split

`render.yaml` currently runs the release chain and the application with the **same** single
`DATABASE_URL`, so in production one role is migration authority *and* runtime *and* table owner.
Until that is split (`MIGRATION_DATABASE_URL` for release, a `SELECT`/DML-only runtime role, and
the operator credential held outside Render), the runtime attestation cannot pass in production
and the gate must stay closed. Do not enable `AUTHORITY_ENFORCEMENT_MODE` before the split.
