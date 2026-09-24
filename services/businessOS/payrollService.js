// 📁 services/businessOS/payrollService.js
// services/businessOS/payrollService.js
// =============================================================================
// Payroll Service — process payroll for employees, integrate with Smart Routes
// for automatic disbursement, and track payroll history.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { getRequestContext } = require('../../utils/requestContext');
const ledger = require('../ledgerService');

// Typed settlement errors (fail-closed): callers can branch on .code; every
// one leaves the payroll record PENDING — money never moves half-way.
const settlementError = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
// r39/P1 — the snapshot authority is now EXACT money. Both sides are
// computed by the same Decimal-native function from the same DB inputs,
// so float tolerance is gone: an 8dp-exact mismatch means the inputs
// really changed and the record must be regenerated.
const MONEY_SCALE = 8;
const HOURS_SCALE = 2;
const exactMoneyEq = (left, right) => toDecimal(left).toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE)
    === toDecimal(right).toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE);
const exactHoursEq = (left, right) => toDecimal(left).toDecimalPlaces(HOURS_SCALE).toFixed(HOURS_SCALE)
    === toDecimal(right).toDecimalPlaces(HOURS_SCALE).toFixed(HOURS_SCALE);

const isSerializableConflict = (error) => error?.code === 'P2034';

const waitForSerializableRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt));
});

// r39/P1: replaced by exactMoneyEq / exactHoursEq — see above.

const { calculatePayroll, toDecimal } = require('../../utils/payrollMath');

class PayrollService {
    constructor(prisma) { this.prisma = prisma; }

    async _resolveCallerBusinessProfileId(explicitBusinessProfileId) {
        if (explicitBusinessProfileId) return explicitBusinessProfileId;
        const req = getRequestContext();
        if (req?.businessProfileId) return req.businessProfileId;
        if (!req?.user?.id) return null;
        const ownedBusiness = await this.prisma.businessProfile.findFirst({ where: { userId: req.user.id }, select: { id: true } });
        if (ownedBusiness?.id) return ownedBusiness.id;
        const employee = await this.prisma.businessEmployee.findFirst({ where: { userId: req.user.id, status: 'ACTIVE' }, select: { businessProfileId: true } });
        return employee?.businessProfileId || null;
    }

    // Re-read the immutable payroll inputs inside the disbursement transaction.
    // Payroll records are prepared ahead of payment, while clock-out and EWA
    // mutations can legitimately occur between preparation and settlement. A
    // stale record must never move money; the caller can regenerate the pending
    // payroll record from the current period inputs instead.
    async _getCurrentPayrollSnapshot(tx, payroll) {
        const period = String(payroll.period || '');
        const match = /^(\d{4})-(\d{2})$/.exec(period);
        if (!match) throw new Error(`Invalid payroll period: ${period}`);

        const year = Number(match[1]);
        const month = Number(match[2]);
        const periodStart = new Date(year, month - 1, 1);
        const periodEnd = new Date(year, month, 0, 23, 59, 59);
        const shifts = await tx.shift.findMany({
            where: {
                employeeId: payroll.employeeId,
                businessProfileId: payroll.businessProfileId,
                shiftDate: { gte: periodStart, lte: periodEnd },
                status: 'CLOCKED_OUT',
            },
            select: { actualMinutes: true, breakMinutes: true },
        });

        const employee = payroll.employee || {};
        const payrollType = employee.payrollType || payroll.payrollType;
        // r39/P1 — exact-money computation via the shared Decimal-native
        // util (single implementation with processEmployeePayroll). Never
        // parseFloat a Decimal column; round once at the 8dp authority.
        const exact = calculatePayroll({ ...employee, payrollType }, shifts);

        return {
            baseAmount: exact.baseAmount,
            overtimeAmount: exact.overtimeAmount,
            grossAmount: exact.grossAmount,
            ewaDeduction: exact.ewaDeduction,
            netAmount: exact.netAmount,
            totalHours: exact.totalHours,
            overtimeHours: exact.overtimeHours,
            shiftCount: exact.shiftCount,
        };
    }

    _assertPayrollSnapshotCurrent(payroll, current) {
        const recordedBreakdown = payroll.breakdown && typeof payroll.breakdown === 'object'
            ? payroll.breakdown
            : {};
        const recordedShiftCount = Number(recordedBreakdown.shifts);

        const matches = (
            exactMoneyEq(payroll.baseAmount, current.baseAmount)
            && exactMoneyEq(payroll.overtimeAmount, current.overtimeAmount)
            && exactMoneyEq(payroll.grossAmount, current.grossAmount)
            && exactMoneyEq(payroll.ewaDeduction, current.ewaDeduction)
            && exactMoneyEq(payroll.netAmount, current.netAmount)
            && exactHoursEq(payroll.totalHours, current.totalHours)
            && exactHoursEq(payroll.overtimeHours, current.overtimeHours)
            && (!Number.isFinite(recordedShiftCount) || recordedShiftCount === current.shiftCount)
        );

        if (!matches) {
            throw new Error(`Payroll for period ${payroll.period} is stale; regenerate it before disbursement.`);
        }
    }

    // ── Process Payroll for a Single Employee ──────────────────────────────
    async processEmployeePayroll({ businessProfileId, employeeId, period }) {
        const employee = await this.prisma.businessEmployee.findUnique({ where: { id: employeeId } });
        if (!employee) throw new Error('Employee not found.');
        if (employee.businessProfileId !== businessProfileId) throw new Error('Employee does not belong to this business.');
        if (employee.status !== 'ACTIVE' && employee.status !== 'ON_LEAVE') throw new Error('Employee is not active.');

        const existing = await this.prisma.payrollRecord.findUnique({ where: { employeeId_period: { employeeId, period } } });
        if (existing && existing.status === 'PROCESSED') throw new Error(`Payroll for period ${period} already processed.`);

        const [year, month] = period.split('-').map(Number);
        const periodStart = new Date(year, month - 1, 1);
        const periodEnd = new Date(year, month, 0, 23, 59, 59);
        const shifts = await this.prisma.shift.findMany({ where: { employeeId, shiftDate: { gte: periodStart, lte: periodEnd }, status: 'CLOCKED_OUT' } });

        // r39/P1 — exact-money computation via the shared Decimal-native
        // util (single implementation with _calculatePayrollBreakdown).
        // Money fields are exact 8dp Decimals; persisted directly into the
        // DECIMAL(20,8) columns. Hours are informational 2dp quantities.
        const exact = calculatePayroll(employee, shifts);
        const {
            grossAmount, netAmount, baseAmount, overtimeAmount, ewaDeduction,
            taxAmount, deductionAmount, totalHours, overtimeHours, regularHours, shiftCount,
        } = exact;
        // Breakdown carries the informational hour quantities as plain
        // numbers (2dp-exact display values) and the EWA deduction as its
        // exact 8dp string — never a float mirror of money authority.
        const breakdown = {
            shifts: shiftCount,
            regularHours: Number(regularHours.toFixed(2)),
            overtimeHours: Number(overtimeHours.toFixed(2)),
            ewaWithdrawn: ewaDeduction.toFixed(8),
        };

        return this.prisma.payrollRecord.upsert({
            where: { employeeId_period: { employeeId, period } },
            create: {
                businessProfileId, employeeId, userId: employee.userId, period, payrollType: employee.payrollType,
                grossAmount, netAmount, baseAmount, overtimeAmount, ewaDeduction, taxAmount, deductionAmount,
                totalHours, overtimeHours,
                status: 'PENDING',
                breakdown,
            },
            update: {
                grossAmount, netAmount, baseAmount, overtimeAmount, ewaDeduction, taxAmount, deductionAmount,
                totalHours, overtimeHours,
                breakdown,
            },
        });
    }

    async processAllPayroll(businessProfileId, period) {
        const employees = await this.prisma.businessEmployee.findMany({ where: { businessProfileId, status: { in: ['ACTIVE', 'ON_LEAVE'] } } });
        const results = [];
        for (const employee of employees) {
            try {
                results.push({ employeeId: employee.id, status: 'success', payroll: await this.processEmployeePayroll({ businessProfileId, employeeId: employee.id, period }) });
            } catch (err) {
                results.push({ employeeId: employee.id, status: 'error', error: err.message });
            }
        }
        return results;
    }

    // ── Disburse Payroll (execute payment) ─────────────────────────────────
    async disbursePayroll(payrollId, businessProfileId) {
        const scopedBusinessProfileId = await this._resolveCallerBusinessProfileId(businessProfileId);
        if (!scopedBusinessProfileId) throw new Error('Business context required.');

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const payroll = await tx.payrollRecord.findFirst({
                        where: { id: payrollId, businessProfileId: scopedBusinessProfileId },
                        include: { employee: true },
                    });
                    if (!payroll) throw new Error('Payroll record not found.');
                    if (payroll.status === 'PROCESSED') throw new Error('Payroll already disbursed.');
                    if (payroll.employee.businessProfileId !== scopedBusinessProfileId || payroll.employee.businessProfileId !== payroll.businessProfileId) {
                        throw new Error('Payroll employee does not belong to this business.');
                    }

                    const current = await this._getCurrentPayrollSnapshot(tx, payroll);
                    this._assertPayrollSnapshotCurrent(payroll, current);

                    if (payroll.employee.smartRouteId) throw new Error('Payroll with Smart Route requires the payroll settlement worker; it was not marked as paid.');

                    // §3 EXTERNAL PREFERENCES FAIL CLOSED: the enum exists, but
                    // only AZAMAN_BALANCE has an authoritative internal
                    // settlement path. MOMO/WALLET/SPLIT must be carried by a
                    // complete, crash-safe payout worker — never claimed here.
                    const paymentPreference = payroll.employee.paymentPreference || 'AZAMAN_BALANCE';
                    if (paymentPreference !== 'AZAMAN_BALANCE') {
                        throw settlementError(
                            'PAYROLL_EXTERNAL_PREFERENCE_UNSUPPORTED',
                            `Payroll payment preference ${paymentPreference} has no authoritative settlement path; it was not settled.`,
                        );
                    }

                    // §6 EXACT MONEY: the settlement amount is read from the
                    // Decimal column and carried as Prisma.Decimal end-to-end —
                    // never parseFloat'd. Floats are only used upstream in the
                    // (unchanged) payroll PREPARATION math; the persisted net and
                    // every financial write below are numerically identical.
                    const netExact = new Prisma.Decimal(payroll.netAmount);
                    if (!netExact.isFinite()) throw new Error('Payroll net amount is invalid.');

                    // §2 a negative net is an overpayment/debt state — it must
                    // STOP for reconciliation, never be erased as "processed".
                    if (netExact.isNegative()) {
                        throw settlementError(
                            'PAYROLL_NEGATIVE_NET',
                            `Payroll net for period ${payroll.period} is negative after deductions — regenerate the payroll record; it was not settled.`,
                        );
                    }

                    // §9 destination identity: the payroll's user must be the employee's user
                    if (payroll.userId !== payroll.employee.userId) {
                        throw new Error('Payroll destination does not match the employee user.');
                    }

                    // §1 treasury source: the business owner's spendable balance
                    // (same owner-balance model as the hardened invoice path).
                    const business = await tx.businessProfile.findUnique({
                        where: { id: payroll.businessProfileId },
                        select: { userId: true },
                    });
                    if (!business) throw new Error('Business profile not found.');

                    // Ownership claim FIRST (invoice payTxHash CAS pattern): the
                    // conditional PENDING→PROCESSED flip serializes concurrent
                    // disbursers on the row — exactly one disbursement can pay.
                    // The whole transaction rolls back (back to PENDING) if any
                    // later financial/accounting write fails.
                    const claim = await tx.payrollRecord.updateMany({
                        where: { id: payrollId, businessProfileId: scopedBusinessProfileId, status: 'PENDING' },
                        data: { status: 'PROCESSED', paidAt: new Date(), failureReason: null, transactionHash: `PAYROLL_${payrollId}` },
                    });
                    if (claim.count !== 1) throw new Error('Payroll already disbursed or not pending.');

                    if (netExact.isZero()) {
                        // §2 zero net: the gross was completely satisfied by prior
                        // EWA (or nothing was earned). Finalize with an explicit
                        // non-financial settlement reason — NO fabricated
                        // zero-value ledger posting (the ledger rejects zero
                        // lines) and NO balance movement.
                        const grossExact = new Prisma.Decimal(payroll.grossAmount);
                        const settlementReason = grossExact.isPositive()
                            ? 'ZERO_NET_SATISFIED_BY_EWA'
                            : 'ZERO_NET_NO_EARNINGS';
                        await tx.payrollRecord.update({
                            where: { id: payrollId },
                            data: { breakdown: { ...((payroll.breakdown && typeof payroll.breakdown === 'object') ? payroll.breakdown : {}), settlementReason } },
                        });
                        // §8 accrued/withdrawn state resets exactly once, only on
                        // successful final settlement (zero-net included).
                        await tx.businessEmployee.update({ where: { id: payroll.employeeId }, data: { accruedWages: new Prisma.Decimal(0), withdrawnEarly: new Prisma.Decimal(0) } });
                        return tx.payrollRecord.findUnique({ where: { id: payrollId }, include: { employee: true } });
                    }

                    // Guarded treasury debit — the business cannot overdraw:
                    // the conditional UPDATE serializes concurrent business
                    // spending on the owner row (invoice balanceClaim pattern).
                    const debit = await tx.user.updateMany({
                        where: { id: business.userId, availableBalance: { gte: netExact } },
                        data: { availableBalance: { decrement: netExact } },
                    });
                    if (debit.count !== 1) {
                        throw settlementError(
                            'PAYROLL_INSUFFICIENT_BUSINESS_FUNDS',
                            'Business treasury has insufficient spendable balance for this payroll; it was not settled.',
                        );
                    }

                    // Employee spendable credit — User.availableBalance ONLY.
                    // azmBalance is a loyalty-points ledger and must never
                    // receive payroll money.
                    await tx.user.update({
                        where: { id: payroll.userId },
                        data: { availableBalance: { increment: netExact } },
                    });

                    // Signed economic history — BOTH sides (invoice convention).
                    await tx.transactionHistory.create({
                        data: {
                            userId: business.userId,
                            type: 'PAYROLL_DISBURSEMENT',
                            amountUsdc: netExact.negated(),
                            feeUsdc: new Prisma.Decimal(0),
                            txHash: `PAYROLL_${payrollId}_OWNER`,
                            status: 'COMPLETED',
                            metadata: { role: 'business_treasury', employeeId: payroll.employeeId, period: payroll.period, payrollId, source: 'BUSINESS_OS_PAYROLL' },
                        },
                    });
                    await tx.transactionHistory.create({
                        data: {
                            userId: payroll.userId,
                            type: 'PAYROLL_DISBURSEMENT',
                            amountUsdc: netExact,
                            feeUsdc: new Prisma.Decimal(0),
                            txHash: `PAYROLL_${payrollId}_EMPLOYEE`,
                            status: 'COMPLETED',
                            metadata: { role: 'employee', employeeId: payroll.employeeId, period: payroll.period, payrollId, source: 'BUSINESS_OS_PAYROLL' },
                        },
                    });

                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId: payroll.businessProfileId,
                            type: 'PAYROLL',
                            category: 'Salary Payment',
                            description: `Payroll for ${payroll.period}`,
                            amount: netExact.negated(),
                            sourceType: 'PAYROLL',
                            sourceId: payrollId,
                            metadata: { employeeId: payroll.employeeId, period: payroll.period, netUsdc: netExact.toFixed(8) },
                        },
                    });

                    // §P.4 AUTHORITATIVE LEDGER — same transaction, durable
                    // economic identity (unique idempotencyKey; the claim above
                    // guarantees exactly one posting can ever exist):
                    //   D user:{businessOwner}:liability — treasury pays the wage
                    //   C user:{employee}:liability   — employee receives spendable
                    await ledger.post(tx, {
                        idempotencyKey: `ledger:payroll:disburse:${payrollId}`,
                        entryType: 'BUSINESS_PAYMENT',
                        description: 'Business payroll settlement — liability moved business owner to employee',
                        userId: business.userId,
                        relatedEntity: 'payrollRecord',
                        relatedEntityId: payrollId,
                        metadata: {
                            period: payroll.period,
                            employeeId: payroll.employeeId,
                            netUsdc: netExact.toFixed(8),
                        },
                        lines: [
                            { account: `user:${business.userId}:liability`, debit: netExact.toFixed(8) },
                            { account: `user:${payroll.userId}:liability`, credit: netExact.toFixed(8) },
                        ],
                    });

                    // §8 accrued/withdrawn state resets exactly once, only after
                    // every financial and accounting write above succeeded.
                    await tx.businessEmployee.update({ where: { id: payroll.employeeId }, data: { accruedWages: new Prisma.Decimal(0), withdrawnEarly: new Prisma.Decimal(0) } });
                    return tx.payrollRecord.findUnique({ where: { id: payrollId }, include: { employee: true } });
                }, { isolationLevel: 'Serializable' });
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
                    throw error;
                }
                await waitForSerializableRetry(attempt);
            }
        }

        throw new Error('Payroll disbursement failed after retries.');
    }

    async disburseAllPayroll(businessProfileId, period) {
        const records = await this.prisma.payrollRecord.findMany({ where: { businessProfileId, period, status: 'PENDING' } });
        const results = [];
        for (const record of records) {
            try {
                await this.disbursePayroll(record.id, businessProfileId);
                results.push({ payrollId: record.id, status: 'success' });
            } catch (err) {
                results.push({ payrollId: record.id, status: 'error', error: err.message });
            }
        }
        return results;
    }

    async getPayrollRecords(businessProfileId, { period, employeeId, status } = {}) {
        const where = { businessProfileId };
        if (period) where.period = period;
        if (employeeId) where.employeeId = employeeId;
        if (status) where.status = status;
        return this.prisma.payrollRecord.findMany({ where, include: { employee: { include: { user: { select: { username: true, email: true } } } } }, orderBy: { period: 'desc' } });
    }

    async getPayrollSummary(businessProfileId, period) {
        const records = await this.prisma.payrollRecord.findMany({ where: { businessProfileId, period } });
        return {
            period,
            totalEmployees: records.length,
            // r39/P1 — aggregate sums are exact Decimal reductions at the
            // 8dp authority, never float accumulation.
            totalGross: records.reduce((s, r) => s.plus(toDecimal(r.grossAmount)), new Prisma.Decimal(0)),
            totalNet: records.reduce((s, r) => s.plus(toDecimal(r.netAmount)), new Prisma.Decimal(0)),
            totalEwa: records.reduce((s, r) => s.plus(toDecimal(r.ewaDeduction)), new Prisma.Decimal(0)),
            totalOvertime: records.reduce((s, r) => s.plus(toDecimal(r.overtimeAmount)), new Prisma.Decimal(0)),
            pending: records.filter(r => r.status === 'PENDING').length,
            processed: records.filter(r => r.status === 'PROCESSED').length,
            failed: records.filter(r => r.status === 'FAILED').length,
        };
    }
}

module.exports = { PayrollService };