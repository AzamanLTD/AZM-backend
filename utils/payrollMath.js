// utils/payrollMath.js
// =============================================================================
// Pure functions for payroll computation.
// Extracted from services/businessOS/payrollService.js so the math is
// testable without a database.
//
// Supports SALARY and HOURLY payroll types. Overtime is 1.5x for hours
// beyond 8 per shift. EWA deductions subtract from net pay.
// =============================================================================

/**
 * Calculate payroll for a single employee from their shift records.
 *
 * @param {object} employee - { payrollType, salaryAmount, hourlyRate, withdrawnEarly }
 * @param {Array} shifts - Array of { actualMinutes, breakMinutes }
 * @returns {object} - { grossAmount, netAmount, baseAmount, overtimeAmount, ewaDeduction, totalHours, overtimeHours, regularHours }
 */
function calculatePayroll(employee, shifts = []) {
  const payrollType = employee.payrollType;
  let baseAmount = 0;
  let totalHours = 0;
  let overtimeHours = 0;

  if (payrollType === 'SALARY') {
    baseAmount = parseFloat(employee.salaryAmount) || 0;
    // Hours are informational for salary employees
    totalHours = shifts.reduce((sum, s) => {
      if (s.actualMinutes) {
        return sum + Math.max(0, (s.actualMinutes - (s.breakMinutes || 0)) / 60);
      }
      return sum;
    }, 0);
  } else if (payrollType === 'HOURLY') {
    const rate = parseFloat(employee.hourlyRate) || 0;
    shifts.forEach(s => {
      if (s.actualMinutes) {
        const workedHours = Math.max(0, (s.actualMinutes - (s.breakMinutes || 0)) / 60);
        totalHours += workedHours;
        const dailyOvertime = Math.max(0, workedHours - 8);
        overtimeHours += dailyOvertime;
        baseAmount += workedHours * rate;
      }
    });
  }

  // Overtime bonus: 0.5x on top of the regular rate already in baseAmount
  const hourlyRate = parseFloat(employee.hourlyRate) || 0;
  const overtimeAmount = overtimeHours * hourlyRate * 0.5;

  // EWA deduction
  const ewaDeduction = parseFloat(employee.withdrawnEarly) || 0;

  // Tax and other deductions (placeholders — currently 0)
  const taxAmount = 0;
  const deductionAmount = 0;

  const grossAmount = parseFloat((baseAmount + overtimeAmount).toFixed(6));
  const netAmount = parseFloat((grossAmount - ewaDeduction - taxAmount - deductionAmount).toFixed(6));

  return {
    grossAmount,
    netAmount,
    baseAmount: parseFloat(baseAmount.toFixed(6)),
    overtimeAmount: parseFloat(overtimeAmount.toFixed(6)),
    ewaDeduction: parseFloat(ewaDeduction.toFixed(6)),
    taxAmount,
    deductionAmount,
    totalHours: Math.round(totalHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
    regularHours: Math.round((totalHours - overtimeHours) * 100) / 100,
  };
}

module.exports = { calculatePayroll };
