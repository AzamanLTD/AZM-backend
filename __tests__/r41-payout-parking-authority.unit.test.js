'use strict';

// =============================================================================
// §r41 — PAYOUT PARKING AUTHORITY (final-audit batch 2, unit; r271f updated).
//
// Parking a withdrawal for manual review is a CONDITIONAL claim on the row,
// never an unconditional write. The scan that selected the row is a stale
// snapshot; a second worker may have claimed it PROCESSING (or a terminal
// state may have committed) since. These proofs pin the claim regimes:
//
//  1. PRE-DISPATCH parking (_parkForManualReview): PENDING/APPROVED claim
//     (r271e: an admin-approved row that failed an eligibility gate parks
//     exactly like a PENDING one — the dispatch claim is the only writer of
//     PROCESSING, so both states are provably undispatched). A row already
//     claimed PROCESSING by another worker, or in any other state, is
//     untouched — and NO notification fires (the user's withdrawal is owned
//     by its real handler; a stale reviewer must not tell them otherwise).
//     Falsification: the pre-r41 writer was an unconditional
//     prisma.withdrawal.update — a stale worker overwrote PROCESSING (or
//     worse, a terminal COMPLETED/FAILED) back to NEEDS_MANUAL_REVIEW.
//
//  2. POST-DISPATCH exception parking (_flagForManualReview):
//     PROCESSING-only claim. Legitimately parks a dispatch failure; a
//     terminal state never gets stale-overwritten.
//
//  3. r271f P0 #2 — DURABLE PHASE EVIDENCE, FAIL-CLOSED: every park records
//     the reason + phase as an OPEN ReconciliationException BEFORE the status
//     claim. If the evidence write fails the row is NOT parked (an existing
//     authority keeps it) — parking without evidence created unrecoverable
//     rows whose cash position could never be proven.
// =============================================================================

const PayoutBatchWorker = require('../workers/payoutBatchWorker');

describe('r41 — payout parking authority (unit)', () => {
    const makeWorker = ({ rowStatus, claimResult, notifyThrows = false, evidenceFails = false } = {}) => {
        const sent = [];
        const prisma = {
            withdrawal: {
                updateMany: jest.fn(async () => ({ count: claimResult })),
                findUnique: jest.fn(async () => ({ status: rowStatus })),
            },
            // r271f: the durable evidence write (recordReconciliationException)
            $queryRawUnsafe: jest.fn(async (sql) => {
                if (evidenceFails && String(sql).includes('INSERT INTO "ReconciliationException"')) {
                    throw new Error('simulated evidence outage');
                }
                return [];
            }),
            $executeRawUnsafe: jest.fn(async () => 0),
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

    test('P1. PENDING row: evidence recorded, the claim lands, the user is notified, true returned', async () => {
        const w = makeWorker({ rowStatus: 'PENDING', claimResult: 1 });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', { amount: 100 });

        expect(parked).toBe(true);
        // r271f: the durable evidence write happened FIRST (fail-closed).
        const evidenceSql = w._mocks.$queryRawUnsafe.mock.calls
            .map((c) => String(c[0]))
            .find((sql) => sql.includes('INSERT INTO "ReconciliationException"'));
        expect(evidenceSql).toBeTruthy();
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 42, status: { in: ['PENDING', 'APPROVED'] } }),
                data: { status: 'NEEDS_MANUAL_REVIEW' },
            })
        );
        expect(w._sent.length).toBe(1); // exactly one notification
    });

    test('P1b. r271e: an APPROVED row failing a gate parks with the same provably-not-dispatched evidence', async () => {
        const w = makeWorker({ rowStatus: 'APPROVED', claimResult: 1 });
        const parked = await w._parkForManualReview(wd(9), 'AMOUNT_EXCEEDS_THRESHOLD', {});

        expect(parked).toBe(true);
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 9, status: { in: ['PENDING', 'APPROVED'] } }),
                data: { status: 'NEEDS_MANUAL_REVIEW' },
            })
        );
        expect(w._sent.length).toBe(1);
    });

    test('P2. row claimed PROCESSING by another worker: the stale parking does NOTHING — no write effect, no notification', async () => {
        const w = makeWorker({ rowStatus: 'PROCESSING', claimResult: 0 });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', { amount: 100 });

        expect(parked).toBe(false);
        expect(w._sent.length).toBe(0); // the real owner is handling it — silence
        // the claim predicate included ONLY PENDING/APPROVED
        expect(w._mocks.withdrawal.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: { in: ['PENDING', 'APPROVED'] } }),
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
        const parked = await w._flagForManualReview(wd(7), 'DISPATCH_EXCEPTION', { message: 'moMo API 504' }, 'POST_ACCEPT');

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

    // ── 3. r271f: fail-closed durable evidence ─────────────────────────────

    test('P7. r271f: the evidence write fails → the row is NOT parked (fail-closed, no dead-end)', async () => {
        const w = makeWorker({ rowStatus: 'PENDING', claimResult: 1, evidenceFails: true });
        const parked = await w._parkForManualReview(wd(), 'AMOUNT_EXCEEDS_THRESHOLD', {});

        // NOT parked: an evidence-less NEEDS_MANUAL_REVIEW row could never be
        // proven undispatched — the PENDING row stays with the worker scan
        // (its existing authority) instead of becoming an unrecoverable park.
        expect(parked).toBe(false);
        expect(w._mocks.withdrawal.updateMany).not.toHaveBeenCalled();
        expect(w._sent.length).toBe(0);
    });
});
