# Moolre Ghana bank payout — verified provider contract (Azaman adapter)

Status: **provider adapter only, not wired into any route or financial service.**
Owner: Agent B. Consumer: Agent A through `MoolreBankPayoutPort`.
Verified against the machine-readable Moolre reference on **2026-11-03**.
Sandbox verification: **outstanding** (see *What is not verified*).

Module: `services/moolreBankPayoutService.js`
Tests: `__tests__/moolre-bank-payout-adapter.test.js` (fixture-based, HTTP faked at the adapter boundary).

## Endpoints

| Purpose | Method | Path | Auth headers | Body |
| --- | --- | --- | --- | --- |
| Bank directory | GET | `/open/transact/data?country=gha&data=banks` | none documented | — |
| Validate account name | POST | `/open/transact/validate` | `X-API-USER`, `X-API-KEY` (public **or** private) | `type=1`, `receiver`, `channel=2`, `sublistid`, `currency=GHS`, `accountnumber` |
| Initiate bank transfer | POST | `/open/transact/transfer` | `X-API-USER`, `X-API-KEY` (**private only**) | `type=1`, `channel=2`, `currency=GHS`, `amount` (string), `receiver`, `sublistid`, `externalref`, `accountnumber`, optional `reference` |
| Transfer status | POST | `/open/transact/status` | `X-API-USER`, `X-API-KEY` (public **or** private) | `type=1`, `idtype=1`, `id` (externalref), `accountnumber` |

Sources: `docs.moolre.com/ai/initiate-transfer.html`, `/ai/validate-name.html`,
`/ai/live/miscellaneous-data.html`, `/ai/transfer-status.html`.

## Documentation conflict and how it was resolved

Moolre's **transfer guide** (`docs.moolre.com/guides/transfers/`) describes
`POST /open/transact/initiate` and `POST /open/transact/validate-name`.

The **machine-readable per-endpoint reference** documents
`POST /open/transact/transfer` and `POST /open/transact/validate`, with a
consistent envelope (`{status, code, message, data}`), the same auth header pair
and the same field names across four independent pages.

Decision: the adapter implements the machine-readable reference. Evidence:

1. Four separate reference pages agree with each other on path, auth and body.
2. The guide page returned no content on fetch, so its paths could not be
   confirmed from the page itself.
3. The status and directory endpoints in the reference use `/open/transact/*`
   naming consistently with `/transfer` and `/validate`.

The adapter does **not** silently fall back to a second path. If sandbox testing
shows the guide's paths are the live ones, change `PATHS` in one place and
re-run the suite. **This remains an open question requiring written confirmation
from Moolre or a sandbox run; it is not claimed as resolved here.**

## Channels and bank codes

- `channel=2` is Instant Bank Transfer. Numeric channel values are required by
  Moolre; the adapter sends the string `"2"`.
- Bank codes come only from the directory endpoint. They are the `sublistid`
  value for validation and transfer. Codes are preserved as strings because
  leading zeroes are significant (`030100`).
- No bank list is hard-coded anywhere.

## Amount precision

`amountGhsExact` must be a decimal **string** with at most two decimal places
(pesewa). Rejected before any provider I/O: numbers (not strings), zero,
negatives, exponents, thousands separators, whitespace, more than two decimals,
and values above the adapter's documented ceiling. No `Number`/`parseFloat`
conversion is used for authoritative values.

## Fees

`amountfee`, `networkfee` and `fee` are returned as exact strings under
`fees`. The adapter does **not** decide which is the customer fee, does not
assume `amountfee` includes or excludes `networkfee`, and never sums them.

## Status mapping

Provider field: `data.txstatus`, numeric.

| `txstatus` | Adapter |
| --- | --- |
| `0` | `PENDING` |
| `1` | `SUCCESSFUL` |
| `2` | `FAILED` |
| absent/unrecognised | `UNRESOLVED` (status lookup) |

Status lookup result values: `PENDING`, `SUCCESSFUL`, `FAILED`, `NOT_FOUND`,
`UNRESOLVED`.

- `NOT_FOUND` is returned only for an authoritative provider not-found answer.
- Auth failures, rate limits, malformed bodies, 5xx and transport failures are
  `UNRESOLVED`. None of them is ever reported as `PENDING`, success or failure.
- A status lookup never sends a transfer.

## Provider outcome taxonomy

| Outcome | Meaning | Retried by adapter? |
| --- | --- | --- |
| `NOT_DISPATCHED` | Local validation/config refusal, or transport failure provably before send (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | no |
| `DEFINITIVE_REJECTION` | Provider explicitly refused; no payout dispatched (documented refusal codes only) | no |
| `UNKNOWN_OUTCOME` | Timeout/reset after send, 5xx, unknown 4xx, malformed body — may have been accepted | no |
| `DUPLICATE_REFERENCE` | Provider already holds this `externalref`; caller must look it up | no |
| `STATUS_UNRESOLVED` / `UNRESOLVED` | Status could not be established | n/a |
| `PROVIDER_UNAVAILABLE` | Config missing, directory outage, or transport failure with no payout relevance | n/a |

Initiating a transfer never enables a generic HTTP retry, never mints a new
`externalref`, and never fails over or refunds. `externalref` is the caller's
`referenceId`, used verbatim.

## Configuration

Reuses the existing conventions: `MOOLRE_API_USER`, `MOOLRE_API_KEY`,
`MOOLRE_ACCOUNT_NUMBER`, `MOOLRE_ENV`, `MOOLRE_BASE_URL`.

- Base URL defaults to `https://sandbox.moolre.com` and only becomes
  `https://api.moolre.com` when `MOOLRE_ENV=production`.
- Missing user/key/account number fails closed **before** any provider I/O.
- There is no MOCK success path in this module: it performs real provider calls
  or refuses. Tests inject a fake HTTP client; nothing in production code
  fabricates a payout.
- Timeouts are finite (20 s default, 15 s for the directory) and response size is
  bounded.

## Logging

Logs carry stage, provider code, correlation reference and bank code. They never
contain the bank account number, API keys or raw provider payloads. Validation
results never echo the account number.

## What is not verified

- **Channel 2 / bank payouts being enabled on Azaman's Moolre account.**
- **The endpoint path conflict above** (machine-readable reference vs guide).
- All commercially available banks, limits, fees, settlement SLA and
  availability windows.
- Whether `X-API-KEY` must be the private key for `/validate` in practice
  (documented as accepting either).
- Duplicate-reference error codes: the adapter matches documented/observed
  provider codes and messages, and still requires the caller to look up the
  original reference rather than re-send.
- Any sandbox or production transaction. **No live payout request was made.**

## Integration with Agent A

No route, controller, service binding, Prisma model, ledger entry or
orchestration is added here. When Agent A wires the port, the future binding key
is `services/moolreBankPayoutService.js` exporting
`new MoolreBankPayoutService({ ... })`, and the reconciliation authority keeps
ownership of terminal settlement for `PENDING` and `UNKNOWN_OUTCOME`.
