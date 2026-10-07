// controllers/savingsController.js
// =============================================================================
// AZAMAN V3 — SAVINGS SYSTEM CONTROLLER
//
// Goal-based savings with gamification:
//   - Users create savings goals with target amounts and schedules
//   - Funds are locked from available balance into savings
//   - Streak tracking rewards consistency
//   - Early withdrawal incurs a configurable penalty
//   - Reminders fire 1 day before, on due date, and after missed
//

/**
 * Phase N helper: retrieve the singleton NotificationService from app context.
 */
function _getNotificationService(req) {
    const svc = req.app.get('notificationService');
    if (svc) return svc;
    const NotificationService = require('../services/notificationService');
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    return new NotificationService(prisma, io);
}
// Endpoints:
//   POST   /api/savings/goals              — Create a new savings goal
//   GET    /api/savings/goals              — List all user's savings goals
//   GET    /api/savings/goals/:id          — Get a specific goal with deposits
//   POST   /api/savings/goals/:id/deposit  — Make a deposit into a goal
//   POST   /api/savings/goals/:id/withdraw — Withdraw from a goal (penalty if locked)
//   PUT    /api/savings/goals/:id/pause    — Pause a savings goal
//   PUT    /api/savings/goals/:id/resume   — Resume a paused goal
//   GET    /api/savings/overview           — Dashboard summary (total saved, streaks, etc.)
// =============================================================================

const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const {
    createServerTransactionQuote,
    consumeTransactionQuote,
    RateUnavailableError,
    QuoteConsumptionError,
} = require('../src/services/transactionQuoteService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

// §271 savings quote authority: a savings deposit/withdrawal converts
// GHS↔USDC, so it is a market-priced financial operation. Each request now
// goes through the ONE shared TransactionQuote authority — created through
// the same fail-closed freshness gate as every other quote (no execution-time
// GlobalSettings read), consumed exactly-once inside the economic
// transaction, and settled at the QUOTED rate (a mid-flight oracle move can
// never reprice a savings operation). TTL only covers an orphaned quote after
// a crash between creation and consumption — normal flow consumes in the
// same request.
const SAVINGS_QUOTE_TTL_SECONDS = 120;
// 12dp persisted quote → 8dp ledger projection, exactly like the fiat
// deposit settlement (ONE HALF_UP projection; every authoritative write
// below consumes this same value so the balance, SavingsDeposit row and
// ledger lines can never disagree).
const _usdc8dp = (quote) =>
    new Prisma.Decimal(quote.usdcAmountExact ?? String(quote.usdcAmount))
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);

const VALID_FREQUENCIES = ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'];

// ── Helper: Calculate next due date based on frequency ───────────────────────
function _calculateNextDueDate(fromDate, frequency) {
    const date = new Date(fromDate);
    switch (frequency) {
        case 'DAILY':    date.setDate(date.getDate() + 1); break;
        case 'WEEKLY':   date.setDate(date.getDate() + 7); break;
        case 'BIWEEKLY': date.setDate(date.getDate() + 14); break;
        case 'MONTHLY':  date.setMonth(date.getMonth() + 1); break;
        default:         date.setDate(date.getDate() + 7); break;
    }
    return date;
}

// =============================================================================
// 1. CREATE SAVINGS GOAL
// =============================================================================
exports.createGoal = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { name, targetAmountGhs, frequencyAmount, frequency, endDate, isLocked } = req.body;

        // Validation
        if (!targetAmountGhs || targetAmountGhs <= 0) {
            return res.status(400).json({ success: false, message: 'targetAmountGhs must be positive.' });
        }
        if (!frequencyAmount || frequencyAmount <= 0) {
            return res.status(400).json({ success: false, message: 'frequencyAmount must be positive.' });
        }
        if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
            return res.status(400).json({
                success: false,
                message: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`
            });
        }
        if (frequencyAmount > targetAmountGhs) {
            return res.status(400).json({
                success: false,
                message: 'frequencyAmount cannot exceed targetAmountGhs.'
            });
        }

        // Limit active goals per user
        const activeGoalCount = await prisma.savingsGoal.count({
            where: { userId, status: 'ACTIVE' }
        });
        if (activeGoalCount >= 5) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 5 active savings goals allowed.'
            });
        }

        const freq = frequency || 'WEEKLY';
        const nextDueDate = _calculateNextDueDate(new Date(), freq);

        const goal = await prisma.savingsGoal.create({
            data: {
                userId,
                name: name || 'My Savings',
                targetAmountGhs: parseFloat(targetAmountGhs),
                frequencyAmount: parseFloat(frequencyAmount),
                frequency: freq,
                nextDueDate,
                endDate: endDate ? new Date(endDate) : null,
                isLocked: isLocked !== false, // default true
            }
        });

        return res.status(201).json({
            success: true,
            message: 'Savings goal created!',
            data: goal
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.createGoal] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. LIST ALL GOALS
// =============================================================================
exports.listGoals = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const goals = await prisma.savingsGoal.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            include: {
                _count: { select: { deposits: true } }
            }
        });

        return res.status(200).json({
            success: true,
            data: goals
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.listGoals] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. GET SINGLE GOAL WITH DEPOSITS
// =============================================================================
exports.getGoal = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { id } = req.params;

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId },
            include: {
                deposits: {
                    orderBy: { createdAt: 'desc' },
                    take: 50
                }
            }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Savings goal not found.' });
        }

        // Calculate progress percentage
        const progressPercent = goal.targetAmountGhs > 0
            ? parseFloat(((goal.currentAmountGhs / goal.targetAmountGhs) * 100).toFixed(1))
            : 0;

        // Calculate days remaining
        let daysRemaining = null;
        if (goal.endDate) {
            daysRemaining = Math.max(0, Math.ceil(
                (new Date(goal.endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
            ));
        }

        return res.status(200).json({
            success: true,
            data: {
                ...goal,
                progressPercent,
                daysRemaining,
                isMatured: goal.endDate ? new Date(goal.endDate) <= new Date() : false,
                canWithdrawFree: goal.endDate ? new Date(goal.endDate) <= new Date() : !goal.isLocked
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.getGoal] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. DEPOSIT INTO SAVINGS GOAL
//    Deducts from user's availableBalance and credits the savings goal.
// =============================================================================
exports.deposit = async (req, res) => {
    const prisma = req.app.get('prisma');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { amountGhs, type, clientRequestId } = req.body;

        if (!amountGhs || amountGhs <= 0) {
            return res.status(400).json({ success: false, message: 'amountGhs must be positive.' });
        }

        // §R42.1 — CANONICAL IDENTITY. The shared idempotency middleware's
        // FinancialOperation claim (created from the Idempotency-Key
        // header BEFORE this handler ran) is the single canonical request
        // identity on the HTTP path. Legacy body clientRequestId /
        // x-idempotency-key values are explicit compatibility aliases:
        // when both are supplied they MUST match the canonical key, or
        // the request fails closed BEFORE any economics (a divergence
        // must never represent two identities for one client intent).
        // The txHash is derived from the durable claim id — no second
        // UUID, no Date.now()+Math.random() identity for a client
        // financial operation. The @unique constraint on txHash remains
        // as the secondary in-transaction backstop.
        const operation = res.locals?.financialOperation || null;
        const legacyKey =
            clientRequestId ||
            (req.headers && req.headers['x-idempotency-key']) || null;
        if (operation && legacyKey && String(legacyKey) !== operation.key) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_IDENTITY_CONFLICT',
                message: 'Body clientRequestId/x-idempotency-key does not match the Idempotency-Key header. Nothing was executed.',
            });
        }
        const idempotencyKey = operation
            ? `fo_${operation.id}`
            : legacyKey ||
              `srv_savings_${userId}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const depositTxHash = `SAVINGS_DEP_${idempotencyKey}`;

        // Legacy direct-service replay check. The HTTP path NEVER reaches
        // this point without a claim (the middleware requires the header
        // and replays committed results itself); the lookup is kept only
        // for direct service/test invocations that supply a legacy key
        // with no mounted authority.
        if (!operation && legacyKey) {
            const prior = await prisma.transactionHistory.findUnique({
                where: { txHash: depositTxHash }
            });
            if (prior) {
                return res.status(200).json({
                    success: true,
                    idempotent: true,
                    message: 'Deposit already processed (idempotent replay).'
                });
            }
        }

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId, status: 'ACTIVE' }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Active savings goal not found.' });
        }

        // §271 — quote-backed conversion rate (was: execution-time
        // liveUsdToGhs read with no freshness check and no snapshot — the
        // last stale-exposure money path in the app). The quote is created
        // through the fail-closed freshness gate; the USDC amount below is
        // the quote's OWN exact persisted amount, never recomputed.
        let quote;
        try {
            quote = await createServerTransactionQuote({
                prisma,
                userId,
                purpose: 'savings_deposit',
                amountGhs: parseFloat(amountGhs),
                feeGhs: 0,
                ttlSeconds: SAVINGS_QUOTE_TTL_SECONDS,
            });
        } catch (rateErr) {
            if (rateErr instanceof RateUnavailableError) {
                return res.status(503).json({
                    success: false,
                    code: rateErr.code,
                    message: rateErr.message,
                });
            }
            throw rateErr;
        }
        const amountUsdcLedgerExact = _usdc8dp(quote);
        const amountUsdc = amountUsdcLedgerExact.toNumber();
        // The quote is the economic contract: the pesewa-precise amount it
        // priced (HALF_UP from the requested amount) is the amount that
        // moves everywhere — the raw request value never reaches the goal
        // arithmetic (sub-pesewa inputs round like every other GHS
        // settlement in the platform).
        const depositGhsExact = new Prisma.Decimal(quote.amountGhsExact ?? String(quote.amountGhs));

        const result = await prisma.$transaction(async (tx) => {
            // §271 — exactly-once quote consumption is the FIRST mutation of
            // the economic transaction: it commits with the money or rolls
            // back with it. A duplicate execution of the same quote can
            // never double-debit.
            const consumedQuote = await consumeTransactionQuote({
                prisma: tx,
                quoteId: quote.id,
                userId,
                purpose: 'savings_deposit',
            });
            void consumedQuote;
            // r25 P1 — the goal row is locked FOR UPDATE INSIDE the money
            // transaction (same rigor as the withdrawal path, r16 P0-E).
            // The old code read the goal before the transaction and computed
            // streak/cadence/completion from that stale snapshot: two
            // concurrent deposits could both read streakCount=N and both
            // write streakCount=N+1 (one increment silently lost), and both
            // evaluate target completion against the same stale
            // currentAmountGhs. Every deposit-dependent value is now derived
            // from this locked authoritative row.
            const lockedRows = await tx.$queryRaw`
                SELECT * FROM "SavingsGoal" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
            const lockedGoal = lockedRows[0];
            if (!lockedGoal) throw new Error('Savings goal not found.');
            if (lockedGoal.status === 'CANCELLED') throw new Error('This savings goal has been cancelled.');
            if (lockedGoal.status === 'COMPLETED') throw new Error('This savings goal is already completed.');

            // r25 — ATOMIC BALANCE CLAIM: conditional decrement instead of a
            // stale read-then-verify. Losing the claim throws INSUFFICIENT_FUNDS
            // (rolls back everything); the DB nonneg CHECK is a secondary
            // invariant, never the guard. The projection's escrow column
            // moves with the same money the ledger goal restriction locks
            // (§P.4 — reconcileUserProjections requires them to stay equal).
            const debit = await tx.user.updateMany({
                where: {
                    id: userId,
                    availableBalance: { gte: amountUsdcLedgerExact }
                },
                data: {
                    availableBalance: { decrement: amountUsdcLedgerExact },
                    escrowLockedBalance: { increment: amountUsdcLedgerExact }
                }
            });
            if (debit.count !== 1) {
                const err = new Error(
                    `Insufficient balance. Need ${amountUsdc.toFixed(4)} USDC ` +
                    `(GHS ${amountGhs}).`
                );
                err.code = 'INSUFFICIENT_FUNDS';
                throw err;
            }

            // Credit the savings goal — derived from the LOCKED row.
            const lockedCurrent = new Prisma.Decimal(lockedGoal.currentAmountGhs);
            const lockedTarget = new Prisma.Decimal(lockedGoal.targetAmountGhs);
            const depositGhs = depositGhsExact;
            const isOnTime = lockedGoal.nextDueDate && new Date() <= new Date(lockedGoal.nextDueDate);
            const newStreak = isOnTime ? lockedGoal.streakCount + 1 : 0; // Reset streak if late
            const newLongest = Math.max(newStreak, lockedGoal.longestStreak);
            const newMissed = isOnTime ? lockedGoal.missedCount : lockedGoal.missedCount + 1;

            const updatedGoal = await tx.savingsGoal.update({
                where: { id },
                data: {
                    currentAmountGhs: { increment: depositGhsExact },
                    totalDeposits: { increment: 1 },
                    streakCount: newStreak,
                    longestStreak: newLongest,
                    missedCount: newMissed,
                    nextDueDate: _calculateNextDueDate(new Date(), lockedGoal.frequency),
                    // Auto-complete if target reached — evaluated against the
                    // locked current amount plus THIS deposit, exactly once.
                    status: lockedCurrent.plus(depositGhs).gte(lockedTarget)
                        ? 'COMPLETED' : 'ACTIVE'
                }
            });

            // Record the deposit
            const deposit = await tx.savingsDeposit.create({
                data: {
                    goalId: id,
                    userId,
                    amountGhs: depositGhsExact,
                    amountUsdc: amountUsdcLedgerExact,
                    type: type || (isOnTime ? 'SCHEDULED' : 'MANUAL'),
                    status: 'COMPLETED'
                }
            });

            // Ledger row for the user — keeps runDoubleCheck consistent.
            // Without this the user's availableBalance moves with no
            // matching TransactionHistory, and the next time the audit
            // runs the entire next transaction rolls back.
            //
            // Phase H12: txHash is now keyed by the client-supplied
            // idempotency key (computed at the top of the handler), so
            // a concurrent retry hits the @unique constraint and rolls
            // back the whole deposit — preventing double-debit.
            const depositHistory = await tx.transactionHistory.create({
                data: {
                    userId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: -amountUsdc, // signed: outflow from spendable balance
                    feeUsdc: 0,
                    txHash: depositTxHash,
                    status: 'COMPLETED',
                    // §271 — durable rate provenance on the money row: the
                    // quote identity and rate snapshot survive for audit
                    // (no execution-time repricing is possible at all, but
                    // the evidence of WHICH rate moved the money stays).
                    metadata: {
                        quoteId: quote.id,
                        quotedRate: quote.rateGhsPerUsdc,
                        rateSource: quote.rateSource,
                        rateAsOf: quote.rateAsOf,
                        amountGhsExact: depositGhsExact.toFixed(2),
                        usdcLedgerExact: amountUsdcLedgerExact.toFixed(8),
                    }
                }
            });

            // §P.4 AUTHORITATIVE LEDGER — savings goal lock, same
            // transaction, idempotent on the client-keyed txHash (the
            // @unique constraint already aborts duplicate deposits whole):
            //   D user:{userId}:liability        — spendable liability down
            //   C escrow:savings-{goalId}:locked — goal restriction up
            await ledger.post(tx, {
                idempotencyKey: `ledger:savings:deposit:${depositTxHash}`,
                entryType: 'VAULT_DEPOSIT',
                description: 'Savings goal deposit — spendable balance locked into goal restriction',
                userId,
                relatedEntity: 'savingsGoal',
                relatedEntityId: id,
                metadata: { depositId: deposit ? deposit.id : null, amountGhs: _exact(parseFloat(amountGhs)) },
                lines: [
                    { account: `user:${userId}:liability`, debit: amountUsdcLedgerExact.toFixed(8) },
                    { account: `escrow:savings-${id}:locked`, credit: amountUsdcLedgerExact.toFixed(8) },
                ],
            });

            // Notification for milestone streaks
            // Phase N: moved post-commit for full pipeline delivery.

            // §R42.1 — the committed response body is built INSIDE the
            // economic transaction from committed values, and the durable
            // claim flips to COMMITTED in the SAME transaction. A crash
            // between the economic commit and the HTTP response can no
            // longer leave money committed under an IN_PROGRESS identity:
            // claim + economics commit together or roll back together.
            const body = {
                success: true,
                message: `Deposited GHS ${amountGhs} into "${lockedGoal.name}".`,
                data: {
                    deposit,
                    goal: updatedGoal,
                    streak: newStreak,
                    amountUsdc,
                    // §271 — the rate that actually moved the money.
                    quotedRate: quote.rateGhsPerUsdc,
                    rateSource: quote.rateSource,
                    rateAsOf: quote.rateAsOf,
                    quoteId: quote.id
                }
            };
            if (operation) {
                const committed = await tx.financialOperation.updateMany({
                    where: { id: operation.id, status: 'IN_PROGRESS' },
                    data: {
                        status: 'COMMITTED',
                        statusCode: 200,
                        // WIRE serialization — the claim column is TEXT so
                        // the replay re-emits the exact original bytes.
                        responseBody: JSON.stringify(body),
                    },
                });
                if (committed.count !== 1) {
                    const err = new Error('Idempotency operation state conflict.');
                    err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                    throw err;
                }
            }

            return { updatedGoal, deposit, newStreak, body };
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        // Phase N: fire streak milestone notification via notificationService (DB + socket + FCM)
        if (result.newStreak > 0 && result.newStreak % 4 === 0) {
            setImmediate(async () => {
                try {
                    await _getNotificationService(req).sendNotification({
                        userId,
                        title: `${result.newStreak}-Deposit Streak!`,
                        body: `You've been consistent for ${result.newStreak} deposits in a row on "${result.updatedGoal.name}". Keep it up!`,
                        category: 'GENERAL',
                        actionPayload: { action: 'VIEW_SAVINGS', goalId: id }
                    });
                } catch (err) {
                    logger.error({ err: err }, '[savings.deposit] streak notification non-fatal');
                }
            });
        }

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: 'SAVINGS_DEPOSIT', targetType: 'SAVINGSGOAL', targetId: String(goal.id),
            metadata: { amountGhs: req.body.amountGhs }, ipAddress: req.ip,
        });

        // The exact response object committed with the economics — a
        // same-key retry replays the byte-identical committed result.
        return res.status(200).json(result.body);

    } catch (error) {
        // Phase H12: a parallel duplicate hit the @unique txHash
        // constraint. Treat as idempotent success.
        if (error.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('txHash')) {
            return res.status(200).json({
                success: true,
                idempotent: true,
                message: 'Deposit already processed (concurrent idempotent replay).'
            });
        }
        // §271 typed fail-closed surfaces: a stale/unavailable external rate
        // is a 503 the client may retry (the idempotency middleware's RELEASE
        // policy frees the claim); a lost quote-consumption race is a 409.
        if (error instanceof QuoteConsumptionError) {
            return res.status(error.statusCode || 409).json({ success: false, message: error.message, code: error.code });
        }
        logger.error({ err: error }, '[savings.deposit] error');
        return res.status(400).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. WITHDRAW FROM SAVINGS
//    If locked and not matured, applies early withdrawal penalty.
//    Returns funds to user's availableBalance.
// =============================================================================
exports.withdraw = async (req, res) => {
    const prisma = req.app.get('prisma');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { amountGhs, requestId } = req.body;

        // §R42.1 — CANONICAL IDENTITY (same contract as deposit): the
        // shared FinancialOperation claim from the Idempotency-Key header
        // is the single request identity on the HTTP path. The legacy body
        // requestId / x-idempotency-key values are compatibility aliases
        // that must MATCH the canonical key when both are supplied —
        // divergence fails closed before any economics. The replay hash
        // is derived from the durable claim id — no generated
        // Date.now()+Math.random() identity for a client financial
        // operation.
        const operation = res.locals?.financialOperation || null;
        const legacyKey =
            requestId ||
            (req.headers && req.headers['x-idempotency-key']) || null;
        if (operation && legacyKey && String(legacyKey) !== operation.key) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_IDENTITY_CONFLICT',
                message: 'Body requestId/x-idempotency-key does not match the Idempotency-Key header. Nothing was executed.',
            });
        }

        // §271 — quote-backed conversion rate (was: execution-time
        // liveUsdToGhs read inside the money transaction). The quote is
        // created through the fail-closed freshness gate BEFORE the
        // economic transaction, at the request's explicit amount — or, for
        // a withdraw-all request, at the currently persisted goal amount.
        // The economic transaction re-validates everything against the
        // locked row: if the goal moved concurrently and no longer matches
        // the quoted amount, the withdrawal fails closed (nothing releases)
        // and the client retries with an explicit amount.
        const explicitWithdrawGhs = amountGhs != null && amountGhs !== '' ? String(amountGhs) : null;
        let quotedWithdrawGhs = explicitWithdrawGhs;
        if (!quotedWithdrawGhs) {
            // Same scoping as the locked in-transaction read below
            // (id + userId, no status filter): lifecycle decisions stay
            // with the locked row, never this advisory pre-read.
            const preGoal = await prisma.savingsGoal.findFirst({
                where: { id, userId },
                select: { currentAmountGhs: true }
            });
            if (!preGoal) {
                return res.status(404).json({ success: false, message: 'Active savings goal not found.' });
            }
            // Pesewa projection with the SAME HALF_UP rule the in-tx
            // locked-row check uses — the quote and the check can never
            // disagree about the goal amount.
            quotedWithdrawGhs = new Prisma.Decimal(preGoal.currentAmountGhs)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
                .toFixed(2);
        }
        let quote;
        try {
            quote = await createServerTransactionQuote({
                prisma,
                userId,
                purpose: 'savings_withdrawal',
                amountGhs: parseFloat(new Prisma.Decimal(quotedWithdrawGhs).toFixed(2)),
                feeGhs: 0,
                ttlSeconds: SAVINGS_QUOTE_TTL_SECONDS,
            });
        } catch (rateErr) {
            if (rateErr instanceof RateUnavailableError) {
                return res.status(503).json({
                    success: false,
                    code: rateErr.code,
                    message: rateErr.message,
                });
            }
            throw rateErr;
        }
        // The quote's rate is the ONLY conversion rate in this operation.
        const withdrawRateExact = new Prisma.Decimal(quote.rateGhsPerUsdcExact ?? String(quote.rateGhsPerUsdc));

        // r16 P0-E: the goal row is locked FOR UPDATE INSIDE the money
        // transaction and every amount is derived from that locked
        // authoritative state. The old code read the goal before the
        // transaction and computed the withdrawal from that stale snapshot
        // — two concurrent partial withdrawals could both be validated
        // against the same currentAmountGhs and both release the same
        // savings money.
        const result = await prisma.$transaction(async (tx) => {
            // Durable replay identity. On the HTTP path the middleware
            // claim IS the authority (same-key retries never reach this
            // handler), so the hash is claim-derived. The legacy lookup
            // below only serves direct service/test invocations that
            // supply a body requestId with no mounted authority.
            const replayHash = operation
                ? `SAVINGS_WD_fo_${operation.id}`
                : (legacyKey ? `SAVINGS_WD_${id}_${String(legacyKey).slice(0, 64)}` : null);
            if (replayHash && !operation) {
                const existing = await tx.transactionHistory.findFirst({
                    where: { txHash: replayHash, userId },
                });
                if (existing) {
                    return { replay: true, txHash: replayHash };
                }
            }

            const rows = await tx.$queryRaw`SELECT * FROM "SavingsGoal" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
            const goal = rows[0];
            if (!goal) throw new Error('Savings goal not found.');

            if (goal.status === 'CANCELLED') throw new Error('This savings goal has been cancelled.');

            const goalAmount = new Prisma.Decimal(goal.currentAmountGhs);
            let withdrawAmount = new Prisma.Decimal(quote.amountGhsExact ?? String(quote.amountGhs));
            // §271 — the locked authoritative row must still match the
            // QUOTED economics. For a withdraw-all request the quote was
            // minted from a pre-read of currentAmountGhs; a concurrent
            // deposit/withdraw that moved the locked row makes that quote
            // stale for THIS goal state — fail closed (the quote is left
            // unconsumed and expires; the client retries with an explicit
            // amount). Never settle a withdrawal at a quote whose amount no
            // longer describes the locked goal. Legacy goals may carry
            // sub-pesewa residue from pre-271 float deposits — the quote is
            // pesewa-precise, so the withdraw-all comparison runs against
            // the goal's OWN pesewa projection (identical HALF_UP rule),
            // and the dust is absorbed at the goal update below.
            const goalPesewa = goalAmount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
            if (!explicitWithdrawGhs && !withdrawAmount.eq(goalPesewa)) {
                const err = new Error(
                    'The savings goal changed while the withdrawal quote was being prepared. Please retry the withdrawal.'
                );
                err.code = 'SAVINGS_GOAL_MOVED';
                throw err;
            }
            if (withdrawAmount.lte(0) || withdrawAmount.gt(explicitWithdrawGhs ? goalAmount : goalPesewa)) {
                throw new Error(
                    `Cannot withdraw GHS ${withdrawAmount.toFixed(2)}. Available: GHS ${goalAmount.toFixed(2)}.`
                );
            }

            // §271 — legacy sub-pesewa residue. The withdraw-all quote was
            // minted at the goal's pesewa projection (10.005 → 10.01), but
            // the ACTUAL money the goal holds — and that its escrow
            // projection locked — is the float residue (10.005). When the
            // quote exceeds the locked row by less than half a pesewa of
            // dust, settle at the ACTUAL money: the escrow projection
            // releases exactly what it locked, no sub-pesewa USDC is
            // minted from a pesewa rounding, and the dust is absorbed by
            // the goal update below (the goal fully drains either way).
            if (!explicitWithdrawGhs
                && withdrawAmount.gt(goalAmount)
                && withdrawAmount.minus(goalAmount).lte(new Prisma.Decimal('0.005'))) {
                withdrawAmount = goalAmount;
            }

            // Check if early withdrawal (penalty applies) — derived from the
            // locked authoritative row, not the stale pre-transaction read.
            const isMatured = goal.endDate ? new Date(goal.endDate) <= new Date() : false;
            const isEarlyWithdrawal = goal.isLocked && !isMatured;
            const penaltyRate = isEarlyWithdrawal ? Number(goal.earlyWithdrawalPenalty) : 0;
            const penaltyGhs = withdrawAmount.mul(penaltyRate).toFixed(2);
            const netWithdrawGhs = withdrawAmount.minus(new Prisma.Decimal(penaltyGhs));

            // §271 — the conversion rate is the QUOTE's, fixed at
            // initiation; the mid-flight oracle can never reprice this
            // withdrawal. Exact decimals: 2dp GHS parts / 8dp quoted rate,
            // projected ONCE at 8dp HALF_UP for the ledger authority (the
            // same projection standard as every other settlement).
            const netUsdcExact = netWithdrawGhs.div(withdrawRateExact).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
            const penaltyUsdcExact = new Prisma.Decimal(penaltyGhs).div(withdrawRateExact).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
            const netUsdc = netUsdcExact.toNumber();
            const penaltyUsdc = penaltyUsdcExact.toNumber();

            // Credit user's available balance (minus penalty). §P.4: the
            // goal restriction is released for the full net+penalty — the
            // projection escrow column moves with the same money the ledger
            // escrow account drains.
            {
                const releasedExact = netUsdcExact.plus(penaltyUsdcExact);
                await tx.user.update({
                    where: { id: userId },
                    data: {
                        availableBalance: { increment: netUsdcExact },
                        escrowLockedBalance: { decrement: releasedExact }
                    }
                });
            }

            // If penalty exists, route to system profit
            if (penaltyUsdc > 0) {
                await tx.systemProfitFees.upsert({
                    where: { id: 1 },
                    update: { balance: { increment: penaltyUsdcExact } },
                    create: { id: 1, balance: penaltyUsdcExact }
                });
            }

            // Update goal — computed from the locked row's own amount.
            // Sub-pesewa residue from pre-271 float deposits is dust: when
            // the remainder is smaller than half a pesewa the goal is
            // treated as fully drained (the GHS bookkeeping squares at
            // pesewa precision, the platform-wide GHS contract).
            const newAmount = goalAmount.minus(withdrawAmount);
            const dustResidue = newAmount.abs().lt(new Prisma.Decimal('0.005'));
            const updatedGoal = await tx.savingsGoal.update({
                where: { id },
                data: {
                    currentAmountGhs: (newAmount.lt(0) || dustResidue) ? new Prisma.Decimal(0) : newAmount,
                    status: (newAmount.lte(0) || dustResidue) ? 'CANCELLED' : goal.status
                }
            });

            // §271 — exactly-once quote consumption is the FIRST mutation
            // of the economic transaction: it commits with the money or
            // rolls back with it. A duplicate execution of the same quote
            // can never double-credit.
            await consumeTransactionQuote({
                prisma: tx,
                quoteId: quote.id,
                userId,
                purpose: 'savings_withdrawal',
            });

            const withdrawHistory = await tx.transactionHistory.create({
                data: {
                    userId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: netUsdc, // signed: inflow into spendable balance
                    feeUsdc: 0,          // penalty already deducted before crediting
                    txHash: replayHash || `SAVINGS_WD_${id}_${Date.now()}`,
                    status: 'COMPLETED',
                    // §271 — durable rate provenance on the money row.
                    metadata: {
                        quoteId: quote.id,
                        quotedRate: quote.rateGhsPerUsdc,
                        rateSource: quote.rateSource,
                        rateAsOf: quote.rateAsOf,
                        withdrawnGhsExact: withdrawAmount.toFixed(2),
                        netUsdcExact: netUsdcExact.toFixed(8),
                        penaltyUsdcExact: penaltyUsdcExact.toFixed(8),
                    }
                }
            });

            // §P.4 AUTHORITATIVE LEDGER — savings withdrawal settlement, same
            // transaction, idempotent on the durable TransactionHistory row's
            // own identity (its auto id is the stable key):
            //   D escrow:savings-{goalId}:locked — goal restriction released
            //   C user:{userId}:liability       — net refund to spendable
            //   C revenue:fees                   — early-withdrawal penalty
            //       realized (mirrors the SystemProfitFees increment above)
            {
                const grossDebit = netUsdcExact.plus(penaltyUsdcExact);
                const lines = [
                    { account: `escrow:savings-${id}:locked`, debit: grossDebit.toFixed(8) },
                    { account: `user:${userId}:liability`, credit: netUsdcExact.toFixed(8) },
                ];
                if (penaltyUsdcExact.greaterThan(0)) {
                    lines.push({ account: 'revenue:fees', credit: penaltyUsdcExact.toFixed(8) });
                }
                await ledger.post(tx, {
                    idempotencyKey: `ledger:savings:withdraw:${withdrawHistory.id}`,
                    entryType: 'VAULT_RELEASE',
                    description: isEarlyWithdrawal
                        ? 'Savings early withdrawal — restriction released, penalty realized'
                        : 'Savings withdrawal — restriction released to spendable balance',
                    userId,
                    relatedEntity: 'savingsGoal',
                    relatedEntityId: id,
                    metadata: { withdrawAmountGhs: _exact(withdrawAmount), penaltyGhs: _exact(penaltyGhs) },
                    lines,
                });
            }

            // If a penalty was charged, route a SAVINGS_FEE audit row.
            if (penaltyUsdc > 0) {
                await tx.adminProfitLog.create({
                    data: {
                        amountUsdc: penaltyUsdcExact,
                        source: 'SAVINGS_FEE',
                        relatedTxId: `savings_penalty_${id}_${Date.now()}`
                    }
                });
            }

            // §R42.1 — committed response built in-tx from committed
            // values; the durable claim flips to COMMITTED in the SAME
            // transaction (crash-after-commit can no longer leave the
            // request identity IN_PROGRESS under committed money).
            const body = {
                success: true,
                message: isEarlyWithdrawal
                    ? `Early withdrawal: GHS ${Number(netWithdrawGhs.toFixed(2)).toFixed(2)} returned (${(penaltyRate * 100).toFixed(0)}% penalty: GHS ${Number(penaltyGhs).toFixed(2)}).`
                    : `Withdrawn GHS ${Number(netWithdrawGhs.toFixed(2)).toFixed(2)} from "${goal.name}".`,
                data: {
                    withdrawnGhs: Number(withdrawAmount.toFixed(2)),
                    penaltyGhs: Number(penaltyGhs),
                    netReceivedGhs: Number(netWithdrawGhs.toFixed(2)),
                    netReceivedUsdc: netUsdc,
                    isEarlyWithdrawal,
                    penaltyRate,
                    goal: updatedGoal,
                    // §271 — the rate that actually moved the money.
                    quotedRate: quote.rateGhsPerUsdc,
                    rateSource: quote.rateSource,
                    rateAsOf: quote.rateAsOf,
                    quoteId: quote.id
                }
            };
            if (operation) {
                const committed = await tx.financialOperation.updateMany({
                    where: { id: operation.id, status: 'IN_PROGRESS' },
                    data: {
                        status: 'COMMITTED',
                        statusCode: 200,
                        // WIRE serialization — byte-identical replay.
                        responseBody: JSON.stringify(body),
                    },
                });
                if (committed.count !== 1) {
                    const err = new Error('Idempotency operation state conflict.');
                    err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                    throw err;
                }
            }

            return {
                replay: false,
                updatedGoal,
                goalName: goal.name,
                withdrawAmount: Number(withdrawAmount.toFixed(2)),
                penaltyGhs: Number(penaltyGhs),
                netWithdrawGhs: Number(netWithdrawGhs.toFixed(2)),
                netUsdc,
                isEarlyWithdrawal,
                penaltyRate,
                body
            };
        });

        if (result.replay) {
            return res.status(200).json({
                success: true,
                message: 'Withdrawal already processed (replay converged).',
                data: { replay: true, txHash: result.txHash }
            });
        }

        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: result.isEarlyWithdrawal ? 'SAVINGS_EARLY_WITHDRAWAL' : 'SAVINGS_WITHDRAWAL',
            targetType: 'SAVINGSGOAL', targetId: String(id),
            metadata: { withdrawAmountGhs: result.withdrawAmount, penaltyGhs: result.penaltyGhs }, ipAddress: req.ip,
        });

        // The exact response object committed with the economics — a
        // same-key retry replays the byte-identical committed result.
        return res.status(200).json(result.body);

    } catch (error) {
        // §271 typed fail-closed surfaces (same contract as deposit): a
        // stale/unavailable external rate is a retryable 503; a lost
        // quote-consumption race is a 409; a goal that moved under the
        // withdraw-all quote is a retryable 409.
        if (error instanceof QuoteConsumptionError) {
            return res.status(error.statusCode || 409).json({ success: false, message: error.message, code: error.code });
        }
        if (error.code === 'SAVINGS_GOAL_MOVED') {
            return res.status(409).json({ success: false, message: error.message, code: error.code });
        }
        logger.error({ err: error }, '[savings.withdraw] error');
        return res.status(400).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 6. PAUSE GOAL
// =============================================================================
exports.pauseGoal = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { id } = req.params;

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId, status: 'ACTIVE' }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Active savings goal not found.' });
        }

        await prisma.savingsGoal.update({
            where: { id },
            data: { status: 'PAUSED' }
        });

        return res.status(200).json({
            success: true,
            message: `"${goal.name}" has been paused. No reminders will be sent.`
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.pauseGoal] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 7. RESUME GOAL
// =============================================================================
exports.resumeGoal = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { id } = req.params;

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId, status: 'PAUSED' }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Paused savings goal not found.' });
        }

        const nextDueDate = _calculateNextDueDate(new Date(), goal.frequency);

        await prisma.savingsGoal.update({
            where: { id },
            data: { status: 'ACTIVE', nextDueDate }
        });

        return res.status(200).json({
            success: true,
            message: `"${goal.name}" has been resumed. Next due: ${nextDueDate.toISOString().split('T')[0]}.`
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.resumeGoal] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 8. SAVINGS OVERVIEW (Dashboard Summary)
// =============================================================================
exports.getOverview = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const goals = await prisma.savingsGoal.findMany({
            where: { userId },
            select: {
                id: true,
                name: true,
                status: true,
                targetAmountGhs: true,
                currentAmountGhs: true,
                frequencyAmount: true,
                frequency: true,
                streakCount: true,
                longestStreak: true,
                totalDeposits: true,
                missedCount: true,
                nextDueDate: true,
                endDate: true,
                isLocked: true,
                createdAt: true
            }
        });

        const activeGoals = goals.filter(g => g.status === 'ACTIVE');
        const completedGoals = goals.filter(g => g.status === 'COMPLETED');
        const totalSavedGhs = goals.reduce((sum, g) => sum + g.currentAmountGhs, 0);
        const totalTargetGhs = activeGoals.reduce((sum, g) => sum + g.targetAmountGhs, 0);
        const overallProgress = totalTargetGhs > 0
            ? parseFloat(((totalSavedGhs / totalTargetGhs) * 100).toFixed(1))
            : 0;

        // Best streak across all goals
        const bestStreak = Math.max(0, ...goals.map(g => g.longestStreak));
        const currentBestStreak = Math.max(0, ...activeGoals.map(g => g.streakCount));

        // Get live rate for USD display
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = settings ? settings.liveUsdToGhs : 15.0;
        const totalSavedUsdc = parseFloat((totalSavedGhs / liveRate).toFixed(4));

        // Upcoming due dates (next 7 days)
        const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const upcomingDues = activeGoals
            .filter(g => g.nextDueDate && new Date(g.nextDueDate) <= sevenDaysFromNow)
            .map(g => ({ goalId: g.id, name: g.name, dueDate: g.nextDueDate, amount: g.frequencyAmount }))
            .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

        return res.status(200).json({
            success: true,
            data: {
                totalSavedGhs,
                totalSavedUsdc,
                totalTargetGhs,
                overallProgress,
                activeGoalCount: activeGoals.length,
                completedGoalCount: completedGoals.length,
                totalGoalCount: goals.length,
                bestStreak,
                currentBestStreak,
                totalDepositsAllTime: goals.reduce((sum, g) => sum + g.totalDeposits, 0),
                upcomingDues,
                goals
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[savings.getOverview] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
