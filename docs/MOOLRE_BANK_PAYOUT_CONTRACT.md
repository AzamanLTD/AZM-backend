# Moolre Ghana bank payout — provider contract (Azaman adapter)

**Status:** provider adapter only. Not wired into `server.js`, no route, no
controller, no ledger, no beneficiary storage, no reconciliation ownership.
**Evidence state:** fixture-tested. No sandbox call has been made with Azaman
credentials and no live payout has ever been attempted. Fixture tests are not a
CI run: see §10.

**What is documented for channel 2.** Bank name enquiry is a published channel-2
capability, not a missing API. The per-endpoint reference documents
`POST /open/transact/validate` for it, with `type: 1`, `channel: "2"`,
`currency: "GHS"`, `receiver` = account number, `sublistid` = bank code,
`accountnumber` = Moolre source account, and returns the account holder name in
`data` as a string (`AVD01` success, `AVD02` account not found). This adapter
implements that enquiry against the documented fields. The open questions are
which endpoint family is live (§1.1) and whether Azaman's account is enabled for
channel 2 (§9) — not whether Moolre can validate a bank account.

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

Re-retrieved **2026-11-03** for a second time: the guide URL still returns a
document shell titled "Moolre API Documentation 2.0" with no readable body, and
the `/ai/...` pages still render in full. The guide therefore remains
**unreadable, not contradicted and not disproved** — a claim about its content
would be a claim about a page neither of us can currently read.

This adapter implements only the machine-readable paths and never tries a second
path: submitting one payout to two endpoints would be a double payout. The paths
are three constants in `PATHS`. Closing this requires either a non-production
sandbox call with Azaman sandbox credentials or written confirmation from Moolre.

Independent confirmation retrieved the same day, from
`/ai/guides/supported-channels.html`: Transfers support `1=MTN; 6=Telecel;
7=AT; 2=Instant Bank Transfer`, the page states that **named channel values are
not currently accepted**, and it instructs integrators to "validate requirements
with your Moolre contact before committing a production rollout plan" because
"service coverage, commercial eligibility, and operational limits can differ by
product and account". That is the source for sending `channel: "2"` as a numeric
string, and it is also the reason account eligibility is recorded as unproven
rather than merely untested.

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

Status mapping of `data.txstatus` — see section 3.1, which is deliberately
narrower than the obvious 0/1/2 table. Only `1` → `SUCCESSFUL` is published
and mapped; every other value, including `0` and `2`, is `UNRESOLVED`. A missing
status is never reported as pending.

The outer envelope `status` is **not** proof of settlement. Agent A's
reconciliation authority decides terminality.

### 3.1 Why `0` and `2` are NOT mapped to PENDING and FAILED

The Transfer Status reference documents exactly one successful response, with
`data.txstatus: 1`. It does not publish a mapping table for the other values.

The `0 / 1 / 2` triple does appear in the List Transactions reference, but there
it is the vocabulary of a **filter** parameter. Filter values and a status
response field are different contracts, and the List Transactions page does not
establish that they mean the same thing about a bank transfer.

The consequence is not cosmetic. If the adapter reported `FAILED` for an
unproven value, the financial authority could release a reversal (refund GHS to
the customer) for a payout that Moolre had already delivered to the recipient.
Reporting `SUCCESSFUL` for an unproven value is the mirror-image error. So the
adapter maps only the value whose meaning is published, returns `UNRESOLVED`
with `providerStatusRaw` preserved for everything else, and never invents a
terminal state in either direction.

To widen the mapping, we need written confirmation from Moolre (or a provider
contract document) stating what each `data.txstatus` value means for a bank
transfer, and whether an outer envelope code such as `SS01` is also required to
treat the result as final. Until then `PENDING` and `FAILED` are never returned
by this adapter.

Four separate facts stay separate and must not be conflated: the HTTP status,
the outer `{status, code, message}` envelope, the nested `data.txstatus`, and
actual customer settlement (which this adapter never asserts).

### 3.2 Amount and fee evidence is string-only

`data.amount`, `data.amountfee`, `data.networkfee` and `data.fee` are accepted
only as decimal **strings** matching `^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$`, with
surrounding transport whitespace trimmed. A JSON number is rejected: it has
already passed through binary floating point before the adapter sees it, so
accepting one would launder a possibly-corrupted value into `amountGhsExact`,
which Agent A uses as independent settlement evidence. Rejected evidence becomes
`null`, never the caller's requested amount, and the three fees are reported
separately and never summed.

### 3.3 `capabilities()` is the preflight contract

`capabilities()` returns `{ providerIoEnabled, bankPayoutEnabled,
credentialsPresent, sourceAccountConfigured, host, hostAllowed,
canInitiateBankPayout, mode }`. It exists, is configured, has the capability
enabled, points at an allowed host and can actually execute only when
`canInitiateBankPayout === true`; a consumer must treat that single boolean as
the gate. `describe()` is the same data in response-shape form and exposes no
credential and no account number.

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

## 6. Capability authorities

Four operations, four separate authorities. One shared switch would either blind
reconciliation whenever payouts are paused, or let a read imply a payout is
allowed.

```
providerIoEnabled              = MOOLRE_PROVIDER === 'LIVE'
hostAllowed                    = https host in {sandbox.moolre.com, api.moolre.com}
credentialsPresent             = MOOLRE_API_USER && MOOLRE_API_KEY
sourceAccountConfigured        = MOOLRE_ACCOUNT_NUMBER
bankPayoutEnabled              = MOOLRE_BANK_PAYOUT_ENABLED                 (default false)
endpointFamilyConfirmed        = MOOLRE_BANK_ENDPOINT_FAMILY_CONFIRMED     (default false)
channel2EligibilityConfirmed   = MOOLRE_BANK_CHANNEL2_ELIGIBILITY_CONFIRMED (default false)
```

| Operation | Requires |
| --- | --- |
| `listBanks` (directory) | provider I/O + allowed host |
| `validateBankAccount` (name enquiry) | + credentials + source account + endpoint family |
| `getBankTransferStatus` (reconciliation) | + credentials + source account |
| `initiateBankTransfer` (money out) | all of the above + payout switch + **channel-2 eligibility** |

| Scenario | directory | validate | status | initiate |
| --- | --- | --- | --- | --- |
| nothing configured | no | no | no | no |
| `MOOLRE_PROVIDER=LIVE`, creds, no switches | yes | no | yes | no |
| + endpoint family confirmed | yes | yes | yes | no |
| + payout switch, eligibility unconfirmed | yes | yes | yes | no |
| + eligibility confirmed | yes | yes | yes | yes |
| payout switch later turned **off** | yes | yes | **yes** | no |

The last row is the reconciliation invariant, and a test drives it: a payout that
Moolre may already hold must stay reconcilable while new payouts are stopped. Status
lookup is read-only, never retries, never initiates and never invents a reference.

`endpointFamilyConfirmed` and `channel2EligibilityConfirmed` record facts only
Moolre can supply. Neither follows from public documentation, neither is set by
this repository, and setting either without written confirmation would assert
provider approval Azaman does not have. Until both are set, `initiateBankTransfer`
refuses with `NOT_DISPATCHED` and `ENDPOINT_FAMILY_UNCONFIRMED` or
`CHANNEL2_ELIGIBILITY_UNCONFIRMED`.

`describe()` reports the four capability booleans, the two confirmation booleans,
mode, host, `channel: 2` and `currency: 'GHS'`. It never contains a credential or an
account number.

## 6a. Evidence binding

A result only becomes settlement evidence when Moolre supplies it, not when we
echo ourselves back:

- `externalId` is Moolre's echoed `externalref`. If the echo is **absent**, the
  result is `UNRESOLVED` with reason `EXTERNAL_REFERENCE_ABSENT`: `referenceId` is
  our own copy and cannot confirm its own correlation.
- If the echo **differs**, the result is `UNRESOLVED` with
  `EXTERNAL_REFERENCE_MISMATCH`. The reference is never silently replaced.
- A status lookup reaches terminal `SUCCESSFUL` only with a published `txstatus`
  of `1`, a matching echo, **and** a well-formed provider `amount`. Missing amount
  evidence gives `UNRESOLVED` / `AMOUNT_EVIDENCE_MISSING` rather than promotion.
- The requested amount is never substituted for the provider amount, and fees stay
  three independent exact strings.

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

Documented and implemented: the bank directory, the channel-2 account-name
enquiry, the transfer request shape and the transfer-status request shape.
Unproven, and therefore not claimed:

1. Whether Azaman's Moolre account has channel 2 bank payouts enabled.
   *(Public documentation does not establish account-level enablement, and no
   authorised non-production credential set is available in this workspace:
   no `MOOLRE_*` environment variable is set, so no sandbox call was possible.)* This is
   an account-eligibility fact only Moolre can confirm; public documentation
   expressly separates service coverage and commercial eligibility from the API
   contract.
2. Which endpoint family is live: `/transfer`+`/validate` or
   `/initiate`+`/validate-name`. The integration blocker is this path question,
   not the existence of a validation API.
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

No sandbox transfer has been authorised, so none was attempted — and none is
needed to test a path: a transfer initiation is an external financial action even
when framed as an experiment, so the endpoint family will be settled by written
confirmation or by non-mutating directory/name-enquiry calls in a proven sandbox,
never by trying both.

### What that evidence does and does not prove

These are local fixture runs with an injected fake HTTP client. They prove the
adapter's classification, gating and mapping logic; they do **not** prove the
provider contract, and they are **not** a CI test run.

On head `9238f02` the `Azaman Test Suite` workflow ran checkout, setup-node and
`npm ci` successfully, then failed at `npm audit --omit=dev --audit-level=low`
(29 vulnerabilities: 4 low, 21 moderate, 4 high). Prisma validation, database
setup and `Run tests` were never reached, so **no provider test has run in CI**.
The audit gate is deliberately left as it is; remediation belongs to the
dependency chain (#384), and no suppression or exemption was added here. A full
CI test run on the final head is still required before this adapter is treated
as verified.

## 11. The bank-validation port contract

`validateBankAccount({ accountNumber, bankCode })` is the name-enquiry port. It is
a read, not a dispatch: it cannot move money and it never posts to `/transfer`.

A successful result is exactly this object, with no additional fields:

```js
{
  valid: true,
  accountName: 'AKOSUA MENSAH',      // derived from Moolre's `data` string
  bankCode: '030100',               // the code WE sent, retained, not echoed back
  validatedAt: '2026-11-03T21:04:00.000Z', // our timestamp of this success
  provider: 'MOOLRE',
}
```

What the consumer must understand about each field:

- `accountName` is the only provider-derived fact here. Moolre's Validate Name
  response returns the holder name as a string in `data`; the adapter trims and
  collapses internal whitespace for display, nothing else.
- `bankCode` is **ours**: the code that was sent in `sublistid` and checked
  against the current directory. Moolre does not echo it.
- `validatedAt` is **ours**: the adapter's clock when the successful response was
  read. It is not a provider timestamp.
- The documented response contains **no account-number echo**. The adapter
  therefore returns none, and nothing in this contract may be read as provider
  confirmation of the account number.
- A consumer must bind this result to the exact `accountNumber` and `bankCode`
  it passed to this same call, and must not describe that local value as a
  provider echo. If the stored destination later differs, the validation does
  not carry over.

Refusals are a different contract from success:

```js
{
  provider: 'MOOLRE_DISBURSEMENT',
  outcome: 'DEFINITIVE_REJECTION',
  providerOutcome: 'DEFINITIVE_REJECTION',
  code: 'ACCOUNT_NOT_FOUND',
  refusalDocumented: true,   // AVD02 is a published answer
  dispatchProven: true,      // proof about this validation, not about a payout
  stage: 'VALIDATE',
  retryable: false,
}
```

Every other failure is `PROVIDER_UNAVAILABLE` / `VALIDATION_UNDETERMINED`:
timeouts, transport errors, auth failures, rate limits, 5xx, unparseable bodies,
an empty `data` string, or a `data` shape that is not a string. None of those is
evidence that the account is invalid, and none may be reported as
`ACCOUNT_NOT_FOUND`. `refusalDocumented` and `dispatchProven` exist so a caller
can tell a published refusal from an inconclusive answer without string-matching
the code.

Validation capability (`canValidateBankAccount`) is deliberately independent of
initiation capability (`canInitiateBankPayout`). Onboarding can confirm a
destination while new bank payouts remain switched off.

## 12. Owner-facing: written confirmations still required

Nothing below can be settled from public documentation, a fixture test or an
assumption. Each item needs written confirmation from Moolre, obtained by the
account owner. This adapter does not send that request and holds no secret for
it.

1. **Endpoint family.** For Azaman's account, is the live family
   `/open/transact/transfer` + `/open/transact/validate`, or
   `/open/transact/initiate` + `/open/transact/validate-name`? Both appear in
   official sources; only one can be correct for this account. Set
   `MOOLRE_BANK_ENDPOINT_FAMILY_CONFIRMED=true` only after this is answered.
2. **Channel-2 eligibility.** Is Azaman's Moolre account enabled for
   `channel: "2"` Instant Bank Transfer? Public channel documentation describes
   the capability, not this account's entitlement. Set
   `MOOLRE_BANK_CHANNEL2_ELIGIBILITY_CONFIRMED=true` only after this is answered.
3. **Status semantics.** What does every `data.txstatus` value mean for a bank
   transfer (not for a List Transactions filter), and is an outer envelope code
   such as `SS01` also required before a result is terminal?
4. **Refusal codes.** Which transfer-response codes are published refusals that
   prove no payout exists? Today the adapter treats every transfer-side refusal
   as unresolved because none is verified.
5. **Coverage and limits.** Which bank codes are live for this account, and what
   per-instruction and daily limits apply?
6. **Fees.** Which fees apply (`amountfee`, `networkfee`, `fee`), who bears each
   one, and at what point they are deducted? The adapter reports the three values
   separately and decides none of this.
7. **Settlement and reconciliation.** What settlement timing, return/reversal
   path and reconciliation evidence does Moolre provide for a bank transfer?

Until 1 and 2 are answered in writing, bank payout initiation stays disabled by
default and this adapter remains fixture-tested only. Nothing in the code implies
that Moolre has approved Azaman for bank payouts.
