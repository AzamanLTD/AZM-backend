// __tests__/payout-dust-exact-money.test.js
// =============================================================================
// §E — THE DUST GUARD ITSELF MUST BE EXACT
//
// The guard exists to stop an impossible payout. Its previous version computed
// the GHS product from `amount` (the Number presentation copy of the column) and
// then through `Number(...toFixed(2))`, so the verdict that decides "is this a
// payout at all?" was reached on a binary approximation — and an unusable rate
// fell straight through to provider I/O, because a NaN product failed the
// `<= 0` test instead of refusing.
//
// This suite pins the corrected contract on the legacy dispatch path:
//   • the product comes from `amountExact` and `liveRateExact` in Decimal;
//   • rounding is ROUND_HALF_UP to 2dp;
//   • a proven zero parks as DUST_SETTLEMENT with exact evidence;
//   • an unusable rate or non-finite product parks under its OWN reason and
//     reaches no provider;
//   • the evidence keeps the exact text the database held (no double round-trip).
//
// Durable parking against real PostgreSQL is proven separately by
// payout-dust-settlement.pg.test.js; here the park is spied so the assertions are
// about the DECISION and its evidence.
// =============================================================================
'use strict';

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
    readMode: jest.fn().mockResolvedValue({ active: false, latched: false, flagged: false }),
}));

const PayoutBatchWorker = require('../workers/payoutBatchWorker');
const { withTransactions } = require('./helpers/mockTransaction');
const { requestAmountExact } = require('../utils/exactAmount');

const SETTINGS = {
    id: 1,
    autoPayoutEnabled: true,
    autoPayoutMaxAmountUsdc: 200,
    autoPayoutThresholdUsdc: 500,
    autoPayoutIntervalMs: 120000,
};

function buildWorker({ usdcAmount, liveRetailRate, pool = 1000 }) {
    const initiateTransfer = jest.fn().mockResolvedValue({
        _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED',
    });
    const prisma = {
        globalSettings: { findUnique: jest.fn().mockResolvedValue({ ...SETTINGS, liveRetailRate }) },
        fiatLiquidityState: { findUnique: jest.fn().mockResolvedValue({ availableGhs: 500000 }) },
        systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: pool }) },
        fiatLiquidityReservation: { findUnique: jest.fn().mockResolvedValue(null) },
        withdrawal: {
            findUnique: jest.fn(async (args) => ({ id: args && args.where ? args.where.id : 91, status: 'PENDING' })),
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
    const worker = new PayoutBatchWorker(withTransactions(prisma), null, { initiateTransfer }, null);
    const park = jest.spyOn(worker, '_parkForManualReview').mockResolvedValue(true);
    return { worker, initiateTransfer, park };
}

async function run(opts) {
    const { worker, initiateTransfer, park } = buildWorker(opts);
    const result = await worker._processBatch(SETTINGS, { isManualTrigger: true });
    return { result, initiateTransfer, park };
}

describe('the legacy dust guard decides in exact Decimal', () => {
    test('a row that quantizes to 0.01 GHS is a payout, not dust', async () => {
        // 0.001 USDC × 12.5 = 0.0125 → HALF_UP → 0.01. A guard that rounded this
        // to zero would refuse a real, payable amount.
        const { result, initiateTransfer, park } = await run({ usdcAmount: new Prisma.Decimal('0.001'), liveRetailRate: '12.5' });
        expect(park).not.toHaveBeenCalled();
        expect(initiateTransfer).toHaveBeenCalledTimes(1);
        expect(initiateTransfer.mock.calls[0][0].amountGhs).toBe('0.01');
        expect(result.processed).toBe(1);
    });

    test('a proven zero parks as DUST_SETTLEMENT with exact evidence and no provider call', async () => {
        // 0.0003 × 12.5 = 0.00375 → 0.00 at pesewa precision.
        const { result, initiateTransfer, park } = await run({ usdcAmount: new Prisma.Decimal('0.0003'), liveRetailRate: '12.5' });
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledTimes(1);
        const [withdrawal, reason, evidence] = park.mock.calls[0];
        expect(withdrawal.id).toBe(91);
        expect(reason).toBe('DUST_SETTLEMENT');
        expect(evidence.payoutGhsExact).toBe('0.00');
        expect(evidence.amountExact).toBe('0.0003');
        expect(evidence.liveRateExact).toBe('12.5');
        expect(result.flagged).toBe(1);
    });

    test('an unusable rate parks under its own reason instead of dispatching', async () => {
        const { result, initiateTransfer, park } = await run({ usdcAmount: new Prisma.Decimal('5'), liveRetailRate: 'Infinity' });
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledTimes(1);
        const [withdrawal, reason, evidence] = park.mock.calls[0];
        expect(withdrawal.id).toBe(91);
        // NOT DUST_SETTLEMENT: a rate problem must not be mislabelled as dust.
        expect(reason).toBe('PAYOUT_CALCULATION_NOT_DISPATCHABLE');
        expect(evidence.liveRateExact).toBe('Infinity');
        expect(evidence.amountExact).toBe('5');
        expect(result.flagged).toBe(1);
    });

    test('the evidence keeps the exact column text, not a double round-trip', async () => {
        // A value with more precision than a double carries. Number() would lose it.
        const exactText = '0.00030000000000000001';
        const { initiateTransfer, park } = await run({ usdcAmount: new Prisma.Decimal(exactText), liveRetailRate: '12.5' });
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(park.mock.calls[0][2].amountExact).toBe(exactText);
        expect(String(Number(exactText))).not.toBe(exactText); // the double really did lose it
    });
});

describe('requestAmountExact — the request text is preserved', () => {
    test('string amounts keep every digit the client sent', () => {
        const long = '0.1000000000000000055511151231257827';
        expect(requestAmountExact(long).toString()).toBe(long);
        expect(String(Number(long))).not.toBe(long);
    });

    test('a half-pesewa boundary survives exactly', () => {
        // 2.675 is the classic double trap: (2.675).toFixed(2) === "2.67".
        expect(requestAmountExact('2.675').toString()).toBe('2.675');
        expect(requestAmountExact('2.675').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString()).toBe('2.68');
    });

    test('unreadable input is null so the caller can refuse', () => {
        for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, {}, []]) {
            expect(requestAmountExact(bad)).toBeNull();
        }
        expect(requestAmountExact('0.25').toString()).toBe('0.25');
        expect(requestAmountExact(0.25).toString()).toBe('0.25');
    });
});
