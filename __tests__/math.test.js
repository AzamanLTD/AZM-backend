// __tests__/math.test.js
// =============================================================================
// Fee-split settlement math (B-08).
//
// The production fee arithmetic lives inline inside a DB transaction in
// services/p2p.service.js (completeTrade, ~lines 613–631) — there is no pure
// helper to import yet. Rather than reach into a transaction, this suite
// re-implements the SAME formula and locks in the invariants that must never
// break: the fee split conserves money, and the USDC rounding (.toFixed(6))
// introduces no drift large enough to create or destroy value.
//
// If the production formula changes, this test should change with it — and the
// real fix is to extract `calculateFeeSplit()` into a shared util that both
// the service and this test import. Until then, this guards the contract.
// =============================================================================

// Fee arithmetic now lives in a shared util imported by BOTH this test and
// services/p2p.service.js (completeTrade) — the single source of truth this
// suite's header asked for. Called with three args, vendorPct defaults to
// (1 - adminPct), exactly matching the original inline mirror.
const { calculateFeeSplit } = require('../utils/feeMath');

// Tolerance: USDC settles to 6 dp, so a half-unit of the last place is the most
// rounding can ever move a single split. We assert drift stays under that.
const EPSILON = 5e-7;

describe('P2P fee split — conservation invariants', () => {
    const cases = [
        { amount: 1000, feePct: 0.02, adminPct: 0.5 },
        { amount: 999.99, feePct: 0.02, adminPct: 0.6 },
        { amount: 5000, feePct: 0.03, adminPct: 0.5 },
        { amount: 0.01, feePct: 0.02, adminPct: 0.6 },
        { amount: 123.456789, feePct: 0.025, adminPct: 0.4 },
        { amount: 7777.7777, feePct: 0.015, adminPct: 0.55 },
    ];

    test.each(cases)(
        'amount=$amount feePct=$feePct adminPct=$adminPct: net + fee reconstructs the amount',
        ({ amount, feePct, adminPct }) => {
            const { totalFeeUsdc, netUsdc } = calculateFeeSplit(amount, feePct, adminPct);
            // The buyer-facing amount must be fully accounted for: what the
            // vendor nets plus what the platform skims equals the trade amount.
            expect(Math.abs(netUsdc + totalFeeUsdc - amount)).toBeLessThan(EPSILON);
        }
    );

    test.each(cases)(
        'amount=$amount feePct=$feePct adminPct=$adminPct: admin + vendor cut sums to the total fee',
        ({ amount, feePct, adminPct }) => {
            const { totalFeeUsdc, adminCutUsdc, vendorCutUsdc } = calculateFeeSplit(
                amount,
                feePct,
                adminPct
            );
            // No money is minted or burned when the fee is divided.
            expect(Math.abs(adminCutUsdc + vendorCutUsdc - totalFeeUsdc)).toBeLessThan(EPSILON);
        }
    );

    test('all split components are non-negative', () => {
        for (const c of cases) {
            const s = calculateFeeSplit(c.amount, c.feePct, c.adminPct);
            expect(s.totalFeeUsdc).toBeGreaterThanOrEqual(0);
            expect(s.adminCutUsdc).toBeGreaterThanOrEqual(0);
            expect(s.vendorCutUsdc).toBeGreaterThanOrEqual(0);
            expect(s.netUsdc).toBeGreaterThanOrEqual(0);
        }
    });

    test('the vendor never nets more than the trade amount', () => {
        for (const c of cases) {
            const { netUsdc } = calculateFeeSplit(c.amount, c.feePct, c.adminPct);
            expect(netUsdc).toBeLessThanOrEqual(c.amount);
        }
    });
});

describe('Decimal(20,8) precision — no floating-point drift', () => {
    test('classic 0.1 + 0.2 drift is absorbed by 6dp rounding', () => {
        const summed = parseFloat((0.1 + 0.2).toFixed(6));
        expect(summed).toBe(0.3);
    });

    test('repeated fee application over many trades does not accumulate drift', () => {
        // Simulate 10k trades of the same amount; the summed platform fee should
        // match feePct * total to within sub-cent tolerance, not visibly diverge.
        const amount = 49.99;
        const feePct = 0.02;
        let accruedFee = 0;
        const N = 10000;
        for (let i = 0; i < N; i++) {
            accruedFee += calculateFeeSplit(amount, feePct, 0.5).totalFeeUsdc;
        }
        const expected = parseFloat((amount * feePct).toFixed(6)) * N;
        // Allow N * EPSILON since each term can carry at most one rounding unit.
        expect(Math.abs(accruedFee - expected)).toBeLessThan(N * EPSILON);
    });

    test('a tiny trade still rounds to a representable 6dp fee', () => {
        const { totalFeeUsdc } = calculateFeeSplit(0.000049, 0.02, 0.5);
        // 0.000049 * 0.02 = 0.00000098 -> rounds to 0.000001 at 6dp.
        expect(totalFeeUsdc).toBe(0.000001);
    });
});
