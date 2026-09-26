// __tests__/r25-ledger-replay-refusal.unit.test.js
// =============================================================================
// r25 §1/§12 — ESCROW LEDGER-REPLAY REFUSAL (unit, boundary-isolated)
//
// THE INVARIANT (r25 P0):
//   The ledger primitive (services/ledgerService.js) returns an EXACT REPLAY
//   when the same idempotency key already committed — it does NOT abort the
//   caller's transaction. An operation that just WON its own durable state
//   claim (escrow DRAFT→FUNDED CAS) can never legitimately observe a replay:
//   a prior committed posting implies the escrow already left DRAFT, so the
//   claim would have lost. A replay observed INSIDE a won claim is
//   contradictory evidence and MUST abort the whole financial transaction —
//   the replayed identity must never permit a second economic mutation
//   (second debit, second lock increment, second history row).
// =============================================================================

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({
    post: jest.fn().mockResolvedValue({ replayed: true, transaction: { id: 'lt-existing' }, entries: [] }),
}));
// Post-commit (setImmediate) side-effect services — mocked so the unit probe
// never touches business-order machinery mid-teardown.
jest.mock('../services/businessOrderService', () => ({
    updateOrderStatusFromEscrow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/bizNotificationService', () => ({
    notifyOrderEvent: jest.fn().mockResolvedValue(undefined),
}));

const ledger = require('../services/ledgerService');
const escrowService = require('../services/escrowService');

// ledger.post is a MODULE-level mock shared across both tests — its call
// counter accumulates. Without this reset the second test's
// toHaveBeenCalledTimes(1) sees the first test's call, fails the test,
// skips the drain, and lets the post-commit hook fire into a torn-down
// environment.
beforeEach(() => {
    jest.clearAllMocks();
});

describe('r25: fundEscrow refuses a ledger exact replay inside a won funding claim', () => {
    const buildPrisma = ({ claimCount = 1, debitCount = 1 } = {}) => {
        const tx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
                findUnique: jest.fn().mockResolvedValue({ id: 1, status: 'FUNDED' }),
            },
            user: {
                updateMany: jest.fn().mockResolvedValue({ count: debitCount }),
                update: jest.fn().mockResolvedValue({}),
                findUnique: jest.fn().mockResolvedValue({ availableBalance: 500 }),
            },
            systemProfitFees: {
                upsert: jest.fn().mockResolvedValue({}),
                update: jest.fn().mockResolvedValue({}),
            },
            transactionHistory: {
                create: jest.fn().mockResolvedValue({ id: 'h1' }),
            },
            adminProfitLog: {
                create: jest.fn().mockResolvedValue({ id: 'p1' }),
            },
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 1,
                    status: 'DRAFT',
                    payerId: 7,
                    payeeId: 8,
                    ticketId: 5,
                    amountUsdc: 50,
                    feeUsdc: 0.25,
                }),
            },
            globalSettings: {
                findUnique: jest.fn().mockResolvedValue({ escrowFundedExpiryDays: 30 }),
            },
            $transaction: jest.fn(async (cb) => cb(tx)),
        };
        return { prisma, tx };
    };

    test('an exact ledger replay observed inside a won claim ABORTS the financial operation', async () => {
        const { prisma, tx } = buildPrisma();

        await expect(escrowService.fundEscrow(prisma, { escrowId: 1, payerId: 7 }))
            .rejects.toMatchObject({ code: 'LEDGER_REPLAY_IN_CLAIMED_OPERATION' });

        // The replay was observed AFTER the money moves — the THROW is what
        // rolls the whole transaction back. Prove the throw happened before
        // the funding history row was written.
        expect(tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(tx.adminProfitLog.create).not.toHaveBeenCalled();
        // The claim and the debit DID execute (they are rolled back by the
        // abort, not skipped) — the refusal is the replay check, not a refusal
        // to fund.
        expect(tx.smartEscrow.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
        expect(ledger.post).toHaveBeenCalledTimes(1);
    });

    test('a non-replayed ledger posting proceeds to the canonical history row (no refusal)', async () => {
        const { prisma, tx } = buildPrisma();
        ledger.post.mockResolvedValueOnce({ replayed: false, transaction: { id: 'lt1' }, entries: [] });

        await expect(escrowService.fundEscrow(prisma, { escrowId: 1, payerId: 7 }))
            .resolves.toMatchObject({ success: true });

        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(ledger.post).toHaveBeenCalledTimes(1);

        // Drain the post-commit setImmediate hooks INSIDE the test so they
        // run against live module mocks, not a torn-down registry.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
    });
});
