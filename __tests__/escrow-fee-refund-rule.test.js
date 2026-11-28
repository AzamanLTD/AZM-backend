// =============================================================================
// Azaman never keeps a fee on a transaction that did not take place (owner
// rule, 28 Nov 2026). A general escrow refund (escrowService._refundEscrowTx)
// says why it refunds (feeCause), and the published rule for that cause
// decides the fee:
//   • EXPIRED, DISPUTE_REFUNDED, BUSINESS_CANCELLED: the fee comes back, out
//     of the profit bucket, with its revenue and profit entry reversed;
//   • CUSTOMER_CANCELLED: the fee is kept (the default);
//   • no cause: the principal only, exactly as before;
//   • a short bucket: the refund goes through and the fee is recorded as owed.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn(async () => ({ replayed: false, transaction: { id: 'lt-1' } })) }));
jest.mock('../services/reconciliationExceptionService', () => ({ recordReconciliationExceptionLoud: jest.fn(async () => undefined) }));

const ledger = require('../services/ledgerService');
const { recordReconciliationExceptionLoud } = require('../services/reconciliationExceptionService');
const { table } = require('./helpers/transitPrismaFake');
const escrowService = require('../services/escrowService');
const { DEFAULT_FEE_REFUND } = require('../services/feeRefundPolicy');

function makeTx({ bucket = 10 } = {}) {
    const tx = {
        smartEscrow: table([{ id: 'esc-1', status: 'FUNDED', payerId: 10, payeeId: 20, amountUsdc: 40, feeUsdc: 0.2 }]),
        user: table([{ id: 10, availableBalance: 0, escrowLockedBalance: 40, disputeEscrowBalance: 0 }]),
        systemProfitFees: table([{ id: 1, balance: bucket }]),
        adminProfitLog: table([]),
        transactionHistory: table([]),
        adminMoneySettingRevision: table([]),
    };
    return tx;
}
const refund = (tx, feeCause) => escrowService._refundEscrowTx(tx, tx.smartEscrow.rows[0], 'REFUNDED', feeCause ? { feeCause } : {});

beforeEach(() => jest.clearAllMocks());

test('the defaults: a transaction that did not take place gives the fee back', () => {
    expect(DEFAULT_FEE_REFUND).toEqual({
        BUSINESS_CANCELLED: true, CUSTOMER_CANCELLED: false, NO_SHOW: false, EXPIRED: true, DISPUTE_REFUNDED: true,
    });
});

test.each(['EXPIRED', 'DISPUTE_REFUNDED', 'BUSINESS_CANCELLED'])('%s: the fee comes back, its revenue reversed', async (cause) => {
    const tx = makeTx();
    await refund(tx, cause);
    expect(tx.user.rows[0].availableBalance).toBeCloseTo(40.2, 8);
    expect(tx.systemProfitFees.rows[0].balance).toBeCloseTo(9.8, 8);
    expect(tx.adminProfitLog.rows).toEqual([expect.objectContaining({ source: 'SMART_ESCROW_FEE', relatedTxId: 'escrow_fee_refund_esc-1' })]);
    expect(Number(tx.adminProfitLog.rows[0].amountUsdc)).toBeCloseTo(-0.2, 8);
    const lines = ledger.post.mock.calls[0][1].lines;
    expect(lines).toEqual([
        { account: 'escrow:escrow-esc-1:locked', debit: '40.00000000' },
        { account: 'revenue:fees', debit: '0.20000000' },
        { account: 'user:10:liability', credit: '40.20000000' },
    ]);
    // The history row matches the money (the ledger audit reads it).
    expect(Number(tx.transactionHistory.rows[0].amountUsdc)).toBeCloseTo(40.2, 8);
});

test('the customer cancelled: the fee is kept', async () => {
    const tx = makeTx();
    await refund(tx, 'CUSTOMER_CANCELLED');
    expect(tx.user.rows[0].availableBalance).toBe(40);
    expect(tx.systemProfitFees.rows[0].balance).toBe(10);
    expect(tx.adminProfitLog.rows).toHaveLength(0);
});

test('no cause: the principal only, as before', async () => {
    const tx = makeTx();
    await refund(tx, null);
    expect(tx.user.rows[0].availableBalance).toBe(40);
    expect(ledger.post.mock.calls[0][1].lines).toEqual([
        { account: 'escrow:escrow-esc-1:locked', debit: '40.00000000' },
        { account: 'user:10:liability', credit: '40.00000000' },
    ]);
    expect(tx.transactionHistory.rows[0].metadata).toBeUndefined();
});

test('a short profit bucket: the refund goes through and the fee is owed', async () => {
    const tx = makeTx({ bucket: 0.1 });
    await refund(tx, 'EXPIRED');
    expect(tx.user.rows[0].availableBalance).toBe(40);
    expect(tx.systemProfitFees.rows[0].balance).toBe(0.1);
    expect(recordReconciliationExceptionLoud).toHaveBeenCalledWith(tx, expect.objectContaining({ entityType: 'ESCROW_FEE_REFUND', reason: 'FEE_REFUND_OWED' }));
    expect(tx.transactionHistory.rows[0].metadata).toEqual(expect.objectContaining({ feeRefundedUsdc: 0, feeRefundOwedUsdc: 0.2, feeCause: 'EXPIRED' }));
});
