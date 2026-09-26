'use strict';

// =============================================================================
// §r41 — PAYOUT PARKING AUTHORITY (final-audit batch 2, unit).
//
// Parking a withdrawal for manual review is a CONDITIONAL claim on the row,
// never an unconditional write. The scan that selected the row is a stale
// snapshot; a second worker may have claimed it PROCESSING (or a terminal
// state may have committed) since. These proofs pin the two claim regimes:
//
//  1. PRE-DISPATCH parking (_parkForManualReview): PENDING-only claim.
//     A row already claimed PROCESSING by another worker, or in any other
//     state, is untouched — and NO notification fires (the user's
//     withdrawal is owned by its real handler; a stale reviewer must not
//     tell them otherwise). Falsification: the pre-r41 writer was an
//     unconditional prisma.withdrawal.update — a stale worker overwrote
//     PROCESSING (or worse, a terminal COMPLETED/FAILED) back to
//     NEEDS_MANUAL_REVIEW.
//
//  2. POST-DISPATCH exception parking (_flagForManualReview):
//     PROCESSING-only claim. Legitimately parks a dispatch failure; a
//     terminal state never gets stale-overwritten.
// =============================================================================

const PayoutBatchWorker = require('../workers/payoutBatchWorker');

describe('r41 — payout parking authority (unit)', () => {
    const makeWorker = ({ rowStatus, claimResult, notifyThrows = false }) => {
        const sent = [];
        const prisma = {
            withdrawal: {
                updateMany: jest.fn(async () => ({ count: claimResult })),
                findUnique: jest.fn(async () => ({ status: rowStatus })),
            },
        };
        const notificationService = notifyThrows
            ? { sendNotification: jest.fn(async () => { throw new Error('notify down'); }) }
            : { sendNotification: jest.fn(async (n) => sent.push(n)) };
        const worker = Object.create(PayoutBatchWorker.prototype);
        worker.prisma = prisma;
        worker.notificationService = notificationService;
        worker._sent = sent;
        worker._mocks = prisma;
        return worker;
    };

    const wd = (id = 42) => ({ id, amount: 100, destination: '+233500000000' });

    // ── 1. PRE-DISPATCH parking ────────────────────────────────────────────

    test('P1. PENDING row: the claim lands, the user is notified, true returned', async () => {
        const w = makeWorker({ rowStatus: 'PENDING', claimResult: 1 });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', { amount: 100 });

        expect(parked).toBe(true);
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 42, status: { in: ['PENDING'] } }),
                data: { status: 'NEEDS_MANUAL_REVIEW' },
            })
        );
        expect(w._sent.length).toBe(1); // exactly one notification
    });

    test('P2. row claimed PROCESSING by another worker: the stale parking does NOTHING — no write effect, no notification', async () => {
        const w = makeWorker({ rowStatus: 'PROCESSING', claimResult: 0 });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', { amount: 100 });

        expect(parked).toBe(false);
        expect(w._sent.length).toBe(0); // the real owner is handling it — silence
        // the claim predicate included ONLY PENDING
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: { in: ['PENDING'] } }),
            })
        );
    });

    test('P3. terminal row (COMPLETED/FAILED/REFUNDED): the claim loses, the row keeps its terminal truth', async () => {
        for (const terminal of ['COMPLETED', 'FAILED', 'REFUNDED']) {
            const w = makeWorker({ rowStatus: terminal, claimResult: 0 });
            const parked = await w._parkForManualReview(wd(), 'MISSING_TRANSACTION_REFERENCE', {});
            expect(parked).toBe(false);
            expect(w._sent.length).toBe(0);
        }
    });

    // ── 2. POST-DISPATCH exception parking ─────────────────────────────────

    test('P4. PROCESSING row (dispatch failed mid-flight): the exception parking lands and notifies', async () => {
        const w = makeWorker({ rowStatus: 'PROCESSING', claimResult: 1 });
        const parked = await w._flagForManualReview(wd(7), 'DISPATCH_EXCEPTION', { message: 'moMo API 504' });

        expect(parked).toBe(true);
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 7, status: { in: ['PROCESSING'] } }),
                data: { status: 'NEEDS_MANUAL_REVIEW' },
            })
        );
        expect(w._sent.length).toBe(1);
    });

    test('P5. terminal row after dispatch (COMPLETED by another actor): the exception parking is refused', async () => {
        const w = makeWorker({ rowStatus: 'COMPLETED', claimResult: 0 });
        const parked = await w._flagForManualReview(wd(), 'DISPATCH_EXCEPTION', {});

        expect(parked).toBe(false);
        expect(w._sent.length).toBe(0);
    });

    test('P6. notification outage does not corrupt the claim semantics — the claim result stands', async () => {
        const w = makeWorker({ rowStatus: 'PENDING', claimResult: 1, notifyThrows: true });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', {});

        // The DB claim landed; only the notification failed. The caller is
        // told the truth about the row (parked=true → results include it);
        // the notify failure is logged, never propagated as a false "not parked".
        expect(parked).toBe(true);
    });
});
