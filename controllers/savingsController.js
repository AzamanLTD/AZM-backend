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
    const logger = require('../src/config/logger');
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

        // BUGFIX (Phase H12, 2026-05-27): idempotency lock for savings
        // deposits. Without a stable per-request key, two concurrent
        // deposit calls (network retry, FE double-tap on the deposit
        // button) both passed the balance check, both decremented the
        // user, both inserted a goal increment + SavingsDeposit row +
        // TransactionHistory row. The previous `SAVINGS_DEP_<deposit.id>`
        // txHash used a fresh uuid per call, so the unique constraint
        // never tripped. Now we use the client-supplied clientRequestId
        // (or X-Idempotency-Key header) to derive the txHash. The
        // @unique constraint on TransactionHistory.txHash rejects the
        // duplicate inside the transaction and rolls back the whole
        // deposit (including the user debit). Same pattern as
        // peerTransferController.sendFunds.
        const idempotencyKey =
            clientRequestId ||
            req.headers['x-idempotency-key'] ||
            `srv_savings_${userId}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const depositTxHash = `SAVINGS_DEP_${idempotencyKey}`;

        // Idempotency replay check — if we already saw this key, return
        // the prior outcome instead of attempting another debit.
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

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId, status: 'ACTIVE' }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Active savings goal not found.' });
        }

        // Get live rate for USDC conversion
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = settings ? settings.liveUsdToGhs : 15.0;
        const amountUsdc = parseFloat((parseFloat(amountGhs) / liveRate).toFixed(6));

        const result = await prisma.$transaction(async (tx) => {
            // Check user has sufficient balance
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user || user.availableBalance < amountUsdc) {
                throw new Error(
                    `Insufficient balance. Need ${amountUsdc.toFixed(4)} USDC ` +
                    `(GHS ${amountGhs}), have ${user ? user.availableBalance.toFixed(4) : 0} USDC.`
                );
            }

            // Deduct from available balance
            await tx.user.update({
                where: { id: userId },
                data: { availableBalance: { decrement: amountUsdc } }
            });

            // Credit the savings goal
            const isOnTime = goal.nextDueDate && new Date() <= new Date(goal.nextDueDate);
            const newStreak = isOnTime ? goal.streakCount + 1 : 0; // Reset streak if late
            const newLongest = Math.max(newStreak, goal.longestStreak);
            const newMissed = isOnTime ? goal.missedCount : goal.missedCount + 1;

            const updatedGoal = await tx.savingsGoal.update({
                where: { id },
                data: {
                    currentAmountGhs: { increment: parseFloat(amountGhs) },
                    totalDeposits: { increment: 1 },
                    streakCount: newStreak,
                    longestStreak: newLongest,
                    missedCount: newMissed,
                    nextDueDate: _calculateNextDueDate(new Date(), goal.frequency),
                    // Auto-complete if target reached
                    status: (goal.currentAmountGhs + parseFloat(amountGhs)) >= goal.targetAmountGhs
                        ? 'COMPLETED' : 'ACTIVE'
                }
            });

            // Record the deposit
            const deposit = await tx.savingsDeposit.create({
                data: {
                    goalId: id,
                    userId,
                    amountGhs: parseFloat(amountGhs),
                    amountUsdc,
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
            await tx.transactionHistory.create({
                data: {
                    userId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: -amountUsdc, // signed: outflow from spendable balance
                    feeUsdc: 0,
                    txHash: depositTxHash,
                    status: 'COMPLETED'
                }
            });

            // Notification for milestone streaks
            // Phase N: moved post-commit for full pipeline delivery.

            return { updatedGoal, deposit, newStreak };
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        // Phase N: fire streak milestone notification via notificationService (DB + socket + FCM)
        if (result.newStreak > 0 && result.newStreak % 4 === 0) {
            setImmediate(async () => {
                try {
                    await _getNotificationService(req).sendNotification({
                        userId,
                        title: `${result.newStreak}-Deposit Streak!`,
                        body: `You've been consistent for ${result.newStreak} deposits in a row on "${goal.name}". Keep it up!`,
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

        return res.status(200).json({
            success: true,
            message: `Deposited GHS ${amountGhs} into "${goal.name}".`,
            data: {
                deposit: result.deposit,
                goal: result.updatedGoal,
                streak: result.newStreak,
                amountUsdc
            }
        });

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
        const { amountGhs } = req.body;

        const goal = await prisma.savingsGoal.findFirst({
            where: { id, userId }
        });

        if (!goal) {
            return res.status(404).json({ success: false, message: 'Savings goal not found.' });
        }

        if (goal.status === 'CANCELLED') {
            return res.status(400).json({ success: false, message: 'This savings goal has been cancelled.' });
        }

        const withdrawAmount = amountGhs ? parseFloat(amountGhs) : goal.currentAmountGhs;

        if (withdrawAmount <= 0 || withdrawAmount > goal.currentAmountGhs) {
            return res.status(400).json({
                success: false,
                message: `Cannot withdraw GHS ${withdrawAmount}. Available: GHS ${goal.currentAmountGhs.toFixed(2)}.`
            });
        }

        // Check if early withdrawal (penalty applies)
        const isMatured = goal.endDate ? new Date(goal.endDate) <= new Date() : false;
        const isEarlyWithdrawal = goal.isLocked && !isMatured;
        const penaltyRate = isEarlyWithdrawal ? goal.earlyWithdrawalPenalty : 0;
        const penaltyGhs = parseFloat((withdrawAmount * penaltyRate).toFixed(2));
        const netWithdrawGhs = withdrawAmount - penaltyGhs;

        // Convert to USDC
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = settings ? settings.liveUsdToGhs : 15.0;
        const netUsdc = parseFloat((netWithdrawGhs / liveRate).toFixed(6));
        const penaltyUsdc = parseFloat((penaltyGhs / liveRate).toFixed(6));

        const result = await prisma.$transaction(async (tx) => {
            // Credit user's available balance (minus penalty)
            await tx.user.update({
                where: { id: userId },
                data: { availableBalance: { increment: netUsdc } }
            });

            // If penalty exists, route to system profit
            if (penaltyUsdc > 0) {
                await tx.systemProfitFees.upsert({
                    where: { id: 1 },
                    update: { balance: { increment: penaltyUsdc } },
                    create: { id: 1, balance: penaltyUsdc }
                });
            }

            // Update goal
            const newAmount = goal.currentAmountGhs - withdrawAmount;
            const updatedGoal = await tx.savingsGoal.update({
                where: { id },
                data: {
                    currentAmountGhs: Math.max(0, newAmount),
                    status: newAmount <= 0 ? 'CANCELLED' : goal.status
                }
            });

            // Ledger row for the user — credit side. The penalty (if any)
            // is logged as the feeUsdc field so the runDoubleCheck audit
            // sees: net inflow = netUsdc, fee = penaltyUsdc, total
            // sum-effect on availableBalance = netUsdc - 0 = +netUsdc.
            await tx.transactionHistory.create({
                data: {
                    userId,
                    type: 'INTERNAL_TRANSFER',
                    amountUsdc: netUsdc, // signed: inflow into spendable balance
                    feeUsdc: 0,          // penalty already deducted before crediting
                    txHash: `SAVINGS_WD_${id}_${Date.now()}`,
                    status: 'COMPLETED'
                }
            });

            // If a penalty was charged, route a SAVINGS_FEE audit row.
            if (penaltyUsdc > 0) {
                await tx.adminProfitLog.create({
                    data: {
                        amountUsdc: penaltyUsdc,
                        source: 'SAVINGS_FEE',
                        relatedTxId: `savings_penalty_${id}_${Date.now()}`
                    }
                });
            }

            return { updatedGoal };
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: isEarlyWithdrawal ? 'SAVINGS_EARLY_WITHDRAWAL' : 'SAVINGS_WITHDRAWAL',
            targetType: 'SAVINGSGOAL', targetId: String(goal.id),
            metadata: { withdrawAmountGhs: withdrawAmount, penaltyGhs }, ipAddress: req.ip,
        });

        return res.status(200).json({
            success: true,
            message: isEarlyWithdrawal
                ? `Early withdrawal: GHS ${netWithdrawGhs.toFixed(2)} returned (${(penaltyRate * 100).toFixed(0)}% penalty: GHS ${penaltyGhs.toFixed(2)}).`
                : `Withdrawn GHS ${netWithdrawGhs.toFixed(2)} from "${goal.name}".`,
            data: {
                withdrawnGhs: withdrawAmount,
                penaltyGhs,
                netReceivedGhs: netWithdrawGhs,
                netReceivedUsdc: netUsdc,
                isEarlyWithdrawal,
                penaltyRate,
                goal: result.updatedGoal
            }
        });

    } catch (error) {
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
