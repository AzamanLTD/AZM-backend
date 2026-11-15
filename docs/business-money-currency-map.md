# Business money: currency map and the order-currency contract

Status: design record for review. No gate has been lifted, no POS settlement has been
enabled, and no production change is proposed by this document.

## The finding this document exists to record

The backend has exactly **one** native-GHS primitive and **zero** GHS transactional
records. Verified against `prisma/schema.prisma`:

| Model | Money field | Type | What it actually means |
|---|---|---|---|
| `BusinessPrice` | `amountExact` | `Decimal(20,2)` + `currency` `VarChar(3)` | **Native GHS**, exact pesewa precision, with confirmation audit and effective dating. The only honest GHS amount in the schema. |
| `BusinessOrder` | `amountUsdc` | `Decimal(20,8)`, **required**, no currency column | A USDC sale. Nothing states its currency, so nothing can contradict a GHS reading of it. |
| `BusinessOrderItem` | `unitPrice` | `Decimal(20,8)` | Inherits the order's unstated currency. |
| `BusinessInvoice` | `subtotalUsdc`, `taxTotalUsdc`, `billTotalUsdc` | `Decimal(20,8)` | USDC invoice. No currency discriminator. |
| `DineInTab` | `subtotalUsdc` | `Decimal(20,8)` | A USDC tab. |
| `BusinessLedgerEntry` | `amount` | `Decimal(20,8)` | Ledger amount in the entry's own unit, with no currency column. |
| `BusinessLedgerEntry` | `amountGhs` | `Decimal(20,8)`, optional | **A valuation**: "GHS equivalent at time of entry". Not a native GHS amount. |

The distinction in the last row is the one that matters most and is easiest to get
wrong. A valuation column records what a USDC amount was *worth* at a moment. A native
GHS sale records what a customer actually owes and paid in cedis. Writing a direct-cash
GHS sale into `amountGhs` would be a category error: the row would carry no proof that
cedis ever moved, and an 8-decimal valuation column is the wrong precision for pesewas.

This is why `posOrderService` refuses new POS settlement with
`POS_SETTLEMENT_NOT_ENABLED`. Its own contract already names the missing piece:

```js
const POS_SETTLEMENT_CONTRACT = Object.freeze({
    enabled: false,
    orderCurrency: null,   // ← the absent currency contract
});
```

The gate is deliberately two conditions, so `enabled: true` alone cannot lift the
refusal. That is correct and must stay.

## Feature classification

Classified from the schema and the two `businessOrder.create` call sites
(`services/businessOrderService.js:116`, `services/businessOS/posOrderService.js:258`).

| Feature | Priced in | Settled how | Azaman liability? |
|---|---|---|---|
| Marketplace / storefront checkout | USDC (`BusinessProduct.priceUsdc`) | Azaman balance → escrow | Yes, escrow-held |
| Dine-in tab + tab pay | USDC (`DineInTab.subtotalUsdc`) | Azaman balance | Yes |
| Business invoices | USDC (`billTotalUsdc`) | Azaman balance | Yes |
| POS sale (gated off) | USDC (`priceUsdc`) — **wrong for Ghana** | Refused today | Undefined |
| POS direct cash (proposed) | GHS (`BusinessPrice.amountExact`) | Cash to merchant | **No** — never held by Azaman |
| Business ledger entry | entry unit, plus GHS *valuation* | Bookkeeping | Records only |
| Susu / P2P / vault / transfers | USDC | Azaman balance | Yes |

Two conclusions follow. First, a business sale is not automatically an Azaman-held
liability: direct cash is a completed external payment that Azaman merely records.
Second, the POS pricing path reading `priceUsdc` is the specific defect that makes a
truthful Ghana POS impossible, because no confirmed GHS price is consulted.

## The contract

Additive, preserving legacy meaning:

1. `BusinessOrder.currency` — explicit discriminator (`GHS` | `USDC`), nullable for
   legacy rows so historical orders keep their USDC meaning without a guess.
2. `BusinessOrder.amountGhs` — `Decimal(20,2)`, exact pesewas, populated **only** for
   GHS orders.
3. `BusinessOrder.settlementChannel` — `DIRECT_CASH` | `AZAMAN_BALANCE` | `ESCROW` etc.,
   so a reader never has to infer who holds the money.
4. `amountUsdc` becomes nullable **only** so a GHS row can leave it empty rather than
   write a fake `0` USDC. Legacy rows retain their values and their meaning.
5. A database CHECK enforces the relationship: a `GHS` order has a non-null
   `amountGhs` and a null `amountUsdc`; a `USDC` order has the inverse; a legacy null
   currency may only carry `amountUsdc`.

### Operational caveat that must not be glossed over

Production schema management is `prisma db push`, which does **not** create CHECK
constraints. So the constraint has to arrive through a reviewed, idempotent SQL
bootstrap step, and the service layer must enforce the same invariant regardless.
Declaring a database invariant that production never applies would be worse than
having none, because it buys false confidence. This is recorded as an owner-visible
deployment step, not silently assumed.

## Required reader changes

Every aggregate and report that sums `amountUsdc` must filter by currency, or GHS
revenue will be silently summed into USDC totals (or dropped). 79 non-test files
reference `amountUsdc`; the report and revenue paths are the ones that change
behaviour, and they need per-currency grouping rather than a total.

## Explicitly out of scope

- Setting `POS_SETTLEMENT_CONTRACT.enabled = true`.
- Using `priceUsdc` for a GHS sale.
- Treating AZM as cash, or routing customer cash through a cashier's `azmBalance`.
- In-app GHS payment from a customer native-GHS balance: that needs a corresponding
  business-liability account, ledger, receipt, transfer and reconciliation path, and
  remains disabled until it exists and is verified.
- Any GRA-certified tax invoice claim.
