// __tests__/financial-calculations.test.js
// =============================================================================
// Financial calculation tests — the highest-priority testing gap per
// ENTERPRISE_READINESS.md.
//
// Covers: invoice tax-line math, payroll computation, withdrawal exit fee +
// influencer split, escrow fee, and fee profile context matching.
// These are pure-math tests — no database required.
// =============================================================================

const {
  computeLineItems,
  computeTaxLines,
  computeInvoiceTotals,
} = require('../utils/invoiceMath');
const { calculatePayroll } = require('../utils/payrollMath');
const { calculateExitFee, getFeeDiscountMultiplier, EXIT_FEE_PERCENT } = require('../utils/withdrawalMath');
const { calculateEscrowFee, SMART_ESCROW_FEE_PCT_DEFAULT } = require('../utils/escrowMath');
const { calculateFeeSplit } = require('../utils/feeMath');

const EPSILON = 5e-7;

// ─── INVOICE MATH ────────────────────────────────────────────────────────────

describe('Invoice: line item computation', () => {
  test('computes subtotal from multiple line items', () => {
    const items = [
      { description: 'Coffee', quantity: 3, unitPrice: 2.50 },
      { description: 'Cake', quantity: 1, unitPrice: 4.00 },
    ];
    const { subtotal, lineItems } = computeLineItems(items);
    expect(subtotal).toBe(11.50);
    expect(lineItems).toHaveLength(2);
    expect(lineItems[0].lineTotal).toBe(7.50);
    expect(lineItems[1].lineTotal).toBe(4.00);
  });

  test('defaults quantity to 1 when missing', () => {
    const { subtotal, lineItems } = computeLineItems([
      { description: 'Item', unitPrice: 10 },
    ]);
    expect(lineItems[0].quantity).toBe(1);
    expect(subtotal).toBe(10);
  });

  test('clamps quantity to minimum 1', () => {
    const { lineItems } = computeLineItems([
      { description: 'Item', quantity: 0, unitPrice: 5 },
    ]);
    expect(lineItems[0].quantity).toBe(1);
  });

  test('rejects empty line items', () => {
    expect(() => computeLineItems([])).toThrow('At least one line item');
  });

  test('rejects more than 50 line items', () => {
    const items = Array(51).fill({ description: 'X', quantity: 1, unitPrice: 1 });
    expect(() => computeLineItems(items)).toThrow('Maximum 50');
  });

  test('rejects negative unit price', () => {
    expect(() => computeLineItems([{ description: 'X', quantity: 1, unitPrice: -5 }])).toThrow('Invalid unitPrice');
  });

  test('rejects NaN unit price', () => {
    expect(() => computeLineItems([{ description: 'X', quantity: 1, unitPrice: 'abc' }])).toThrow('Invalid unitPrice');
  });

  test('truncates description to 200 chars', () => {
    const long = 'A'.repeat(300);
    const { lineItems } = computeLineItems([{ description: long, quantity: 1, unitPrice: 1 }]);
    expect(lineItems[0].description.length).toBe(200);
  });
});

describe('Invoice: tax line computation', () => {
  test('percentage tax computes correctly', () => {
    const { taxTotal, taxLines } = computeTaxLines(
      [{ name: 'VAT', type: 'PERCENTAGE', value: 15 }],
      100
    );
    expect(taxTotal).toBe(15);
    expect(taxLines[0].computedAmount).toBe(15);
  });

  test('flat tax computes correctly', () => {
    const { taxTotal, taxLines } = computeTaxLines(
      [{ name: 'Service Charge', type: 'FLAT', value: 5 }],
      100
    );
    expect(taxTotal).toBe(5);
    expect(taxLines[0].computedAmount).toBe(5);
  });

  test('multiple tax lines sum correctly', () => {
    const { taxTotal } = computeTaxLines(
      [
        { name: 'VAT', type: 'PERCENTAGE', value: 12.5 },
        { name: 'Service', type: 'FLAT', value: 3 },
        { name: 'Tourism', type: 'PERCENTAGE', value: 2 },
      ],
      200
    );
    // VAT: 200 * 0.125 = 25, Service: 3, Tourism: 200 * 0.02 = 4 → total 32
    expect(taxTotal).toBe(32);
  });

  test('empty tax lines returns zero', () => {
    const { taxTotal, taxLines } = computeTaxLines([], 100);
    expect(taxTotal).toBe(0);
    expect(taxLines).toHaveLength(0);
  });

  test('null tax lines returns zero', () => {
    const { taxTotal } = computeTaxLines(null, 100);
    expect(taxTotal).toBe(0);
  });

  test('rejects negative tax value', () => {
    expect(() => computeTaxLines([{ name: 'X', type: 'PERCENTAGE', value: -5 }], 100)).toThrow('Invalid tax value');
  });

  test('rejects empty tax name', () => {
    expect(() => computeTaxLines([{ name: '', type: 'PERCENTAGE', value: 5 }], 100)).toThrow('Tax line name');
  });

  test('defaults unknown type to PERCENTAGE', () => {
    const { taxLines } = computeTaxLines(
      [{ name: 'X', type: 'WEIRD', value: 10 }],
      100
    );
    expect(taxLines[0].type).toBe('PERCENTAGE');
    expect(taxLines[0].computedAmount).toBe(10);
  });
});

describe('Invoice: full invoice totals', () => {
  test('computes subtotal + tax → bill total', () => {
    const result = computeInvoiceTotals(
      [
        { description: 'Burger', quantity: 2, unitPrice: 12.50 },
        { description: 'Fries', quantity: 1, unitPrice: 5.00 },
      ],
      [{ name: 'VAT', type: 'PERCENTAGE', value: 15 }]
    );
    // Subtotal: 25 + 5 = 30, VAT: 30 * 0.15 = 4.5, Bill: 34.5
    expect(result.subtotal).toBe(30);
    expect(result.taxTotal).toBe(4.5);
    expect(result.billTotal).toBe(34.5);
  });

  test('conservation: subtotal + tax = bill total (always)', () => {
    const result = computeInvoiceTotals(
      [{ description: 'X', quantity: 7, unitPrice: 3.99 }],
      [
        { name: 'VAT', type: 'PERCENTAGE', value: 12.5 },
        { name: 'Flat', type: 'FLAT', value: 2.50 },
      ]
    );
    expect(Math.abs(result.subtotal + result.taxTotal - result.billTotal)).toBeLessThan(EPSILON);
  });
});

// ─── PAYROLL MATH ─────────────────────────────────────────────────────────────

describe('Payroll: salary employee', () => {
  test('salary employee gets fixed gross regardless of hours', () => {
    const employee = {
      payrollType: 'SALARY',
      salaryAmount: 2000,
      hourlyRate: 0,
      withdrawnEarly: 0,
    };
    const shifts = [
      { actualMinutes: 480, breakMinutes: 60 }, // 7h worked
      { actualMinutes: 500, breakMinutes: 60 }, // 7.33h worked
    ];
    const result = calculatePayroll(employee, shifts);
    expect(result.grossAmount).toBe(2000);
    expect(result.netAmount).toBe(2000);
    expect(result.overtimeAmount).toBe(0);
    expect(result.totalHours).toBe(14.33);
  });

  test('salary with EWA deduction reduces net', () => {
    const result = calculatePayroll(
      { payrollType: 'SALARY', salaryAmount: 1500, hourlyRate: 0, withdrawnEarly: 200 },
      []
    );
    expect(result.grossAmount).toBe(1500);
    expect(result.ewaDeduction).toBe(200);
    expect(result.netAmount).toBe(1300);
  });
});

describe('Payroll: hourly employee', () => {
  const hourlyEmployee = {
    payrollType: 'HOURLY',
    salaryAmount: 0,
    hourlyRate: 15,
    withdrawnEarly: 0,
  };

  test('regular hours compute correctly (no overtime)', () => {
    const shifts = [
      { actualMinutes: 480, breakMinutes: 60 }, // 7h worked, no OT
    ];
    const result = calculatePayroll(hourlyEmployee, shifts);
    expect(result.totalHours).toBe(7);
    expect(result.overtimeHours).toBe(0);
    expect(result.baseAmount).toBe(105); // 7 * 15
    expect(result.overtimeAmount).toBe(0);
    expect(result.grossAmount).toBe(105);
    expect(result.netAmount).toBe(105);
  });

  test('overtime at 1.5x for hours beyond 8 per shift', () => {
    const shifts = [
      { actualMinutes: 600, breakMinutes: 60 }, // 9h worked → 1h OT
    ];
    const result = calculatePayroll(hourlyEmployee, shifts);
    expect(result.totalHours).toBe(9);
    expect(result.overtimeHours).toBe(1);
    // Base = 9 * 15 = 135 (at regular rate)
    // OT bonus = 1 * 15 * 0.5 = 7.5
    expect(result.baseAmount).toBe(135);
    expect(result.overtimeAmount).toBe(7.5);
    expect(result.grossAmount).toBe(142.5);
    expect(result.netAmount).toBe(142.5);
  });

  test('multiple shifts with mixed overtime', () => {
    const shifts = [
      { actualMinutes: 480, breakMinutes: 60 },  // 7h → 0 OT
      { actualMinutes: 600, breakMinutes: 60 },  // 9h → 1 OT
      { actualMinutes: 720, breakMinutes: 60 },  // 11h → 3 OT
    ];
    const result = calculatePayroll(hourlyEmployee, shifts);
    expect(result.totalHours).toBe(27);
    expect(result.overtimeHours).toBe(4);
    // Base = 27 * 15 = 405
    // OT bonus = 4 * 15 * 0.5 = 30
    expect(result.baseAmount).toBe(405);
    expect(result.overtimeAmount).toBe(30);
    expect(result.grossAmount).toBe(435);
  });

  test('hourly with EWA deduction', () => {
    const result = calculatePayroll(
      { ...hourlyEmployee, withdrawnEarly: 50 },
      [{ actualMinutes: 480, breakMinutes: 60 }] // 7h → 105 gross
    );
    expect(result.grossAmount).toBe(105);
    expect(result.ewaDeduction).toBe(50);
    expect(result.netAmount).toBe(55);
  });

  test('shift with no actualMinutes contributes 0 hours', () => {
    const shifts = [
      { actualMinutes: 480, breakMinutes: 60 },
      { actualMinutes: null, breakMinutes: 0 },
    ];
    const result = calculatePayroll(hourlyEmployee, shifts);
    expect(result.totalHours).toBe(7);
    expect(result.grossAmount).toBe(105);
  });

  test('break minutes reduce worked hours', () => {
    const result = calculatePayroll(hourlyEmployee, [
      { actualMinutes: 600, breakMinutes: 120 }, // (600-120)/60 = 8h → 0 OT
    ]);
    expect(result.totalHours).toBe(8);
    expect(result.overtimeHours).toBe(0);
  });
});

describe('Payroll: conservation invariants', () => {
  test('gross = base + overtime (always)', () => {
    const cases = [
      { payrollType: 'SALARY', salaryAmount: 2000, hourlyRate: 0, withdrawnEarly: 0 },
      { payrollType: 'HOURLY', salaryAmount: 0, hourlyRate: 12, withdrawnEarly: 0 },
      { payrollType: 'HOURLY', salaryAmount: 0, hourlyRate: 20, withdrawnEarly: 100 },
    ];
    const shiftSets = [
      [{ actualMinutes: 480, breakMinutes: 60 }],
      [{ actualMinutes: 720, breakMinutes: 0 }],
      [],
    ];
    for (const emp of cases) {
      for (const shifts of shiftSets) {
        const r = calculatePayroll(emp, shifts);
        expect(Math.abs(r.baseAmount + r.overtimeAmount - r.grossAmount)).toBeLessThan(EPSILON);
      }
    }
  });

  test('net = gross − EWA deduction (always)', () => {
    const emp = { payrollType: 'HOURLY', salaryAmount: 0, hourlyRate: 15, withdrawnEarly: 75 };
    const r = calculatePayroll(emp, [{ actualMinutes: 480, breakMinutes: 60 }]);
    expect(Math.abs(r.grossAmount - r.ewaDeduction - r.netAmount)).toBeLessThan(EPSILON);
  });
});

// ─── WITHDRAWAL EXIT FEE ──────────────────────────────────────────────────────

describe('Withdrawal: exit fee computation', () => {
  test('default 2% exit fee with no referrer', () => {
    const result = calculateExitFee(1000);
    expect(result.exitFee).toBe(20);       // 2% of 1000
    expect(result.netToUser).toBe(980);    // 98% of 1000
    expect(result.influencerCut).toBe(0);  // no referrer
    expect(result.platformCut).toBe(20);   // full fee to platform
    expect(result.feePctUsed).toBe(0.02);
  });

  test('2% exit fee with referrer splits 50/50', () => {
    const result = calculateExitFee(1000, { hasReferrer: true });
    expect(result.exitFee).toBe(20);
    expect(result.influencerCut).toBe(10);  // 1% of 1000
    expect(result.platformCut).toBe(10);    // 1% of 1000
    expect(result.netToUser).toBe(980);
  });

  test('custom fee pct override', () => {
    const result = calculateExitFee(500, { feePctOverride: 0.05 });
    expect(result.exitFee).toBe(25);   // 5% of 500
    expect(result.netToUser).toBe(475);
  });

  test('AZM 25% fee discount reduces fee by 25%', () => {
    const result = calculateExitFee(1000, { feeDiscountMultiplier: 0.25 });
    // Effective fee = 2% * (1 - 0.25) = 1.5%
    expect(result.exitFee).toBe(15);
    expect(result.netToUser).toBe(985);
  });

  test('AZM 50% fee discount halves the fee', () => {
    const result = calculateExitFee(1000, { feeDiscountMultiplier: 0.50 });
    // Effective fee = 2% * (1 - 0.50) = 1%
    expect(result.exitFee).toBe(10);
    expect(result.netToUser).toBe(990);
  });

  test('AZM 100% fee discount = free withdrawal', () => {
    const result = calculateExitFee(1000, { feeDiscountMultiplier: 1.00 });
    expect(result.exitFee).toBe(0);
    expect(result.netToUser).toBe(1000);
    expect(result.influencerCut).toBe(0);
    expect(result.platformCut).toBe(0);
  });

  test('discount + referrer: both applied together', () => {
    const result = calculateExitFee(1000, { feeDiscountMultiplier: 0.50, hasReferrer: true });
    // Effective fee = 1% → 10 USDC → 5/5 split
    expect(result.exitFee).toBe(10);
    expect(result.influencerCut).toBe(5);
    expect(result.platformCut).toBe(5);
  });

  test('conservation: net + fee = gross (always)', () => {
    const amounts = [0.01, 50, 999.99, 5000, 123456.78];
    const opts = [
      {},
      { hasReferrer: true },
      { feeDiscountMultiplier: 0.25 },
      { feeDiscountMultiplier: 0.50, hasReferrer: true },
      { feeDiscountMultiplier: 1.0 },
    ];
    for (const amount of amounts) {
      for (const opt of opts) {
        const r = calculateExitFee(amount, opt);
        expect(Math.abs(r.netToUser + r.exitFee - amount)).toBeLessThan(EPSILON);
      }
    }
  });

  test('conservation: influencerCut + platformCut = exitFee (always)', () => {
    const cases = [
      { amount: 100, hasReferrer: true },
      { amount: 500, hasReferrer: false },
      { amount: 1000, feeDiscountMultiplier: 0.25, hasReferrer: true },
    ];
    for (const c of cases) {
      const r = calculateExitFee(c.amount, c);
      expect(Math.abs(r.influencerCut + r.platformCut - r.exitFee)).toBeLessThan(EPSILON);
    }
  });
});

describe('Withdrawal: fee discount tier lookup', () => {
  test('tier_25 → 25% discount', () => {
    expect(getFeeDiscountMultiplier('tier_25')).toBe(0.25);
  });
  test('tier_50 → 50% discount', () => {
    expect(getFeeDiscountMultiplier('tier_50')).toBe(0.50);
  });
  test('tier_100 → 100% discount', () => {
    expect(getFeeDiscountMultiplier('tier_100')).toBe(1.00);
  });
  test('unknown tier → 0 discount', () => {
    expect(getFeeDiscountMultiplier('unknown')).toBe(0);
    expect(getFeeDiscountMultiplier(null)).toBe(0);
  });
});

// ─── ESCROW FEE ──────────────────────────────────────────────────────────────

describe('Escrow: fee computation', () => {
  test('default 0.5% fee on principal', () => {
    const result = calculateEscrowFee(1000);
    expect(result.feeUsdc).toBe(5);         // 0.5% of 1000
    expect(result.principalUsdc).toBe(1000);
    expect(result.totalLockedUsdc).toBe(1005);
    expect(result.feePctUsed).toBe(0.005);
  });

  test('custom fee pct', () => {
    const result = calculateEscrowFee(500, 0.01);
    expect(result.feeUsdc).toBe(5);         // 1% of 500
    expect(result.totalLockedUsdc).toBe(505);
  });

  test('conservation: principal + fee = total locked (always)', () => {
    const amounts = [0.01, 50, 999.99, 5000, 7777.77];
    const feePcts = [0.005, 0.01, 0.015, 0.025];
    for (const amount of amounts) {
      for (const feePct of feePcts) {
        const r = calculateEscrowFee(amount, feePct);
        expect(Math.abs(r.principalUsdc + r.feeUsdc - r.totalLockedUsdc)).toBeLessThan(EPSILON);
      }
    }
  });

  test('rejects zero or negative amount', () => {
    expect(() => calculateEscrowFee(0)).toThrow('positive number');
    expect(() => calculateEscrowFee(-100)).toThrow('positive number');
    expect(() => calculateEscrowFee(NaN)).toThrow('positive number');
  });
});

// ─── P2P FEE SPLIT (regression guard — already in math.test.js, here for completeness) ───

describe('P2P fee split: cross-check with existing math.test.js', () => {
  test('fee split still conserves money', () => {
    const { totalFeeUsdc, netUsdc } = calculateFeeSplit(1000, 0.02, 0.5);
    expect(Math.abs(netUsdc + totalFeeUsdc - 1000)).toBeLessThan(EPSILON);
  });
});
