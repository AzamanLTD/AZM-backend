// utils/payrollMath.js
// =============================================================================
// Pure functions for payroll computation.
// Extracted from services/businessOS/payrollService.js so the math is
// testable without a database.
//
// Supports SALARY and HOURLY payroll types. Overtime is 1.5x for hours
// beyond 8 per shift. EWA deductions subtract from net pay.
//
// r39/P1 (repo-wide financial arithmetic sweep) — EXACT MONEY CONTRACT:
// every monetary field (base, overtime, gross, net, EWA deduction) is
// computed with Prisma.Decimal from the exact persisted inputs — never
// parseFloat, never binary-float multiply/add. Rounding happens ONCE, at
// the 8dp ledger authority (HALF_UP), matching the DECIMAL(20,8) columns.
// Hours are informational quantities and are reported at 2dp.
//
// The integer-minute core makes the math exact by construction: base pay
// is rate × (total worked minutes)/60 rounded once; the overtime bonus is
// rate × (total overtime minutes)/120 rounded once.
// =============================================================================
const { Prisma } = require('@prisma/client');

const ZERO = new Prisma.Decimal(0);
const MONEY_SCALE = 8;
const HOURS_SCALE = 2;
const OVERTIME_THRESHOLD_MINUTES = 480; // 8h

// Exact Decimal from any persisted representation (Decimal | string | number).
const toDecimal = (value) => {
    if (value == null || value === '') return ZERO;
    if (value instanceof Prisma.Decimal) return value;
    return new Prisma.Decimal(String(value));
};

const money = (d) => d.toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
const hours = (d) => d.toDecimalPlaces(HOURS_SCALE, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Calculate payroll for a single employee from their shift records.
 *
 * @param {object} employee - { payrollType, salaryAmount, hourlyRate, withdrawnEarly }
 * @param {Array} shifts - Array of { actualMinutes, breakMinutes }
 * @returns {object} Decimal money fields ({ grossAmount, netAmount, baseAmount,
 *   overtimeAmount, ewaDeduction, taxAmount, deductionAmount }) and Decimal
 *   2dp hour quantities ({ totalHours, overtimeHours, regularHours }) plus
 *   shiftCount. Money fields are exact at 8dp — persist and compare as-is.
 */
function calculatePayroll(employee, shifts = []) {
  const workedMinutesOf = (s) => Math.max(0, (s.actualMinutes || 0) - (s.breakMinutes || 0));
  const sumWorkedMinutes = shifts.reduce((sum, s) => sum + workedMinutesOf(s), 0);
  const overtimeMinutes = shifts.reduce(
    (sum, s) => sum + Math.max(0, workedMinutesOf(s) - OVERTIME_THRESHOLD_MINUTES),
    0
  );

  const payrollType = employee && employee.payrollType;
  const ewaDeduction = toDecimal(employee && employee.withdrawnEarly);
  const taxAmount = ZERO;
  const deductionAmount = ZERO;

  let baseAmount = ZERO;
  if (payrollType === 'SALARY') {
    baseAmount = money(toDecimal(employee && employee.salaryAmount));
  } else if (payrollType === 'HOURLY') {
    const rate = toDecimal(employee && employee.hourlyRate);
    // Full rate for every worked minute; ONE division, ONE 8dp rounding.
    baseAmount = money(rate.times(sumWorkedMinutes).div(60));
  }

  // Overtime bonus: 0.5x on top of the regular rate already in baseAmount.
  // HOURLY only — salary employees have no hourly rate.
  let overtimeAmount = ZERO;
  if (payrollType === 'HOURLY') {
    const rate = toDecimal(employee && employee.hourlyRate);
    overtimeAmount = money(rate.times(overtimeMinutes).div(120));
  }

  const grossAmount = baseAmount.plus(overtimeAmount);
  const netAmount = grossAmount.minus(ewaDeduction).minus(taxAmount).minus(deductionAmount);

  const totalHours = hours(new Prisma.Decimal(sumWorkedMinutes).div(60));
  const overtimeHours = hours(new Prisma.Decimal(overtimeMinutes).div(60));
  const regularHours = totalHours.minus(overtimeHours);

  return {
    grossAmount,
    netAmount,
    baseAmount,
    overtimeAmount,
    ewaDeduction,
    taxAmount,
    deductionAmount,
    totalHours,
    overtimeHours,
    regularHours,
    shiftCount: shifts.length,
  };
}

module.exports = { calculatePayroll, toDecimal, money, hours };
