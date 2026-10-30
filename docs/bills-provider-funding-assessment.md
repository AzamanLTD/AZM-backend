# Bills — provider capability and funding assessment

**Status:** assessment only. Nothing in this document authorises a live bill payment, a schema change or a provider integration.
**Date:** 2026-10-30
**Scope:** Azaman member pays a supported bill from their Azaman balance, and can send a bill-payment *request* to a contact who reviews and pays it themselves.

> The blocking question is not "can we show a biller list". It is "whose money leaves, in what asset, and who proves the bill was actually paid". Until that is answered in writing by a partner, no debit route should exist.

---

## 1. Provider comparison

| | FEX / Mojo Payments | Hubtel |
|---|---|---|
| Public bill guide | Yes (`/developers/bills`) | Portal lists billers; no public order/quote contract found |
| Billers advertised | ECG prepaid + postpaid, Ghana Water, DStv, GOtv, StarTimes, Telecel Broadband | ECG, Ghana Water, TV bills, airtime/data, broadband |
| Documented flow | OAuth → partner catalog → account lookup → exact GHS quote → idempotent order → async fulfilment → signed webhook / status | Not published at the level needed |
| Base URL stated | `https://fex.mojo-pay.com/v1` (bills guide). The shared Partner API overview still shows an **HTTP** base. | Unknown |
| Idempotency | `Idempotency-Key` on order creation, partner reference | Unknown |
| Webhooks | HMAC-SHA256 over timestamp + exact raw body, event IDs | Unknown |
| BoG licence | PSP Enhanced (Mojo Payments) | Not confirmed in this review |

**Base URL discrepancy is unresolved.** The bills guide says HTTPS, the overview page shows HTTP. **Credentials, bearer tokens and biller account data must never be sent over plaintext HTTP**, so the canonical host must be confirmed in writing before any sandbox call is made. Treat the HTTPS bills-guide host as the only candidate.

## 2. Biller coverage

Both providers advertise the same domestic core: ECG (prepaid and postpaid), Ghana Water, DStv, GOtv, StarTimes, and broadband/airtime. FEX explicitly says the catalogue is **partner-scoped** and instructs integrators to read the real `input_schema` per product rather than hardcoding the public list. That means the advertised list is not our entitlement list; our actual enabled products must be enumerated from our own partner account.

## 3. Available partner API endpoints and schemas

Only FEX publishes enough to design against. The shape implied by its guide:

- `POST` token endpoint (OAuth) — client credentials, short-lived bearer.
- `GET` product catalogue — partner-scoped, each product carrying `input_schema`.
- `POST` account lookup/validation — returns customer name plus amount due for that biller account.
- `POST` quote — exact GHS amount, fees.
- `POST` order — with `Idempotency-Key`, partner reference, `payment_method`.
- `GET` order status — authoritative state.
- Signed webhook — fulfilment evidence.

No field-level schema is published for our account. **Every payload below is an inference from the guide, not a contract.**

## 4. Catalogue / lookup / quote / order / status / webhook flow

```text
catalog (partner-scoped products + input_schema)
  -> account lookup (customer name, amount due)
  -> quote (exact GHS, fee, expiry)
  -> order (idempotent, partner reference)
  -> async fulfilment
  -> signed webhook  OR  status poll
```

Two design consequences:

1. The amount is **quoted by the provider**, not computed by us. A bill amount can change between quote and payment.
2. Fulfilment is **asynchronous**. A browser return URL is never proof of payment; only signed webhook or status reconciliation is.

## 5. Supported payment methods — the unresolved core

FEX documents `payment_method` values `checkout` (default) and `collection`, but the documented flow still tells the integrator to open `payment.url`.

- `checkout` plainly means: send the payer to a FEX-hosted page. That is **not** "pay from Azaman balance".
- `collection` is **undefined in public docs**. It may mean a mobile-money collection request to the payer, or a partner-funded settlement. These are completely different products with different money flows.

**Do not infer that `collection` means partner-funded settlement.** The entire wallet-funded model depends on this answer.

## 6. Settlement and funding model

Three possible realities, only one of which makes a member balance spendable on bills:

1. **Partner float (prefunded).** Azaman tops up a bill-payment wallet at the provider; member debits hit our ledger and the provider draws down the float. We must then reconcile float movement against member debits.
2. **Per-transaction collection.** The provider debits the member's mobile money per bill. The member's Azaman balance is not the funding source at all, which contradicts the product requirement.
3. **Provider checkout.** The member pays outside Azaman entirely. Also contradicts the requirement.

If (1) is true, the float is **Azaman's asset, not member money**, and it must never be represented as a member balance. If it is not true, the wallet-funded product cannot be built on this provider as specified.

## 7. Fees and reconciliation

Unknown for both providers. Needed: provider fee per bill, any commission share, who bears an FX or rounding difference, and what report or API endpoint evidences float movement and per-order settlement. Reconciliation must reconcile **three** things: member debit, ledger posting, provider order.

## 8. Refund / reversal handling

Unknown. A paid-but-unfulfilled bill is the worst case in this product because the customer's electricity simply is not credited. Needed: whether reverses are provider-initiated, automatic, or a manual support flow; the SLA; and whether a reversal returns to the float or to the member.

## 9. Rate limits, failure and unknown outcomes

Unknown for both. The design must assume an **ambiguous timeout is normal**, not exceptional: a timeout after order creation can mean "not placed" or "placed and fulfilled". That is why the state machine carries `UNKNOWN → RECONCILIATION` and why a receipt is never issued on an unknown outcome.

## 10. Security and authentication

- OAuth client credentials, short-lived bearer tokens, never in client code.
- HMAC-SHA256 webhook signatures over timestamp + **exact raw body**; verify with a timing-safe compare and a replay window.
- Deduplicate on provider event ID; assume at-least-once delivery.
- Biller account identifiers are personal data: encrypt at rest, mask in UI and logs, never put a full meter or account number in a notification.
- Bind every order to our own `Idempotency-Key` and partner reference so a retry cannot double-charge.

## 11. Partner account and credential prerequisites

Needed from the owner before any sandbox work:

- Partner account status and the actual enabled product list for that account.
- Sandbox and production canonical HTTPS base URLs, in writing.
- OAuth client ID/secret, scopes.
- Webhook signing secret and the exact signing recipe.
- Bill-payment float wallet (if any): who funds it, minimum balance, settlement cadence.
- Named support/technical contact for the bill API.

None of these may be configured by an agent or shared over HTTP.

## 12. Owner decisions and unresolved questions

### Questions requiring written answers from FEX/Mojo

1. Does `payment_method=collection` debit an Azaman/Mojo partner-funded float, or does it send a collection request to the bill payer's mobile money?
2. Can an Azaman member pay from an **internal Azaman balance** while FEX settles the bill against an agreed partner float?
3. Must the partner top up a bill-payment prefund wallet?
4. If so, what funds that wallet, how are settlements recorded, and what reconciliation reports exist?
5. Can the customer be debited inside Azaman **without** opening an external checkout or approving a second MoMo payment?
6. Which biller products and `input_schema` fields are actually enabled for our partner account?
7. What is the agreed canonical HTTPS host in sandbox and production? (The overview vs bills-guide HTTP/HTTPS conflict must be resolved.)
8. Quote expiry, min/max amounts, fees, commissions, refunds?
9. Order lifecycle, webhook delivery, retry and deduplication guarantees?
10. What happens when the member is debited but provider fulfilment times out or fails?

### Hubtel equivalents

Biller API contract, direct vs partner-funded settlement, merchant float, reconciliation reports, webhook signing, and the enabled product list for our merchant account.

### Source-of-funds options (owner choice, not made here)

**Option A — native-GHS wallet authority.** Member holds a genuine GHS balance; payment debits it in exact pesewas with correct GHS liability postings, settled against provider float. Requires authoritative GHS liability accounting, funding evidence, reserve/debit semantics, reversal handling and concurrency protection. `main` has **no** native-GHS balance column today; #381 adds flag-gated GHS *collections* and its flag is OFF.

**Option B — explicit stablecoin-to-GHS conversion.** If the business approves funding a GHS bill from a stablecoin, the debit must follow an authoritative quote and an explicit conversion step, showing source asset, exact source amount, GHS payable, rate provenance (Kotani, never the display feed), fees/margin, quote expiry and any difference.

**Option C — prefunded partner settlement.** Azaman funds a provider float; define the float as an Azaman asset with its own ledger account, never as member money, and reconcile drawdown against member debits.

### Asset semantics blocker

`availableBalance` is a stablecoin balance whose comments say USDT while related work says USDC. **That ambiguity must be resolved before any conversion-based design**, because a bill paid from that balance is a conversion whether or not the UI admits it.

---

## Proposed Bill domain (design only — does not exist)

**SavedBillAccount** — owner, provider, partner product ID, encrypted account identifier + required input fields, masked display identifier, customer name from lookup, alias, last validated timestamp, active/archived.

**BillPayment** — owner, saved account, provider order reference, `FinancialOperation` identity, exact amount and fees in pesewas, quote ID / expiry / currency, idempotency identity, state, final provider evidence, receipt/token/voucher fields.

**BillPaymentRequest** — requester, recipient, biller and shared account reference, approved details-sharing scope, requested amount or quote reference, note, expiry, state (`PENDING`/`ACCEPTED`/`DECLINED`/`CANCELLED`/`EXPIRED`/`PAID`/`FAILED`), and the one resulting `BillPayment` if paid.

Reuse `FinancialOperation`, the ledger, the idempotency authority, `ReconciliationException`, the #378 notification contracts, the contact graph and audit logging. **No second ledger.**

## Proposed state machine

```text
CREATED
  -> FUNDS_RESERVED
  -> PROVIDER_PENDING
  -> PROCESSING
  -> SUCCEEDED

provider failure         -> FAILED
ambiguous timeout/network-> UNKNOWN -> RECONCILIATION -> SUCCEEDED | FAILED
```

Invariants: one member debit per intent, unique idempotency identity, no second order on retry, no double fulfilment, no receipt on an unknown outcome, reconciliation against provider evidence, exact pesewa amounts, defined compensation, and no silent repricing of a quoted bill. **No database transaction is held open across a provider HTTP call.**

## Contact request behaviour

A bill-payment request is **not** a charge. The recipient pays with their own funds through their own authenticated action. `/api/payment-requests` cannot be reused: its controller deliberately has no pay/accept-and-pay transition because the GHS settlement model is unproven. The new request needs single-winner decision, decline/cancel, expiry, re-quote before payment, restricted detail sharing, notifications through #378, and **no automatic debit of the recipient**.

## What may be built now

The assessment (this document), the API/domain contract, ledger-authority mapping, pure validation/DTO helpers with isolated tests, and provider onboarding questions.

## What may not be built yet

A live bill debit endpoint; bill-payment balance mutations; provider calls with invented credentials; fake billers; a fallback provider; enabling a real-money flag; assuming `collection` is partner-funded; and treating the GHS display valuation as GHS wallet cash. No schema or migration change until the funding decision and provider contract make one meaningful.
