# B5 — the 30 customer step-up gaps, risk-ordered

Generated from `scripts/step-up-route-inventory.js`, the same module the guard and the coverage matrix read. `STEP_UP_ENFORCEMENT` is OFF and this plan does not change it.

KYC, 2FA and idempotency are listed because they are real, but none is action-bound: none binds the authenticated user to this operation, amount and destination at the moment of the write.

| # | route | tier | canonical action | legacy alias | existing controls | proof required before closing |
|---|---|---|---|---|---|---|
| 1 | `POST businessOS /ewa/withdraw` | 1 | `BUSINESS_EWA_WITHDRAWAL` | — | none | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 2 | `POST businessOS /finance/payout` | 1 | `BUSINESS_FINANCE_PAYOUT` | — | none | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 3 | `POST crossBorderSusu /payout` | 1 | `CROSS_BORDER_SUSU_PAYOUT` | — | KYC, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 4 | `POST finance /withdraw/fiat` | 1 | `FINANCE_FIAT_WITHDRAWAL` | suspected legacy alias | KYC, 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 5 | `POST vault /:id/break` | 1 | `VAULT_BREAK` | — | 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 6 | `POST withdrawal /bank` | 1 | `BANK_WITHDRAWAL` | — | KYC, 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 7 | `POST withdrawal /crypto` | 1 | `CRYPTO_WITHDRAWAL` | — | KYC, 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 8 | `POST withdrawal /fiat` | 1 | `FIAT_WITHDRAWAL` | legacy alias of `/api/withdraw` | KYC, 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 9 | `POST withdrawal /ghs` | 1 | `NATIVE_GHS_WITHDRAWAL` | — | KYC, 2FA, idempotency | grant bound to destination + exact amount, consumed in the debit transaction; replay and wrong-amount refusal |
| 10 | `POST azmGift /send` | 2 | `GIFT_SEND` | — | idempotency | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 11 | `POST businessOS /orders/:id/refund` | 2 | `BUSINESS_ORDER_REFUND` | — | none | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 12 | `POST business /invoices/:invoiceId/pay` | 2 | `INVOICE_PAY` | — | KYC | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 13 | `POST dineIn /tabs/:tabId/pay` | 2 | `DINE_IN_TAB_PAY` | — | KYC, 2FA | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 14 | `POST friend /transfer/send` | 2 | `FRIEND_TRANSFER_SEND` | — | KYC, 2FA, idempotency | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 15 | `PUT friend /transfer/:id/fulfill` | 2 | `FRIEND_TRANSFER_FULFILL` | — | KYC | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 16 | `POST storefrontCheckoutIntegrity /:businessProfileId/order` | 2 | `STOREFRONT_ORDER` | second mount of the same operation | none | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 17 | `POST storefront /:businessProfileId/order` | 2 | `STOREFRONT_ORDER` | — | none | grant bound to the counterparty/resource + exact amount; single-winner replay test |
| 18 | `POST azmConversion /` | 3 | `AZM_CONVERSION` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 19 | `POST conversation /:conversationId/messages/:messageId/fund-escrow` | 3 | `CONVERSATIONID_MESSAGES_MESSAGEID_FUND-ESCROW` | — | none | grant bound to the resource + exact amount; idempotent retry converges |
| 20 | `POST conversation /:conversationId/messages/:messageId/release-escrow` | 3 | `CONVERSATIONID_MESSAGES_MESSAGEID_RELEASE-ESCROW` | — | none | grant bound to the resource + exact amount; idempotent retry converges |
| 21 | `POST crossBorderSusu /contribute` | 3 | `CROSS_BORDER_SUSU_CONTRIBUTE` | — | KYC, idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 22 | `POST deposit /fiat/initiate` | 3 | `DEPOSIT_FIAT_INITIATE` | — | KYC, idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 23 | `POST deposit /fiat/initiate/moolre` | 3 | `DEPOSIT_MOOLRE_INITIATE` | — | KYC, idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 24 | `POST multiCurrency /convert` | 3 | `MULTI_CURRENCY_CONVERT` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 25 | `POST orderBook /orders` | 3 | `ORDER_BOOK_PLACE` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 26 | `POST savings /goals/:id/deposit` | 3 | `SAVINGS_DEPOSIT` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 27 | `POST savings /goals/:id/withdraw` | 3 | `SAVINGS_WITHDRAWAL` | — | 2FA, idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 28 | `POST sharedVault /:id/deposit` | 3 | `SHARED_VAULT_DEPOSIT` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 29 | `POST vault /:id/deposit` | 3 | `VAULT_DEPOSIT` | — | idempotency | grant bound to the resource + exact amount; idempotent retry converges |
| 30 | `POST wallet /deposit/initialize` | 3 | `WALLET_DEPOSIT_INITIATE` | — | KYC, idempotency | grant bound to the resource + exact amount; idempotent retry converges |

**Tier 1 (direct value exit)** — value leaves irreversibly; a compromised session costs money at once and a double dispatch cannot be reversed.

**Tier 2 (value to another party)** — value reaches a counterparty or a locked balance is released; double-spend and double-release are the failure modes.

**Tier 3 (internal reservation, conversion, funding intent)** — value stays inside the account; lower blast radius, but a broken reservation still corrupts the ledger.

## Sequencing
1. Tier 1 first, one route per change set with its own route-level test.
2. Parity before gating where an alias exists: `/fiat` against `/api/withdraw`, the two storefront mounts against each other, and `finance/withdraw/fiat` against whichever service it actually calls. An alias must never become the unprotected way in.
3. Tier 2 next; `transfer/:id/fulfill` and escrow release need single-winner concurrency tests, not happy paths.
4. Tier 3 last; deposit initiations must not regress idempotency.

Each closure moves one row from `CUSTOMER_GAP` to `GATED`, and the guard fails if the gap list grows. The count may only fall.
