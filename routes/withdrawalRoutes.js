const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');

// FX-balance workstream — fresh-canonical-rate transaction gate (§Gate scope)
const { requireFreshFxRate } = require('../middleware/fxTransactionGateMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const { fiatWithdrawalSchema, cryptoWithdrawalSchema } = require('../services/validation/financialSchemas');

const { idempotency } = require('../middleware/idempotency');
const { require2FA } = require('../middleware/require2FA');
const protect = authMiddleware.protect;

// r42 WAVE-2 — CANONICAL WITHDRAWAL SURFACES.
//
// Both routes commit the FinancialOperation claim INSIDE their economic
// reservation transaction (see the controllers) with a deterministic
// accepted/pending response that is TRUE BEFORE any external provider I/O.
// Because of that in-transaction wiring, every HTTP response is emitted at or
// BEFORE the commit boundary:
//   • 2xx  → the reservation + claim committed; the body is the stored replay
//            bytes (stable meaning: ACCEPTED / PENDING).
//   • 4xx/5xx → the reservation transaction rolled back; the claim is
//            provably un-committed and is RELEASED (releaseOn4xx + RELEASE
//            policy) so the client may retry the same key.
// No outcome status can ever be produced AFTER a commit: provider dispatch /
// KMS execution run in the controllers' post-response phase and are
// res-silent (outcomes live in the Withdrawal / CustodyExecution /
// reconciliation state machines). This is the same disposition contract the
// r42 review approved for the in-transaction-wired convert route.
// FX-balance workstream — server-side transaction gate. The fiat payout
// path is FX-dependent (USDC debit ⇄ GHS payout via Moolre at the canonical
// rate): with no FRESH canonical rate it is refused 503 here, BEFORE the
// idempotency claim and before any controller money movement. A saved/demo
// fallback rate is display-only and never opens this gate.
router.post('/fiat',
    protect, require2FA(),
    requireFreshFxRate(),
    idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }),
    validate(fiatWithdrawalSchema),
    withdrawalController.fiatWithdrawal);
// /crypto is deliberately NOT FX-gated: the on-chain payout is USDC-native
// (the only external feed it reads is the MATIC/USDC gas oracle) and the
// shared contract keeps USDC-native actions enabled. See
// docs/native-ghs-fx-audit.md §Gate scope.
router.post('/crypto',
    protect, require2FA(),
    idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }),
    validate(cryptoWithdrawalSchema),
    withdrawalController.cryptoWithdrawal);

// Real-time withdrawal progress popup — polling fallback for the Socket.IO
// `withdrawal_progress` event. Owner-only; returns a {stage,label,pct} triple.
router.get('/status/:reference', protect, withdrawalController.getWithdrawalStatus);

module.exports = router;
