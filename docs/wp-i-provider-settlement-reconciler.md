# WP-I — provider settlement reconciler (operator runbook)

Treasury funding becomes `AVAILABLE` only against a **provider settlement witness**
that was fetched independently, by a component the application can neither
instruct nor impersonate. This document is the operator surface for that
component.

## Why it is a separate process

A second credential *inside* the API process would be theatre: a compromised API
process reads it from memory. What limits the blast radius is a separate
component with:

- its own provider credential (`AZM_RECONCILER_PROVIDER_USER + AZM_RECONCILER_PROVIDER_PUBKEY`),
- its own database login (`WITNESS_DATABASE_URL`) that can **append** a witness
  and nothing else,
- its own egress identity, so provider-side allowlists can name it.

The witness table therefore has one writer, and that writer is not the process
that takes user requests.

## Required environment

| Variable | Meaning |
| --- | --- |
| `AZM_RECONCILER_MODE` | Enables the writer guard. Anything non-empty. |
| `AZM_RECONCILER_PROVIDER_USER + AZM_RECONCILER_PROVIDER_PUBKEY` | Provider API credential (`X-API-KEY`). |
| `WITNESS_DATABASE_URL` | Reconciler DB login — INSERT on `ProviderSettlementWitness` only. |
| `WITNESS_ACCOUNT_CURRENCY_MAP` | Authoritative account → currency JSON, e.g. `{"1000000001":"GHS"}`. |

The runner refuses to start if **any** of these is missing: partial authority is
treated as no authority.

## Invocation

```bash
node workers/run-provider-settlement-reconciler.js <openingDedupKey> [more...]
```

It prints machine-readable per-opening results, for example:

```json
{
  "results": [
    { "openingDedupKey": "TREASURY-OPENING-A", "witnessed": true, "witnessId": "…", "netPesewas": "9900" }
  ]
}
```

Exit codes: `0` processed (witnessed or truthfully refused), `1` usage or missing
credential, `2` fatal error.

`netPesewas` is emitted as a decimal **string** — exact money is a BigInt and must
never pass through a float.

## Scheduling

Nothing schedules this automatically, and that is deliberate: activation is an
explicit decision. When you are ready, the two supported shapes are:

1. **Render cron job** bound to this service (separate service, same repo,
   start command `node workers/run-provider-settlement-reconciler.js …`), with
   the four variables above in its own environment.
2. A scheduled platform job on the reconciler host, one invocation per batch of
   opening keys produced by the operations queue.

Do not add it to `server.js`. Booting it inside the API would collapse the very
separation it exists to provide.

## What it refuses, and why

| Refusal | Meaning |
| --- | --- |
| missing credential | Never guesses at authority. |
| `unknown opening` | It will not query a reference it was merely handed. The opening must pre-exist. |
| `no provider reference` | An opening with no provider reference cannot be witnessed. |
| `provider status N` | Only a 200 with a parseable body may witness. |
| `WITNESS_PROVIDER_STATE_NOT_SETTLED` | Pending or failed provider state is never evidence. |
| `WITNESS_MISMATCH` | Provider net ≠ opening amount, or the fetch predates the opening, or the digest does not verify. |
| `WITNESS_OBSERVATION_ALREADY_USED` | One provider settlement already vouches for another opening. |
| `WITNESS_ACCOUNT_UNMAPPED` | Currency cannot be established. It is never inferred. |

## Single-use binding

`ProviderSettlementWitness.openingDedupKey` is unique — one witness per opening.
`observationKey` is unique too: it identifies the **observation**
(`provider|fundingType|endpoint|observed reference`, where the reference falls
back through `requestParams.id`, `requestParams.reference`, the provider-reported
`externalref`/`reference`/`transactionid`, and finally the response digest). So
the same payment cannot fund opening A and then opening B, and the guard holds
under concurrency because the database enforces it.

## What this does NOT protect against

- A compromised reconciler host with valid provider credentials and a valid DB
  login can still write a witness for a payment that exists at the provider. The
  digest, endpoint and fetch timestamp bind the witness to a specific response;
  they do not make a lying host honest.
- Host compromise is therefore a **detection** problem: witness rows carry the
  exact bytes, the endpoint and the fetch time, so an audit can re-fetch and
  compare.
- Treasury activation remains a separate, explicit decision.

## Verification

```bash
TEST_DATABASE_URL=… npx jest --runInBand __tests__/wp-i-provider-settlement-reconciler.test.js
```

Eight cases cover credential refusal, no-lookup refusals, the positive control,
gross-vs-net, non-final state, provider HTTP failure and single-use binding. The
suite is registered in `.github/workflows/financial-durability.yml`.

---

## Evidence update — 2026-11-15 (Agent 4)

### Provider contract correction (documented shape)

The reconciler previously sent `X-API-KEY` (private) and omitted `accountnumber`, and the
witness service read `state` / `txstatus_label`. Neither matches the official
[Payment Status API](https://docs.moolre.com/ai/live/payment-status.html):

| Item | Documented | Now implemented |
|---|---|---|
| Method/URL | `POST https://api.moolre.com/open/transact/status` | same |
| Headers | `X-API-USER`, `X-API-PUBKEY` | same |
| Body | `type:1`, `idtype:1`, `id`, `accountnumber` | same |
| Transaction status | `data.txstatus` (1 success, 0 pending, 2 failed) | mapped, unknown → UNKNOWN |
| Amounts | `data.amount` gross, `data.value` net after fees | net credited, gross retained |

`src/services/providers/moolreStatusAdapter.js` distinguishes transport success (HTTP 200 and
wrapper `status === 1`) from transaction settlement (`data.txstatus`). A 200 with a successful
wrapper and a pending/failed/missing `txstatus` is **not settled**. The undocumented
`state`/`txstatus_label` shape is still parsed but labelled `moolre-status-legacy-observed-v0`,
and the witness records which rule produced it in `ProviderSettlementWitness.adapterRule`.

### Evidence classes

- **Confirmed by official documentation:** endpoint, headers, request body, `txstatus` values,
  `amount` vs `value`, `externalref`, `accountnumber`, `transactionid`, `ts`.
- **Inferred from code:** that the treasury opening stores its funding reference in
  `FiatLiquidityReceipt.providerRef`; that one reconciler serves one wallet.
- **Tested locally (disposable PostgreSQL, no live Moolre call):** adapter parsing of documented,
  pending, failed, wrapper-failed, missing-`txstatus`, non-JSON and legacy fixtures; witness
  binding, installer grants, promotion race.
- **Awaiting live wallet verification:** that the production wallet's status responses match the
  documented shape, and the authoritative net credited value per pricing band.

### Deployment prerequisites (names only)

Reconciler process: `AZM_RECONCILER_MODE=1`, `AZM_RECONCILER_PROVIDER_USER`,
`AZM_RECONCILER_PROVIDER_PUBKEY`, `AZM_RECONCILER_ACCOUNT_NUMBER` (or `--wallet`),
`WITNESS_DATABASE_URL`, `WITNESS_ACCOUNT_CURRENCY_MAP`, optional `AZM_RECONCILER_TIMEOUT_MS`.
Installer: `AZM_WITNESS_RUNTIME_ROLE`, `AZM_WITNESS_RECONCILER_ROLE`.

The reconciler must run as its own service and must never be started by the API deployment.
