// =============================================================================
// §r42.2 — RECOVERY EVIDENCE FOR EVERY RELEASING IDEMPOTENCY DECLARATION
//
// A release declaration lets the middleware delete a claim. This registry is the
// per-route argument for why that cannot double-spend, and it is enforced by
// __tests__/idempotency-release-wiring-invariant.test.js:
//
//   ATOMIC_CLAIM_COMMIT   the claim flips to COMMITTED inside the SAME database
//                         transaction as the economics. A released claim therefore
//                         implies a rolled-back economy, and a committed economy
//                         implies a claim that the release can no longer delete
//                         (the release is conditional on IN_PROGRESS).
//                         `commitSite` must name the transaction anchor and the
//                         exact commit expression; the test proves the expression
//                         exists AFTER the anchor, is conditional on IN_PROGRESS
//                         (or goes through commitOperation(), whose guard it also
//                         re-checks), and that the cited behavioural test exists.
//
//   STATE_CONVERGENT      the route moves no money. A repeated request after a
//                         released claim can only produce the same non-monetary
//                         artefact, and any spendable artefact is consumed later
//                         by a wired route under its own claim.
//
// Nothing here is a route-name allowlist: every ATOMIC entry is re-proven from
// source on each run, and an entry whose commit site or cited test disappears
// fails the suite.
// =============================================================================

const R42 = 'test/r42'; // placeholder never used; paths below are literal
void R42;

const ATOMIC = 'ATOMIC_CLAIM_COMMIT';
const CONVERGENT = 'STATE_CONVERGENT';

const IN_TX = (file, anchor, pattern, test, note) => ({
    kind: ATOMIC,
    commitSite: { file, anchor, pattern },
    test,
    note,
});

const RELEASE_EVIDENCE = [
    // ── admin ───────────────────────────────────────────────────────────────
    {
        file: 'routes/adminRoutes.js',
        key: 'POST /users/:id/credit',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/adminController.js',
            "§r42 P0 — the claim transitions to COMMITTED in the SAME",
            "const wired = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R8-POSTCOMMIT. wired claim: post-commit emitBalanceUpdate failure keeps the committed 200 + COMMITTED claim; mid-tx failure rolls back everything and the retry executes once' },
        ),
    },

    // ── fiat withdrawal (two mounts, one handler) ───────────────────────────
    {
        file: 'routes/financeRoutes.js',
        key: 'POST /api/withdraw/fiat',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/withdrawalController.js',
            'commitOperationClaimInTransaction: async (tx, facts) =>',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R5. real fiat withdrawal: claim commits IN the reservation → accepted 202, post-response emit throw is durable (never 500), same-key retry replays the exact bytes and cannot double-withdraw' },
        ),
    },
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /fiat',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/withdrawalController.js',
            'commitOperationClaimInTransaction: async (tx, facts) =>',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R5. real fiat withdrawal: claim commits IN the reservation → accepted 202, post-response emit throw is durable (never 500), same-key retry replays the exact bytes and cannot double-withdraw' },
        ),
    },

    // ── peer transfer ───────────────────────────────────────────────────────
    {
        file: 'routes/friendRoutes.js',
        key: 'POST /transfer/send',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/peerTransferController.js',
            '§R42.1 — the committed response body is built INSIDE the',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/release-evidence-route-behaviour.pg.test.js', name: 'A1. same-key replay cannot repeat the economic operation' },
            'Route-level, real disposable PostgreSQL, real auth + 2FA + shared idempotency over HTTP: A1 same-key replay (byte-identical COMMITTED body, one transfer row, one sender-side history row), A2 concurrent duplicates (exactly one movement), A3 post-commit emit failure (claim still COMMITTED with the wire body; the retry replays it and never re-runs the economics).',
        ),
    },

    // ── transit booking ─────────────────────────────────────────────────────
    {
        file: 'routes/marketplaceRoutes.js',
        key: 'POST /transit/trips/:id/book',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'services/transitBookingService.js',
            '§r42 WIRED CLAIM (transit booking identity',
            "const committed = await tx.financialOperation.updateMany({ where: { id: financialOperation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/transit-booking-identity.pg.test.js', name: 'T3. two truly concurrent identical requests create EXACTLY one' },
        ),
    },

    // ── multi-currency conversion ───────────────────────────────────────────
    {
        file: 'routes/multiCurrencyRoutes.js',
        key: 'POST /convert',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/multiCurrencyController.js',
            'IN_PROGRESS so an already-committed wired row',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'MC3. injected failure mid-transaction → whole rollback + released claim → retry executes exactly once' },
        ),
    },

    // ── savings ─────────────────────────────────────────────────────────────
    {
        file: 'routes/savingsRoutes.js',
        key: 'POST /goals/:id/deposit',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/savingsController.js',
            '§R42.1 — the committed response body is built INSIDE the',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42.1-wired-first-tranche.pg.test.js', name: 'W6. crash-after-commit: emit failure errors the response, retry replays committed result' },
        ),
    },
    {
        file: 'routes/savingsRoutes.js',
        key: 'POST /goals/:id/withdraw',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/savingsController.js',
            '§R42.1 — committed response built in-tx from committed',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42.1-wired-first-tranche.pg.test.js', name: 'W6. crash-after-commit: emit failure errors the response, retry replays committed result' },
        ),
    },

    // ── vault ───────────────────────────────────────────────────────────────
    {
        file: 'routes/vaultRoutes.js',
        key: 'POST /:id/deposit',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'services/vaultService.js',
            'committedBody = { success: true, breakdown };',
            "const committed = await tx.financialOperation.updateMany({ where: { id: financialOperation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r16-vault-savings-claims.test.js', name: 'D2b: deposit-winner serialization — a committed deposit is refunded by the subsequent break' },
            'The cited test proves single-release economics; the claim-commit proof is the static one above.',
        ),
    },
    {
        file: 'routes/vaultRoutes.js',
        key: 'POST /:id/break',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'services/vaultService.js',
            'committedBody = { success: true, vault: vaultUpdate };',
            "const committed = await tx.financialOperation.updateMany({ where: { id: financialOperation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r16-vault-savings-claims.test.js', name: 'D1b: two concurrent breakEarly calls → exactly one release' },
        ),
    },

    // ── wallet ──────────────────────────────────────────────────────────────
    {
        file: 'routes/walletRoutes.js',
        key: 'POST /withdraw',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/walletController.js',
            'obligation + the COMMITTED FinancialOperation all land atomically.',
            "const committed = await tx.financialOperation.updateMany({ where: { id: _operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R6. real CRYPTO withdrawal through the route: accepted 202 at the commit boundary, exactly ONE provider submission, same-key retry replays the exact bytes and cannot double-withdraw' },
            'R6 drives the withdrawal route family; this mount creates the durable ticket and performs no provider I/O.',
        ),
    },
    {
        file: 'routes/walletRoutes.js',
        key: 'POST /internal-transfer',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'routes/walletRoutes.js',
            '§R42.1 — the sh',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42.1-wired-first-tranche.pg.test.js', name: 'W1. commit + byte-identical replay, economics exactly once' },
            'Same wired pattern as the first tranche; no dedicated replay test for this mount yet.',
        ),
    },

    // ── war room ────────────────────────────────────────────────────────────
    {
        file: 'routes/warRoomRoutes.js',
        key: 'POST /api/war-room/corporate-purchase',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/warRoomController.js',
            'const responseBody = await prisma.$transaction(async (tx) =>',
            'await commitOperation(tx, res.locals.financialOperation, 201, body);',
            { file: '__tests__/r272-corporate-purchase-idempotency.test.js', name: 'replayed same-key commit → one row, one credit, replayed body' },
        ),
    },
    {
        file: 'routes/warRoomRoutes.js',
        key: 'POST /api/war-room/corporate-purchase/api',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/warRoomController.js',
            'await _ensureMasterCrypto(tx);',
            'await commitOperation(tx, res.locals.financialOperation, 201, body);',
            { file: '__tests__/r272-corporate-purchase-idempotency.test.js', name: 'API path: replayed same-key quote → one row, one credit' },
        ),
    },

    // ── native-GHS and bank withdrawals ─────────────────────────────────────
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /ghs',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/withdrawalController.js',
            'commitOperationClaimInTransaction: async (tx, f) =>',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/release-evidence-route-behaviour.pg.test.js', name: 'B1. same-key replay cannot repeat the economic operation' },
            'Route-level, real disposable PostgreSQL: B1 same-key replay (byte-identical COMMITTED 202 body, one debit, one withdrawal row, one provider instruction), B2 concurrent duplicates (exactly one movement; the duplicate is refused or replays), B3 post-commit provider failure (the acceptance claim stays COMMITTED and the retry replays it instead of paying twice). The GHS leg also commits the claim in-tx before any provider I/O (nativeGhsWithdrawalService).',
        ),
    },
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /crypto',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/withdrawalController.js',
            'const _cryptoOperation = res.locals?.financialOperation || null;',
            "const committed = await tx.financialOperation.updateMany({ where: { id: _cryptoOperation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R6. real CRYPTO withdrawal through the route: accepted 202 at the commit boundary, exactly ONE provider submission, same-key retry replays the exact bytes and cannot double-withdraw' },
        ),
    },
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /bank',
        policy: 'RELEASE_5XX',
        ...IN_TX(
            'controllers/withdrawalController.js',
            'commitOperationClaimInTransaction: async (tx, claimFacts) =>',
            "const committed = await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/native-ghs-bank-quote.test.js', name: 'A: a BANK shortfall quote is non-executable and never reaches the payout port' },
        ),
    },

    // ── quote routes: no money moves ────────────────────────────────────────
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /ghs/quote',
        policy: 'RELEASE_5XX',
        kind: CONVERGENT,
        test: { file: '__tests__/native-ghs-quote-intent-binding.test.js', name: 'A: no quote can fund payee A or payee B — the backing refusal precedes intent binding' },
        note: 'Quoting posts no ledger entry and moves no balance (asserted in the cited test via ledgerTransaction.count()). A released claim can only mint another unconsumed quote; a quote is spendable only through the wired POST /ghs under its own claim and intent binding.',
    },
    {
        file: 'routes/withdrawalRoutes.js',
        key: 'POST /bank/quote',
        policy: 'RELEASE_5XX',
        kind: CONVERGENT,
        test: { file: '__tests__/native-ghs-bank-quote.test.js', name: 'B2: a changed amount cannot spend a quote' },
        note: 'Same quote authority as the MoMo quote (ghsFundingPlanner.quoteGhsShortfall): no money moves at quote time, and the quote is consumed only by the wired POST /bank under its own claim, bound to amount, payee and bank code.',
    },

    // ── releaseOn4xx only: RETAIN on 5xx, still wired ───────────────────────
    {
        file: 'routes/azmConversionRoutes.js',
        key: 'POST /',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'controllers/azmConversionController.js',
            '§r42.1 WIRED CLAIM COMMIT — the conversion economics above and the',
            'await commitOperation(tx, res.locals?.financialOperation || null, 200, response);',
            { file: '__tests__/r42.1-idempotency-closure.pg.test.js', name: 'B. same-key replay: byte-identical; economics never re-execute' },
        ),
    },
    {
        file: 'routes/azmGiftRoutes.js',
        key: 'POST /send',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'services/azmGiftService.js',
            'const commit = (gift, senderNewBalance) => {',
            'return commitOperation(tx, financialOperation, 200, response)',
            { file: '__tests__/azm-gift-economic-atomicity.test.js', name: 'C. same key twice: exactly one movement, second call is a replay' },
        ),
    },
    {
        file: 'routes/escrowRoutes.js',
        key: 'POST /fund',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'services/escrowService.js',
            '§r42.1 WIRED CLAIM COMMIT — the funding economics above and the',
            'await commitOperation(tx, financialOperation, 200, response);',
            { file: '__tests__/r42.1-idempotency-closure.pg.test.js', name: 'C. concurrent duplicates: exactly one funding' },
        ),
    },
    {
        file: 'routes/orderBookRoutes.js',
        key: 'POST /orders',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'controllers/orderBookController.js',
            'below (same `order` / `matches` objects), so a same-key replay is',
            'await commitOperation(tx, res.locals?.financialOperation || null, 200, response);',
            { file: '__tests__/r42-trade-initiation.pg.test.js', name: 'T1. post-commit failure → 4xx RETAINS the claim; trade committed once; same-key retry refused' },
        ),
    },
    {
        file: 'routes/p2pRoutes.js',
        key: 'POST /complete',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'services/p2p.service.js',
            'vendorPct:',
            'await commitOperation(tx, financialOperation, 200, response);',
            { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R1. committed economics + post-commit exception converted to HTTP 400 → claim NOT released, money moved once' },
        ),
    },
    {
        file: 'routes/paymentRequestRoutes.js',
        key: 'POST /',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'controllers/paymentRequestController.js',
            'Commit the durable operation identity WITH the economics.',
            "const committed = await tx.financialOperation.updateMany({ where: { id: claim.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/payment-requests-authority.pg.test.js', name: 'PR1/PR2: concurrent duplicate create → one row; replay is byte-identical and never re-notifies' },
        ),
    },
    {
        file: 'routes/paymentRequestRoutes.js',
        key: 'POST /:id/cancel',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'controllers/paymentRequestController.js',
            "viewerIsRequester: action === 'cancel',",
            "const committed = await tx.financialOperation.updateMany({ where: { id: claim.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/payment-requests-authority.pg.test.js', name: 'PR1/PR2: concurrent duplicate create → one row; replay is byte-identical and never re-notifies' },
            'Cancel and decline share one claim-commit block; the cited suite covers the wired create path, which is the one that mints a request. Cancel/decline move no money.',
        ),
    },
    {
        file: 'routes/paymentRequestRoutes.js',
        key: 'POST /:id/decline',
        policy: 'RELEASE_4XX_ONLY',
        ...IN_TX(
            'controllers/paymentRequestController.js',
            "viewerIsRequester: action === 'cancel',",
            "const committed = await tx.financialOperation.updateMany({ where: { id: claim.id, status: 'IN_PROGRESS' },",
            { file: '__tests__/payment-requests-authority.pg.test.js', name: 'PR1/PR2: concurrent duplicate create → one row; replay is byte-identical and never re-notifies' },
            'Same shared cancel/decline claim-commit block; declining moves no money.',
        ),
    },
];

module.exports = { RELEASE_EVIDENCE, ATOMIC, CONVERGENT };
