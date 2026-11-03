# Moolre Ghana bank payout — provider contract (Azaman adapter)

**Status:** provider adapter only. Not wired into `server.js`, no route, no
controller, no ledger, no beneficiary storage, no reconciliation ownership.
**Evidence state:** fixture-tested. No sandbox call has been made with Azaman
credentials and no live payout has ever been attempted.

Retrieved **2026-11-03** from `docs.moolre.com`.

## 1. Endpoints used

| Purpose | Method + path | Auth |
| --- | --- | --- |
| Bank directory | `GET /open/transact/data?country=gha&data=banks` | none documented |
| Account name | `POST /open/transact/validate` | `X-API-USER`, `X-API-KEY` (public or private) |
| Transfer | `POST /open/transact/transfer` | `X-API-USER`, `X-API-KEY` (private key) |
| Transfer status | `POST /open/transact/status` | `X-API-USER`, `X-API-KEY` (public or private) |

Base hosts: `https://sandbox.moolre.com` (default) and `https://api.moolre.com`.
Both are allowlisted; anything else disables the capability.

### 1.1 The unresolved path conflict

The machine-readable per-endpoint references (four pages, mutually consistent)
document `/open/transact/transfer` and `/open/transact/validate`.

The workflow guide at `docs.moolre.com/guides/transfers/` documents
`/open/transact/initiate` and `/open/transact/validate-name`. That page returned
no readable body on retrieval, so the conflict is **unresolved**, not disproved.

This adapter implements only the machine-readable paths and never tries a second
path: submitting one payout to two endpoints would be a double payout. The paths
are three constants in `PATHS`. Closing this requires either a non-production
sandbox call with Azaman sandbox credentials or written confirmation from Moolre.

## 2. Requests

```json
// transfer (channel "2" = Instant Bank Transfer)
{
  "type": 1, "channel": "2", "currency": "GHS",
  "amount": "25.50",
  "receiver": "<recipient bank account>",
  "sublistid": "<bank code from the directory>",
  "externalref": "<Azaman referenceId, verbatim>",
  "accountnumber": "<configured Moolre source account>",
  "reference": "<optional narration, <=100 chars>"
}
```

```json
// status: idtype 1 = our external reference
{ "type": 1, "idtype": 1, "id": "<referenceId>", "accountnumber": "<source account>" }
```

Validation uses the same field set as the transfer with `subblockid` replaced by
`sublistid` = bank code and no amount; the provider returns the account-holder
name as a **string in `data`**.

## 3. Response facts the adapter preserves

From the transfer envelope `data`: `txstatus`, `transactionid`,
`thirdpartyref`, `externalref`, `amount`, `amountfee`, `networkfee`, `fee`.

- Fees are kept as three separate exact strings. They are never summed, and the
  adapter never decides who pays them.
- `amountGhsExact` is the **provider-reported** amount, `null` when absent. The
  caller's amount is never substituted, because the echoed amount is
  independent settlement evidence.
- `externalId` is Moolre's echoed `externalref`. If it disagrees with our
  `referenceId` the result is `UNRESOLVED` with
  `reason: EXTERNAL_REFERENCE_MISMATCH` — a contradiction, never a silent swap.
- `providerRef` is `transactionid`, else `thirdpartyref`, else `null`.

Status mapping of `data.txstatus`: `0` → `PENDING`, `1` → `SUCCESSFUL`,
`2` → `FAILED`, anything else (including missing) → `UNRESOLVED`. A missing
status is never reported as pending.

The outer envelope `status` is **not** proof of settlement. Agent A's
reconciliation authority decides terminality.

## 4. Error contract

```js
{ provider: 'MOOLRE_DISBURSEMENT', outcome, providerOutcome, code, stage,
  referenceId, retryable: false, dispatchProven }
```

`dispatchProven` is true only for outcomes proven not to have dispatched:
`NOT_DISPATCHED`, or a `DEFINITIVE_REJECTION` backed by published evidence.

| Outcome | Meaning | Thrown? |
| --- | --- | --- |
| `NOT_DISPATCHED` | local validation/config error, or `ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN` | thrown |
| `DEFINITIVE_REJECTION` | documented provider refusal, no payout | thrown |
| `PROVIDER_UNAVAILABLE` | config/auth/directory problem, no dispatch outcome | thrown |
| `UNKNOWN_OUTCOME` | timeout, reset, 5xx, unknown 4xx, malformed 2xx | **returned** as `status:'UNRESOLVED'` |
| `DUPLICATE_REFERENCE` | Moolre already holds this `externalref` | **returned** as `UNRESOLVED`, `reason:'DUPLICATE_REFERENCE'` |

Ambiguity is returned rather than thrown on purpose: the settled consumer
reverses on a thrown error, so throwing on an unknown outcome would refund money
that may already have left. `UNRESOLVED` means "query the original reference".

`retryable` is always `false`. A retry is a status lookup against the original
reference, never a second POST with a new reference.

## 5. Codes: what is verified and what is not

| Code | Status |
| --- | --- |
| `AVD01` | **documented success** for Validate Name. Never a refusal. |
| `AVD02` | **documented account-not-found** for Validate Name → `ACCOUNT_NOT_FOUND`. |
| transfer refusal codes | **none verified.** `DOCUMENTED_TRANSFER_REFUSALS` is empty, so every transfer-side refusal-shaped answer is `UNRESOLVED`. |
| status not-found code | **none verified.** `DOCUMENTED_STATUS_NOT_FOUND` is empty, so `NOT_FOUND` is never claimed yet. |
| duplicate reference | detected from the provider's duplicate message shape; used only to refuse a second send, never to assert success. |

An empty denial set is deliberate. A wrong `NOT_FOUND` would authorise a refund
of money that already moved; a wrong "refused" would authorise a second payout.

## 6. Configuration gate

One authority, `capabilities()`, read by every method:

```
providerIoEnabled      = MOOLRE_PROVIDER === 'LIVE'
bankPayoutEnabled      = MOOLRE_BANK_PAYOUT_ENABLED === 'true'   (default false)
credentialsPresent     = MOOLRE_API_USER && MOOLRE_API_KEY
sourceAccountConfigured= MOOLRE_ACCOUNT_NUMBER
hostAllowed            = https host in {sandbox.moolre.com, api.moolre.com}
canInitiateBankPayout  = all of the above
```

`MOOLRE_PROVIDER=LIVE` alone is **not** enough: a business that enabled MoMo
payouts has not thereby enabled bank payouts. With any condition false the
adapter performs no I/O, throws `NOT_DISPATCHED`, and `describe()` reports
`mode: 'disabled'`. There is no mock success path in any mode.

`describe()` returns the provider, capability, mode, host, the individual flags,
`channel: 2` and `currency: 'GHS'`. It never contains a credential or an account
number.

## 7. Safety bounds that are ours, not Moolre's

- Recipient account: 6–20 digits. Moolre publishes no format rule; this is an
  Azaman input bound and is labelled as such in the error text.
- Amount: exact decimal string, maximum 2 decimals, no sign/exponent/commas/
  leading zeroes, `> 0`, and ≤ GHS 1,000,000.00 per instruction
  (`MAX_GHS_PESEWA`). Moolre's own limits are unconfirmed.
- Directory cache: 6 h fresh, 24 h stale window, `forceRefresh` bypasses it.
  Validation and transfer refuse stale directory data outright.

## 8. Operational rules

- Timeouts: 15 s connect/response; response bodies bounded to 256 KiB.
- No axios retry middleware anywhere; `validateStatus` is ours so classification
  is explicit rather than transport-driven.
- Logs carry `referenceId`, stage and provider code only. Account numbers,
  source account, API keys and raw provider bodies never appear in logs,
  customer DTOs or `describe()`.

## 9. Still unproven (do not claim otherwise)

1. Whether Azaman's Moolre account has channel 2 bank payouts enabled.
2. Which endpoint family is live: `/transfer`+`/validate` or
   `/initiate`+`/validate-name`.
3. Bank coverage, per-transaction limits, fees and their payer, and settlement
   finality/SLA.
4. Duplicate-reference and refusal code semantics.
5. Any production behaviour at all.

## 10. Verification performed

```
npx jest __tests__/moolre-bank-payout-adapter.test.js      # 96 fixture tests
npx jest __tests__/r15g-moolre-status-contract.test.js \
         __tests__/r15b-moolre-collection-outcomes.test.js \
         __tests__/r16b-moolre-only-topology.test.js       # MoMo regressions unchanged
```

No sandbox transfer has been authorised, so none was attempted.
