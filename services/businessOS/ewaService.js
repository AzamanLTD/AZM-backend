// 📁 services/businessOS/ewaService.js
// services/businessOS/ewaService.js
// =============================================================================
// Earned Wage Access (EWA) Service
// =============================================================================
// Allows employees to withdraw a portion of their accrued wages before payday.
// Azaman fronts the cash; the business settles on payroll day.
//
// Rules:
// - Max withdrawal: 30% of accrued wages
// - Min withdrawal: 1 AZM
// - Fee: 1% of withdrawal (deducted from the employee's share, not the business)
// - The withdrawn amount is tracked as `withdrawnEarly` on the employee record
//   and deducted from their net pay on payroll day
//
// P0 settlement repair (2026-09-21):
// - The business treasury (BusinessProfile.userId's User.availableBalance) is
//   DEBITED the gross amount — previously the withdrawal was recorded without
//   ever funding it from the business.
// - The employee receives spendable USDC on User.availableBalance — NEVER
//   azmBalance (loyalty points).
// - All amounts are exact Prisma.Decimal end-to-end; JS numbers only appear in
//   non-authoritative response presentation.
// - The 1% fee is realized through the established platform fee mechanism
//   (SystemProfitFees + AdminProfitLog + the authoritative ledger line).
// - An optional caller-supplied idempotencyKey claims a DB-unique economic
//   identity BEFORE any mutation: a duplicate request cannot mint another
//   payout (r14 guarded-insert pattern).
// - External destinations (MOMO/WALLET/SPLIT) FAIL CLOSED — no authoritative
//   payout path exists, so the withdrawal is never recorded as sent.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { getBusinessRequestContext } = require('../../src/lib/businessRequestContext');
const ledger = require('../ledgerService');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;

const ZERO = new Prisma.Decimal(0);
const EWA_FEE_RATE = new Prisma.Decimal('0.01');
const EWA_CAP_RATE = new Prisma.Decimal('0.30');
const EWA_MIN_WITHDRAWAL = new Prisma.Decimal(1);

// Typed settlement errors (fail-closed): every one aborts the whole
// transaction — the employee's capacity, the treasury and every accounting
// write roll back together.
const settlementError = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

const isSerializableConflict = (error) => error?.code === 'P2034';

// ── Issue #330: server-owned withdrawal-intent lifecycle ────────────────────
const EWA_INTENT_STATUS = { PENDING: 'PENDING', COMMITTED: 'COMMITTED', REFUSED: 'REFUSED' };

// A DEFINITIVE pre-commit refusal marker. Only throws from the documented
// refusal sites below carry it; only such a refusal may retire an attempt
// as REFUSED. Every other failure (connection loss, serialization retries
// exhausted, unknown errors) leaves the intent PENDING — reconcilable, and
// never misclassified as a refusal or a committed payout.
const ewaRefusal = (message, code) => {
    const err = code ? settlementError(code, message) : new Error(message);
    err.ewaPreCommitRefusal = true;
    return err;
};

const waitForSerializableRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt));
});

class EwaService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    _resolveBusinessProfileId(explicitBusinessProfileId) {
        const contextBusinessProfileId = getBusinessRequestContext()?.businessProfileId;
        if (explicitBusinessProfileId && contextBusinessProfileId && explicitBusinessProfileId !== contextBusinessProfileId) {
            throw new Error('Business scope mismatch.');
        }
        return explicitBusinessProfileId || contextBusinessProfileId || null;
    }

    async _assertWithdrawalAuthorization(tx, employee, businessProfileId) {
        const context = getBusinessRequestContext();
        if (!context?.businessProfileId) return;
        if (context.businessProfileId !== businessProfileId) throw new Error('Business scope mismatch.');
        if (context.isAdmin || context.isBusinessOwner || String(context.userId) === String(employee.userId)) return;

        const actor = await tx.businessEmployee.findFirst({
            where: {
                businessProfileId,
                userId: context.userId,
                status: 'ACTIVE',
            },
            select: { permissions: true },
        });
        if (!actor || !(actor.permissions || []).includes('*') && !(actor.permissions || []).includes('ewa.manage')) {
            throw new Error('You do not have permission to manage EWA for this employee.');
        }
    }

    // ── Check EWA Eligibility ──────────────────────────────────────────────
    async checkEligibility(employeeId, businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        const employee = scopedBusinessProfileId
            ? await this.prisma.businessEmployee.findFirst({
                where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
            })
            : await this.prisma.businessEmployee.findUnique({ where: { id: employeeId } });
        if (!employee) throw new Error('Employee not found.');
        if (employee.status !== 'ACTIVE') {
            return { eligible: false, reason: 'Employee is not active.' };
        }

        // exact cap math (presentation numbers in the response)
        const accrued = new Prisma.Decimal(employee.accruedWages);
        const alreadyWithdrawn = new Prisma.Decimal(employee.withdrawnEarly);
        const maxAvailable = accrued.mul(EWA_CAP_RATE);
        const remaining = Prisma.Decimal.max(ZERO, maxAvailable.minus(alreadyWithdrawn));

        return {
            eligible: remaining.gte(EWA_MIN_WITHDRAWAL),
            accruedWages: Number(accrued),
            alreadyWithdrawn: Number(alreadyWithdrawn),
            maxWithdrawable: Number(maxAvailable),
            remainingWithdrawable: Number(remaining),
            limitPercent: 30,
        };
    }

    // ── Request EWA Withdrawal ─────────────────────────────────────────────
    // The employee read, cap check, withdrawnEarly claim, guarded treasury
    // debit, employee credit, platform fee, and every ledger/history record are
    // one serializable transaction. A failure in ANY later write rolls back
    // the complete movement; concurrent withdrawals serialize on the guarded
    // claim; a duplicate idempotencyKey claim collides on a unique index and
    // rolls back instead of minting a second payout.
    async requestWithdrawal({ employeeId, amount, destination, businessProfileId, idempotencyKey }) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);

        // §5 DESTINATION SAFETY: only the internal AZAMAN_BALANCE credit has
        // an authoritative settlement path. 'AZM_BALANCE' is the legacy alias
        // used by the employee self-service route. Every external destination
        // (MOMO/WALLET/SPLIT) FAILS CLOSED — a payout is never recorded as
        // sent externally when it was not.
        const INTERNAL_DESTINATIONS = ['AZAMAN_BALANCE', 'AZM_BALANCE'];
        const requestedDestination = destination === undefined || destination === null
            ? 'AZAMAN_BALANCE'
            : String(destination);
        if (!INTERNAL_DESTINATIONS.includes(requestedDestination)) {
            throw ewaRefusal(
                `EWA destination ${requestedDestination} has no authoritative payout path; the withdrawal was not executed.`,
                'EWA_EXTERNAL_DESTINATION_UNSUPPORTED',
            );
        }

        // §6 EXACT MONEY: the gross is an exact decimal end-to-end — never a
        // JS float in any authoritative calculation.
        let withdrawAmount;
        try {
            withdrawAmount = new Prisma.Decimal(String(amount));
        } catch (e) {
            throw new Error('Amount must be a valid number.');
        }
        if (!withdrawAmount.isFinite() || !withdrawAmount.isPositive()) {
            throw ewaRefusal('Amount must be a valid number.');
        }
        if (withdrawAmount.dp() > 8) {
            throw ewaRefusal('Amount supports at most 8 decimal places.');
        }
        if (withdrawAmount.lt(EWA_MIN_WITHDRAWAL)) {
            throw ewaRefusal('Minimum withdrawal is 1 AZM.');
        }
        if (idempotencyKey !== undefined && idempotencyKey !== null
            && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 140)) {
            throw ewaRefusal('idempotencyKey must be a string of 1-140 characters.');
        }

        // ── Issue #330: durable server-side intent registration ───────────
        // The browser-local key (portal PR #115) cannot survive a device
        // change. The server now claims the intent BEFORE any economics, in
        // its own durable write, so an authorized session on ANY device can
        // discover the unresolved attempt and recover the original identity
        // without minting a new one. The claim is bound to the canonical
        // economic request: employeeId + idempotencyKey (DB-unique) +
        // normalized exact amount + destination. Keyless (legacy) attempts
        // register no intent — unchanged behavior.
        let intent = null;
        if (idempotencyKey) {
            const employeeRef = await this.prisma.businessEmployee.findUnique({
                where: { id: employeeId },
                select: { id: true, businessProfileId: true },
            });
            if (employeeRef) {
                intent = await this._claimWithdrawalIntent({
                    employeeId,
                    businessProfileId: employeeRef.businessProfileId,
                    idempotencyKey,
                    amountExact: withdrawAmount.toFixed(8),
                    destination: requestedDestination,
                });
            }
            // If the employee does not exist the Serializable transaction
            // below throws the documented 'Employee not found.' refusal —
            // no intent is ever registered for a phantom employee.
        }

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const employee = scopedBusinessProfileId
                        ? await tx.businessEmployee.findFirst({
                            where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
                        })
                        : await tx.businessEmployee.findUnique({ where: { id: employeeId } });
                    if (!employee) throw ewaRefusal('Employee not found.');
                    if (scopedBusinessProfileId) {
                        await this._assertWithdrawalAuthorization(tx, employee, scopedBusinessProfileId);
                    }

                    // REQUEST IDENTITY FIRST (before any new-withdrawal gate):
                    // a retry of a committed request replays the committed
                    // outcome even if capacity is now consumed or eligibility
                    // changed afterwards — a replay moves no money, so the
                    // new-withdrawal rules must not block it. A materially
                    // different reuse of the same key fails closed here.
                    // ECONOMIC IDENTITY (Phase H12 clientRequestId pattern, same
                    // architecture as peerTransfer/savings): a caller-supplied
                    // idempotencyKey derives a DB-unique TransactionHistory txHash
                    // BEFORE any mutation. txHash is @unique, so a concurrent or
                    // retried request with the same key either finds the committed
                    // row here or collides on the unique index and rolls the WHOLE
                    // transaction back — a duplicate economic request cannot mint
                    // another payout.
                    const txHash = idempotencyKey
                        ? `EWA_${employeeId}_${idempotencyKey}`.slice(0, 200)
                        : null;
                    if (txHash) {
                        const prior = await tx.transactionHistory.findFirst({
                            where: { txHash },
                            select: { id: true, metadata: true },
                        });
                        if (prior) {
                            const priorMeta = (prior.metadata && typeof prior.metadata === 'object')
                                ? prior.metadata
                                : {};
                            const priorEmployeeId = String(priorMeta.employeeId ?? '');
                            const priorGross = priorMeta.grossAmount != null ? String(priorMeta.grossAmount) : null;
                            // EXACT REPLAY of the committed withdrawal (same
                            // employee, same exact gross): return the committed
                            // outcome and move no money. No row was ever created
                            // for a failed attempt, so a retried failed request
                            // evaluates fresh — never replaying a failure.
                            if (priorEmployeeId === String(employeeId)
                                && priorGross !== null
                                && priorGross === withdrawAmount.toFixed(8)) {
                                const priorFee = priorMeta.fee != null
                                    ? new Prisma.Decimal(String(priorMeta.fee))
                                    : withdrawAmount.mul(EWA_FEE_RATE).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
                                const priorNet = priorMeta.netToEmployee != null
                                    ? new Prisma.Decimal(String(priorMeta.netToEmployee))
                                    : withdrawAmount.minus(priorFee);
                                // Issue #330: a replay is an authoritative
                                // resolution — settle the intent in the same
                                // transaction (best-effort guard: a no-op if
                                // another attempt already settled it).
                                if (intent) {
                                    await tx.ewaWithdrawalIntent.updateMany({
                                        where: {
                                            id: intent.id,
                                            status: { in: [EWA_INTENT_STATUS.PENDING, EWA_INTENT_STATUS.REFUSED] },
                                        },
                                        data: {
                                            status: EWA_INTENT_STATUS.COMMITTED,
                                            committedTxHash: txHash,
                                            refusalMessage: null,
                                            resolvedAt: new Date(),
                                        },
                                    });
                                }
                                return {
                                    success: true,
                                    replayed: true,
                                    idempotencyKey,
                                    grossAmount: Number(withdrawAmount),
                                    fee: Number(priorFee),
                                    netToEmployee: Number(priorNet),
                                    remainingWithdrawable: Number(Prisma.Decimal.max(ZERO,
                                        new Prisma.Decimal(employee.accruedWages).mul(EWA_CAP_RATE)
                                            .minus(new Prisma.Decimal(employee.withdrawnEarly)))),
                                    employee,
                                };
                            }
                            // Same economic identity reused with materially
                            // different parameters is a contradiction — fail
                            // closed and name the differing field(s).
                            const differing = [];
                            if (priorEmployeeId !== String(employeeId)) differing.push('employeeId');
                            if (priorGross !== withdrawAmount.toFixed(8)) differing.push('amount');
                            throw settlementError(
                                'EWA_IDEMPOTENCY_CONFLICT',
                                `Idempotency key was already used with different parameters (differing: ${differing.join(', ')}); the withdrawal was not executed.`,
                            );
                        }
                    }

                    // ── Issue #330: in-transaction intent claim ──────────
                    // The single arbiter for concurrent same-intent attempts:
                    // only one transaction can move PENDING/REFUSED →
                    // COMMITTED, atomically with the financial writes below.
                    // A concurrent duplicate either loses the guarded update
                    // (Serializable write conflict → retry → the replay path
                    // above returns the committed truth) or observes
                    // COMMITTED here and returns it without moving money.
                    if (intent) {
                        const claimed = await tx.ewaWithdrawalIntent.updateMany({
                            where: {
                                id: intent.id,
                                status: { in: [EWA_INTENT_STATUS.PENDING, EWA_INTENT_STATUS.REFUSED] },
                            },
                            data: {
                                status: EWA_INTENT_STATUS.COMMITTED,
                                committedTxHash: txHash,
                                refusalMessage: null,
                                resolvedAt: new Date(),
                            },
                        });
                        if (claimed.count !== 1) {
                            const current = await tx.ewaWithdrawalIntent.findUnique({
                                where: { id: intent.id },
                            });
                            if (current?.status === EWA_INTENT_STATUS.COMMITTED) {
                                // This exact economic identity already
                                // committed — replay the committed truth.
                                const prior = current.committedTxHash
                                    ? await tx.transactionHistory.findUnique({
                                        where: { txHash: current.committedTxHash },
                                    })
                                    : null;
                                const priorMeta = (prior?.metadata && typeof prior.metadata === 'object')
                                    ? prior.metadata
                                    : {};
                                const committedGross = priorMeta.grossAmount != null
                                    ? new Prisma.Decimal(String(priorMeta.grossAmount)) : null;
                                const committedFee = priorMeta.fee != null
                                    ? new Prisma.Decimal(String(priorMeta.fee)) : null;
                                const committedNet = prior
                                    ? new Prisma.Decimal(String(prior.amountUsdc)) : null;
                                if (prior && committedGross && committedFee !== null && committedNet) {
                                    return {
                                        success: true,
                                        replayed: true,
                                        idempotencyKey,
                                        grossAmount: Number(committedGross),
                                        fee: Number(committedFee),
                                        netToEmployee: Number(committedNet),
                                        remainingWithdrawable: Number(Prisma.Decimal.max(ZERO,
                                            new Prisma.Decimal(employee.accruedWages).mul(EWA_CAP_RATE)
                                                .minus(new Prisma.Decimal(employee.withdrawnEarly)))),
                                        employee,
                                    };
                                }
                                // COMMITTED intent whose authoritative anchor
                                // row cannot be loaded: fail closed. Never
                                // move money, never claim a fresh refusal.
                                throw settlementError(
                                    'EWA_INTENT_RECONCILIATION_REQUIRED',
                                    'This withdrawal request is already committed but its authoritative record could not be loaded; the withdrawal was not executed. Use the EWA intent recovery endpoint and contact support for reconciliation.',
                                );
                            }
                            throw new Error(
                                'EWA withdrawal failed — insufficient available balance (concurrent withdrawal detected).',
                            );
                        }
                    }
                    if (!employee.ewaEligible) throw ewaRefusal('EWA is not available for this employee.');
                    if (employee.status !== 'ACTIVE') throw ewaRefusal('Only active employees can request EWA.');

                    // §7 exact cap math on the Decimal columns
                    const accrued = new Prisma.Decimal(employee.accruedWages);
                    const alreadyWithdrawn = new Prisma.Decimal(employee.withdrawnEarly);
                    const maxAvailable = accrued.mul(EWA_CAP_RATE);
                    const remaining = maxAvailable.minus(alreadyWithdrawn);

                    if (withdrawAmount.gt(remaining)) {
                        throw ewaRefusal(
                            `Amount exceeds available EWA balance. Max: ${Prisma.Decimal.max(ZERO, remaining).toFixed(2)} AZM`,
                        );
                    }

                    const fee = withdrawAmount.mul(EWA_FEE_RATE).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
                    const netToEmployee = withdrawAmount.minus(fee);

                    // §1 treasury source: the business owner's spendable balance
                    const business = await tx.businessProfile.findUnique({
                        where: { id: employee.businessProfileId },
                        select: { userId: true },
                    });
                    if (!business) throw ewaRefusal('Business profile not found.');


                    const guardWhere = {
                        id: employeeId,
                        status: 'ACTIVE',
                        ewaEligible: true,
                        withdrawnEarly: { lte: maxAvailable.minus(withdrawAmount) },
                    };
                    if (scopedBusinessProfileId) guardWhere.businessProfileId = scopedBusinessProfileId;

                    const guardResult = await tx.businessEmployee.updateMany({
                        where: guardWhere,
                        data: {
                            withdrawnEarly: { increment: withdrawAmount },
                        },
                    });

                    if (guardResult.count !== 1) {
                        throw ewaRefusal(
                            'EWA withdrawal failed — insufficient available balance (concurrent withdrawal detected).',
                        );
                    }

                    // §1 the treasury debit that was missing: guarded so the
                    // business cannot overdraw (invoice balanceClaim pattern).
                    const debit = await tx.user.updateMany({
                        where: { id: business.userId, availableBalance: { gte: withdrawAmount } },
                        data: { availableBalance: { decrement: withdrawAmount } },
                    });
                    if (debit.count !== 1) {
                        throw ewaRefusal(
                            'Business treasury has insufficient spendable balance for this EWA withdrawal; it was not executed.',
                            'EWA_INSUFFICIENT_BUSINESS_FUNDS',
                        );
                    }

                    // Employee spendable credit — User.availableBalance ONLY.
                    // azmBalance is a loyalty-points ledger and must never
                    // receive EWA money.
                    await tx.user.update({
                        where: { id: employee.userId },
                        data: {
                            availableBalance: { increment: netToEmployee },
                        },
                    });

                    // §4 platform fee realized through the established platform
                    // fee mechanism (invoice pattern): SystemProfitFees +
                    // AdminProfitLog + the authoritative ledger line below.
                    if (fee.gt(ZERO)) {
                        await tx.systemProfitFees.upsert({
                            where: { id: 1 },
                            update: { balance: { increment: fee } },
                            create: { id: 1, balance: fee },
                        });
                    }

                    const historyRow = await tx.transactionHistory.create({
                        data: {
                            userId: employee.userId,
                            type: 'EWA_WITHDRAWAL',
                            amountUsdc: netToEmployee,
                            feeUsdc: fee,
                            txHash,
                            status: 'COMPLETED',
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount.toFixed(8),
                                fee: fee.toFixed(8),
                                netToEmployee: netToEmployee.toFixed(8),
                                destination: 'AZAMAN_BALANCE',
                                source: 'BUSINESS_OS_EWA',
                            },
                        },
                    });

                    if (fee.gt(ZERO)) {
                        await tx.adminProfitLog.create({
                            data: {
                                source: 'EWA_FEE',
                                amountUsdc: fee,
                                relatedTxId: txHash || `EWA_HISTORY_${historyRow.id}`,
                            },
                        });
                    }

                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId: employee.businessProfileId,
                            type: 'PAYROLL',
                            category: 'EWA Withdrawal',
                            description: `EWA withdrawal by employee ${employeeId}`,
                            amount: withdrawAmount.negated(),
                            sourceType: 'EWA',
                            sourceId: employeeId,
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount.toFixed(8),
                                fee: fee.toFixed(8),
                                netToEmployee: netToEmployee.toFixed(8),
                                destination: 'AZAMAN_BALANCE',
                            },
                        },
                    });

                    // §P.4 AUTHORITATIVE LEDGER — same transaction, durable
                    // economic identity (unique idempotencyKey):
                    //   D user:{businessOwner}:liability — treasury fronts gross X
                    //   C user:{employee}:liability   — employee receives X - F
                    //   C equity:treasury              — 1% fee realized
                    // X = (X - F) + F balances EXACTLY in Decimal arithmetic.
                    const ledgerLines = [
                        { account: `user:${business.userId}:liability`, debit: withdrawAmount.toFixed(8) },
                        { account: `user:${employee.userId}:liability`, credit: netToEmployee.toFixed(8) },
                    ];
                    if (fee.gt(ZERO)) {
                        ledgerLines.push({ account: 'equity:treasury', credit: fee.toFixed(8) });
                    }
                    await ledger.post(tx, {
                        idempotencyKey: txHash
                            ? `ledger:ewa:${txHash}`
                            : `ledger:ewa:withdraw:${historyRow.id}`,
                        entryType: 'BUSINESS_PAYMENT',
                        description: 'EWA withdrawal — liability moved business owner to employee, fee realized',
                        userId: employee.userId,
                        relatedEntity: 'businessEmployee',
                        relatedEntityId: employeeId,
                        metadata: {
                            grossAmount: withdrawAmount.toFixed(8),
                            fee: fee.toFixed(8),
                            netToEmployee: netToEmployee.toFixed(8),
                            destination: 'AZAMAN_BALANCE',
                        },
                        lines: ledgerLines,
                    });

                    const finalEmployee = scopedBusinessProfileId
                        ? await tx.businessEmployee.findFirst({
                            where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
                        })
                        : await tx.businessEmployee.findUnique({ where: { id: employeeId } });

                    // Response values are non-authoritative presentation (§6).
                    return {
                        success: true,
                        grossAmount: Number(withdrawAmount),
                        fee: Number(fee),
                        netToEmployee: Number(netToEmployee),
                        remainingWithdrawable: Number(Prisma.Decimal.max(ZERO, remaining.minus(withdrawAmount))),
                        employee: finalEmployee,
                    };
                }, { isolationLevel: 'Serializable' });
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
                    // ── Issue #330: post-outcome intent bookkeeping ──────
                    // Only a MARKED pre-commit refusal may retire the
                    // attempt as REFUSED (retry re-evaluates fresh — the
                    // existing "never replay a failure" contract is
                    // preserved). Every other outcome leaves the intent
                    // PENDING: durable, discoverable, reconcilable — never
                    // silently misclassified as refused or committed. This
                    // write is outside the rolled-back transaction and is
                    // best-effort: if it fails the intent stays PENDING,
                    // which is the conservative direction.
                    if (intent && error?.ewaPreCommitRefusal) {
                        try {
                            await this.prisma.ewaWithdrawalIntent.updateMany({
                                where: {
                                    id: intent.id,
                                    status: { in: [EWA_INTENT_STATUS.PENDING, EWA_INTENT_STATUS.REFUSED] },
                                },
                                data: {
                                    status: EWA_INTENT_STATUS.REFUSED,
                                    refusalMessage: String(error.message || '').slice(0, 500),
                                    resolvedAt: new Date(),
                                },
                            });
                        } catch (bookkeepingError) {
                            console.error('[EwaService] failed to record refusal on intent', bookkeepingError);
                        }
                    }
                    throw error;
                }
                await waitForSerializableRetry(attempt);
            }
        }

        throw new Error('EWA withdrawal failed after retries.');
    }

    // ── Issue #330: claim the durable server-side intent ─────────────────────
    // Registration is race-safe: the (employeeId, idempotencyKey) unique
    // constraint arbitrates concurrent first-claims — the loser re-reads.
    // Materially different reuse of the same key fails closed as
    // EWA_IDEMPOTENCY_CONFLICT and never touches the original intent.
    async _claimWithdrawalIntent({ employeeId, businessProfileId, idempotencyKey, amountExact, destination }) {
        try {
            return await this.prisma.ewaWithdrawalIntent.create({
                data: {
                    employeeId,
                    businessProfileId,
                    idempotencyKey,
                    amountExact,
                    destination,
                    status: EWA_INTENT_STATUS.PENDING,
                },
            });
        } catch (e) {
            if (e?.code !== 'P2002') throw e;
        }
        const existing = await this.prisma.ewaWithdrawalIntent.findUniqueOrThrow({
            where: { employeeId_idempotencyKey: { employeeId, idempotencyKey } },
        });
        const differing = [];
        if (existing.amountExact !== amountExact) differing.push('amount');
        if (existing.destination !== destination) differing.push('destination');
        if (differing.length > 0) {
            throw settlementError(
                'EWA_IDEMPOTENCY_CONFLICT',
                `Idempotency key was already used with different parameters (differing: ${differing.join(', ')}); the withdrawal was not executed.`,
            );
        }
        // Same economic identity. PENDING: in-flight or crashed — the
        // in-transaction guard is the single arbiter. REFUSED: the prior
        // attempt was authoritatively refused; a same-key retry still
        // re-evaluates fresh per the existing contract. COMMITTED: the
        // transaction below replays the committed outcome via the
        // txHash/committedTxHash anchor.
        return existing;
    }

    // ── Issue #330: cross-device recovery list ────────────────────────────────
    // Returns the employee's withdrawal intents (unresolved first) INCLUDING
    // the original idempotency key, so an authorized session on a second
    // device can retry the SAME identity instead of minting a new one.
    //
    // scope='business' (default): strict business-context isolation — the
    //   caller's resolved business context must own the employee; a foreign
    //   or absent context discloses nothing (empty list, never a hint).
    // scope='self': the worker self-service path — the route has already
    //   established that the authenticated user IS this employee.
    async getWithdrawalIntents(employeeId, { scope = 'business', limit = 20 } = {}) {
        if (scope !== 'self') {
            const scopedBusinessProfileId = this._resolveBusinessProfileId(undefined);
            if (!scopedBusinessProfileId) return [];
            const employee = await this.prisma.businessEmployee.findUnique({
                where: { id: employeeId },
                select: { id: true, businessProfileId: true },
            });
            if (!employee || employee.businessProfileId !== scopedBusinessProfileId) return [];
        }
        const intents = await this.prisma.ewaWithdrawalIntent.findMany({
            where: { employeeId },
            // Unresolved (PENDING) first, then REFUSED, then COMMITTED —
            // alphabetical DESC happens to be exactly PENDING, REFUSED,
            // COMMITTED — newest within each status.
            orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
            take: limit,
        });
        return intents.map((i) => ({
            id: i.id,
            status: i.status,
            idempotencyKey: i.idempotencyKey,
            amount: i.amountExact,
            destination: i.destination,
            committedTxHash: i.committedTxHash,
            refusalMessage: i.refusalMessage,
            createdAt: i.createdAt,
            resolvedAt: i.resolvedAt,
        }));
    }

    // ── Get EWA History ─────────────────────────────────────────────────────
    async getEwaHistory(employeeId, businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        const where = { sourceType: 'EWA', sourceId: employeeId };
        if (scopedBusinessProfileId) where.businessProfileId = scopedBusinessProfileId;
        return this.prisma.businessLedgerEntry.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    // ── Get EWA Summary for Business ───────────────────────────────────────
    async getEwaSummary(businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        if (!scopedBusinessProfileId) throw new Error('Business context required.');
        const employees = await this.prisma.businessEmployee.findMany({
            where: { businessProfileId: scopedBusinessProfileId, status: 'ACTIVE' },
            select: {
                id: true,
                accruedWages: true,
                withdrawnEarly: true,
                user: { select: { username: true } },
            },
        });

        let totalAccrued = new Prisma.Decimal(0);
        let totalWithdrawn = new Prisma.Decimal(0);
        for (const e of employees) {
            totalAccrued = totalAccrued.plus(new Prisma.Decimal(e.accruedWages));
            totalWithdrawn = totalWithdrawn.plus(new Prisma.Decimal(e.withdrawnEarly));
        }

        return {
            totalEmployees: employees.length,
            totalAccrued: Number(totalAccrued),
            totalWithdrawn: Number(totalWithdrawn),
            totalOutstanding: Number(totalAccrued.minus(totalWithdrawn)),
            employees: employees.map(e => {
                const accrued = new Prisma.Decimal(e.accruedWages);
                const withdrawn = new Prisma.Decimal(e.withdrawnEarly);
                return {
                    id: e.id,
                    username: e.user.username,
                    accrued: Number(accrued),
                    withdrawn: Number(withdrawn),
                    available: Number(Prisma.Decimal.max(ZERO, accrued.mul(EWA_CAP_RATE).minus(withdrawn))),
                };
            }),
        };
    }
}

module.exports = { EwaService };
