# r39 — Exact Money Migration, Business OS Boot Gate, Money-in-Chat Hardening

**Scope of this wave:** continuation of the exact-money authority migration (r38
was the first tranche), the fail-closed Business OS boot contract, and the
money-in-chat lifecycle/authority rules requested by the reviewer.

## 1. Business OS boot readiness gate (fail-closed)

**Finding:** `src/boot/treasury.js` invoked the business OS overlay installer
with `execSync` and swallowed every failure. A non-converged overlay (missing
`BusinessLedgerEntry` and the other overlay tables) left the whole
`/api/business-os` money surface live against tables that may not exist or,
worse, partially exist.

**Fix:**
- New `src/boot/businessOS.js` — `bootBusinessOSOverlay(app)` runs the overlay
  installer and, on failure, **leaves `app.set('businessOSReady', false)`**.
  The flag is set synchronously BEFORE any `await` so startup-racing requests
  can never enter a money-bearing route before convergence.
- `src/routes/index.js` gates the mounted Business OS router: requests fail
  closed with a retryable 503 until the overlay converges.
- The overlay installer itself (`infra/install-business-os-overlay.js`) was
  upgraded: statement-level error reporting and a fail-closed upgrade path
  (verified 157 applied / 0 errors on a fresh DB).
- Non-production boot (unit/integration suites mounting routes directly) sets
  `businessOSReady: true` — tests are not blocked by the production gate.

**Proof:** `__tests__/r39-businessos-boot-readiness.test.js` — 7/7, exercises
the real boot contract over real HTTP (gate closed before convergence, open
after, overlay failure keeps it closed).

## 2. Exact-decimal migration (A-class economic paths)

Policy: every value that can move money (balance debit/credit, fee, ledger
line, TransactionHistory amount, ticket amount) is a `Prisma.Decimal` from the
canonical parser (`ledger.toExactDecimal`); binary floats appear only as
explicitly-commented NON-AUTHORITATIVE mirrors (fraud scoring, SMS/email
display, threshold gating).

Sites migrated this wave:

| File | Change |
|---|---|
| `utils/payrollMath.js` | Full Decimal rewrite of gross/net/fee/tax lines |
| `services/businessOS/payrollService.js` | Decimal propagation, exact fee/exit computations |
| `services/businessOS/employeeService.js` | `salaryAmount` / `hourlyRate` writes via exact parser (was `parseFloat`) |
| `services/businessOS/businessLedgerService.js` | Decimal ledger sums/aggregations |
| `services/businessOS/posOrderService.js` | Order totals, discounts, ledger postings exact |
| `services/businessOS/dineInCashCloseService.js` | Cash-close totals exact |
| `services/businessInvoiceService.js` + new `utils/exactInvoiceMath.js` | Invoice line/tax arithmetic via shared exact helper |
| `services/businessOS/businessDirectMessageService.js` | Money-in-chat ticket amounts exact |
| `services/conversationMoneyService.js` | `_sendMoney` / request paths: exact amounts + same-key concurrent response convergence contract |
| `controllers/peerTransferController.js` | Send path: `toExactDecimal` amount, Decimal `lessThan` balance comparison, exact ledger lines (`toFixed(8)` strings); fulfill path already Decimal-native from the persisted row |
| `controllers/withdrawalController.js` | Withdrawal amount parse via exact parser; C-class mirrors annotated |
| `controllers/finance.controller.js` | DoubleCheck freeze record writes an exact Decimal (was `parseFloat || 0`) |
| `routes/businessOSRoutes.js` | Recipe `costGhs`/`totalCostGhs` exact `Decimal.mul` + `plus` reduce; payroll monthly total, payroll liability summary, escrow `totalHeld`, recurring-expense template writes all exact (were `parseFloat`) |
| `workers/withdrawalReconciliationWorker.js` | Refund derivation exact (a prior patch had silently not landed — re-applied and verified) |
| `services/finance.service.js` | Settlement economics / pool paths Decimal-consistent |

**Allowed to remain float (C-class, commented):** fraud-scoring amounts,
large-withdrawal SMS threshold comparison, email/SMS display mirrors,
JS `Number()` reads used solely for display strings.

## 3. Money-in-chat lifecycle + authority

- **Ticket currency contract:** `ConversationMoneyTicket.currency` default was
  `GHS` — a copy-forward contradicting every code path (transfer, escrow,
  money-send all move USDC). Schema default is now `USDC`.
- **Financial message immutability:** `DisappearingMessageWorker` now excludes
  Messages carrying a `ConversationMoneyTicket` from the deletion sweep
  (predicate guard), backed by the `ConversationMoneyTicket_messageId_fkey`
  RESTRICT constraint as the durable backstop. Money messages can never be
  hard-deleted by a future code path that forgets the guard.
- **Admin impersonation handoff:** a genuine ADMIN may act on a DirectMessage
  thread on a user's behalf under an explicit handoff contract
  (`routes/businessDirectMessageRoutes.js`,
  `services/businessOS/businessDirectMessageService.js`); non-admin callers
  are rejected. Pinned by `__tests__/r39-dm-admin-impersonation.test.js`.
- **Same-key convergence:** money-send / transfer paths return the committed
  outcome to concurrent same-`clientRequestId` losers (unique index still
  guarantees one economic effect). Pinned by
  `__tests__/r39-money-send-convergence.test.js`.
- **Cross-period reversal rule:** r37 made reversals net to zero inside one
  period; `__tests__/r39-ledger-cross-period-reversal.test.js` pins the rule
  when the reversal lands in a different reporting period.

## 4. Verification

- Lane runs (real PostgreSQL): withdrawal/finance/liquidation (13 suites, 50
  tests), peer-transfer + r25 concurrency + P.4 writer (3 suites, 20 tests),
  business-os + payroll + r36 recipe + r25 (10 suites, 90 tests) — all green.
- Full battery (320 suites): the first run failed 109 suites on a single root
  cause — the sandbox test DB was stale against the r39 `schema.prisma` +
  overlay DDL (`BusinessLedgerEntry` et al. did not exist). After
  `prisma db push` + overlay install (157 applied, 0 errors), the battery was
  re-run to completion. Results recorded in the commit/PR.
- Static gates: `prisma validate`, route-check, and `npm audit` re-run at
  commit time (unchanged from r38 baseline).
