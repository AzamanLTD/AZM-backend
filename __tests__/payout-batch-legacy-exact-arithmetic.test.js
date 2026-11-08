// __tests__/payout-batch-legacy-exact-arithmetic.test.js
// =============================================================================
// §r42.2 EXACT GHS ON THE LEGACY FIAT DISPATCH PATH
//
// The legacy branch of workers/payoutBatchWorker.js computed the amount it
// asked the provider to pay as
//
//     parseFloat((amount * liveRate).toFixed(2))
//
// Two binary steps sat between the exact USDC amount and the money leaving the
// account: the product was rounded as a DOUBLE, and the result was turned back
// into a Number. `(0.05 * 12.3).toFixed(2)` is "0.61" because the product is
// 0.6149999999999999 — the customer is underpaid one pesewa — and the Number
// that came out was not evidence of the exact figure. The authority branch had
// the same shape: an exact reserved Decimal was round-tripped through
// parseFloat before dispatch.
//
// This suite pins the corrected contract:
//   • the provider receives a 2-dp STRING, never a Number;
//   • the rounding is ROUND_HALF_UP on the decimal product;
//   • fractional and half-pesewa boundaries that binary rounding gets wrong
//     are exact;
//   • a reserved amount is dispatched verbatim, never re-priced at the live
//     rate.
// =============================================================================

const { Prisma } = require('@prisma/client');

jest.mock('../src/services/fiatLiquidityService', () => ({
    isAuthorityEnabled: jest.fn().mockResolvedValue(false),
    toExactGhsDecimal: jest.fn((v) => v),
    recordProviderEvent: jest.fn().mockResolvedValue({ replay: false }),
    inTransitIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
    settleIfRecorded: jest.fn().mockResolvedValue({ skipped: true }),
}));
jest.mock('../src/services/fiatLiquidityActivationService', () => ({
    isAuthorityModeActive: jest.fn().mockResolvedValue(false),
}));

const PayoutBatchWorker = require('../workers/payoutBatchWorker');
const fiatLiquidity = require('../src/services/fiatLiquidityService');

describe('payoutBatchWorker legacy fiat dispatch — exact 2-dp GHS', () => {
    const settings = {
        autoPayoutEnabled: true,
        autoPayoutMaxAmountUsdc: 200,
        autoPayoutThresholdUsdc: 500,
        autoPayoutIntervalMs: 120000,
    };

    const buildWorker = ({ usdcAmount, liveRetailRate, reservation = null, pool = 1000 }) => {
        const initiateTransfer = jest.fn().mockResolvedValue({
            _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED',
        });
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue({ ...settings, liveRetailRate }) },
            fiatLiquidityState: { findUnique: jest.fn().mockResolvedValue({ availableGhs: 500000 }) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: pool }) },
            fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(reservation) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 91, userId: 7, amount: usdcAmount, destination: '0240000000', network: 'MTN',
                    payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: jest.fn().mockResolvedValue({}),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 'tx-1', txHash: 'ref-1', status: 'PENDING', userId: 7, amountUsdc: usdcAmount,
                }]),
                findUnique: jest.fn(),
                create: jest.fn(),
            },
            $queryRawUnsafe: jest.fn().mockResolvedValue([]),
            $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
        return { worker, initiateTransfer };
    };

    const dispatch = async (opts) => {
        const { worker, initiateTransfer } = buildWorker(opts);
        const result = await worker._processBatch(settings, { isManualTrigger: true });
        expect(result.processed).toBe(1);
        expect(initiateTransfer).toHaveBeenCalledTimes(1);
        return initiateTransfer.mock.calls[0][0];
    };

    test.each([
        // usdc, rate, exact half-up product, the WRONG value the binary
        // product produced. Each pair is a verified flip, not an assumption:
        // the old expression really did under-pay a pesewa here.
        ['0.35', '12.3', '4.31', '4.30'],
        ['0.15', '12.3', '1.85', '1.84'],
        ['0.02', '12.25', '0.25', '0.24'],
        ['0.30', '12.35', '3.71', '3.70'],
        ['0.42', '12.25', '5.15', '5.14'],
    ])('a %s USDC row at %s GHS pays exactly %s, not the float %s',
        async (usdc, rate, want, floatWrong) => {
            // The float path is what the old code produced — assert the fix is
            // not accidentally equal to it.
            expect(parseFloat((Number(usdc) * Number(rate)).toFixed(2))).toBe(Number(floatWrong));
            const dispatched = await dispatch({ usdcAmount: new Prisma.Decimal(usdc), liveRetailRate: rate });
            expect(dispatched.amountGhs).toBe(want);
            expect(typeof dispatched.amountGhs).toBe('string');
            expect(dispatched.amountGhs).toMatch(/^\d+\.\d{2}$/);
        });

    test('a value the float path already rounded correctly is unchanged', async () => {
        // 0.05 × 12.3 is exactly 0.615 → 0.62, and the double happened to round
        // the same way. Locked so a "fix" cannot drift this case either.
        const dispatched = await dispatch({ usdcAmount: new Prisma.Decimal('0.05'), liveRetailRate: '12.3' });
        expect(dispatched.amountGhs).toBe('0.62');
    });

    // ── §r42.4 threshold boundaries: Decimal decides dispatch vs hold ───────
    describe('eligibility boundaries are decided in Decimal', () => {
        const run = async ({ usdcAmount, pool, settingsOverride = {} }) => {
            const settings = {
                autoPayoutEnabled: true,
                autoPayoutMaxAmountUsdc: 200,
                autoPayoutThresholdUsdc: 500,
                autoPayoutIntervalMs: 120000,
                liveRetailRate: '12.5',
                ...settingsOverride,
            };
            const initiateTransfer = jest.fn().mockResolvedValue({
                _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED',
            });
            const prisma = {
                globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
                fiatLiquidityState: { findUnique: jest.fn().mockResolvedValue(null) },
                systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: pool }) },
                fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
                withdrawal: {
                    findMany: jest.fn().mockResolvedValue([{
                        id: 77, userId: 7, amount: usdcAmount, destination: '0240000000', network: 'MTN',
                        payoutMethod: 'MTN_MOMO', createdAt: new Date('2026-08-30T10:00:00.000Z'),
                    }]),
                    update: jest.fn().mockResolvedValue({}),
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                transactionHistory: {
                    findMany: jest.fn().mockResolvedValue([{
                        id: 'tx-9', txHash: 'ref-9', status: 'PENDING', userId: 7, amountUsdc: usdcAmount,
                    }]),
                    findUnique: jest.fn(),
                    create: jest.fn(),
                },
                $queryRawUnsafe: jest.fn().mockResolvedValue([]),
                $executeRawUnsafe: jest.fn().mockResolvedValue(1),
            };
            const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);
            const result = await worker._processBatch(settings, { isManualTrigger: true });
            return { result, initiateTransfer };
        };

        test('an amount exactly equal to the auto-approve maximum is DISPATCHED', async () => {
            const { result, initiateTransfer } = await run({ usdcAmount: new Prisma.Decimal('200'), pool: '5000' });
            expect(result.processed).toBe(1);
            expect(initiateTransfer).toHaveBeenCalledTimes(1);
        });

        test('one 8-dp step above the maximum is HELD', async () => {
            const { result, initiateTransfer } = await run({ usdcAmount: new Prisma.Decimal('200.00000001'), pool: '5000' });
            expect(result.processed).toBe(0);
            expect(initiateTransfer).not.toHaveBeenCalled();
            expect(result.details.flaggedManualReview[0].reason).toBe('AMOUNT_EXCEEDS_THRESHOLD');
        });

        test('a legacy pool exactly equal to the payout is ENOUGH (not short by a rounding step)', async () => {
            const { result, initiateTransfer } = await run({
                usdcAmount: new Prisma.Decimal('0.3'),
                pool: '0.3',
                settingsOverride: { autoPayoutThresholdUsdc: '0.3' },
            });
            expect(result.processed).toBe(1);
            expect(initiateTransfer).toHaveBeenCalledTimes(1);
        });

        test('a pool one 8-dp step short of the payout is HELD', async () => {
            const { result, initiateTransfer } = await run({
                usdcAmount: new Prisma.Decimal('0.3'),
                pool: '0.29999999',
                settingsOverride: { autoPayoutThresholdUsdc: '0.29999999' },
            });
            expect(result.processed).toBe(0);
            expect(initiateTransfer).not.toHaveBeenCalled();
            expect(result.details.flaggedManualReview[0].reason).toBe('INSUFFICIENT_POOL_LIQUIDITY');
        });

        test('a pool exactly at the configured threshold is ENOUGH', async () => {
            const { result, initiateTransfer } = await run({
                usdcAmount: new Prisma.Decimal('5'),
                pool: '25',
                settingsOverride: { autoPayoutThresholdUsdc: '25' },
            });
            expect(result.processed).toBe(1);
            expect(initiateTransfer).toHaveBeenCalledTimes(1);
        });
    });

    test('the provider amount is a 2-dp string and its value equals the exact decimal product', async () => {
        const dispatched = await dispatch({ usdcAmount: new Prisma.Decimal('12.34'), liveRetailRate: '12.55' });
        // 12.34 × 12.55 = 154.867 exactly → 154.87
        expect(dispatched.amountGhs).toBe('154.87');
        expect(new Prisma.Decimal(dispatched.amountGhs).equals(154.87)).toBe(true);
    });

    test('a Decimal the driver serialises as a string is still parsed exactly', async () => {
        const dispatched = await dispatch({ usdcAmount: '0.05', liveRetailRate: new Prisma.Decimal('12.3') });
        expect(dispatched.amountGhs).toBe('0.62');
    });

    test('a whole-number product keeps the pesewa representation (no scientific notation)', async () => {
        const dispatched = await dispatch({ usdcAmount: new Prisma.Decimal('1'), liveRetailRate: '12.5' });
        expect(dispatched.amountGhs).toBe('12.50');
    });

    test('an authority-reserved row is dispatched verbatim, never re-priced at the live rate', async () => {
        const dispatched = await dispatch({
            usdcAmount: new Prisma.Decimal('1'),
            liveRetailRate: '20', // deliberately different from the reservation
            reservation: { amountGhs: new Prisma.Decimal('12.34') },
        });
        expect(dispatched.amountGhs).toBe('12.34');
    });

    test('the liquidity evidence records the same exact pesewa figure that was dispatched', async () => {
        fiatLiquidity.recordProviderEvent.mockClear();
        const dispatched = await dispatch({ usdcAmount: new Prisma.Decimal('0.05'), liveRetailRate: '12.3' });
        const evidence = fiatLiquidity.recordProviderEvent.mock.calls.find((c) => c[1]?.direction === 'OUTBOUND');
        expect(evidence).toBeTruthy();
        expect(evidence[1].amountGhs).toBe(dispatched.amountGhs);
    });

});
