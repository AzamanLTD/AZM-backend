'use strict';

// =============================================================================
// §r41.audit-followup — TRANSIT FUNDING/CANCELLATION AUTHORITY (real PostgreSQL).
//
// Closes the fund-after-cancellation race found in the PR #309 review:
//
//   fundBookingEscrow previously confirmed the TRANSIT booking with a
//   best-effort tail `updateMany({ where: { id, status: 'PENDING' } })` that
//   never failed on a terminal booking. A cancellation that won the shared
//   escrow lock first committed TransitBooking=CANCELLED while the escrow
//   stayed DRAFT; the queued funding then claimed DRAFT→FUNDED, debited the
//   payer, posted ledger/fees/history, and COMMITTED — a stranded-funds
//   FUNDED escrow on a CANCELLED booking.
//
// The fix: funding validates the ESCROW-LINKED booking inside the same
// transaction, immediately after the escrow claim (escrow-first → booking
// order preserved). PENDING is confirmed atomically; CONFIRMED/IN_PROGRESS
// converge; CANCELLED/NO_SHOW/COMPLETED and mismatched linkage fail closed,
// rolling the escrow claim back BEFORE any economic mutation.
//
// Also covers the createBookingEscrow terminal-linking authority: the
// TRANSIT link predicate now constrains the booking to the legal pre-terminal
// set (PENDING/CONFIRMED/IN_PROGRESS) instead of just `{ id, escrowId: null }`.
//
// DETERMINISM NOTE — every race proof here synchronizes on OBSERVED
// PostgreSQL lock state (pg_stat_activity wait_event_type='Lock' polling),
// never on a timer. Bounded timeouts are safety nets only.
// =============================================================================

const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r41.audit-followup — transit funding/cancellation authority (PostgreSQL)', () => {
    let prisma;
    let escrowService;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        // connection_limit=16: the gated interleaves hold several concurrent
        // connections (gate tx + two parked service transactions + the
        // pg_stat_activity polling connection). The sandbox default pool
        // (num_cpus*2+1 = 3) starves the second parked transaction before it
        // can even reach the database.
        const poolUrl = url + (url.includes('?') ? '&' : '?') + 'connection_limit=16';
        process.env.DATABASE_URL = poolUrl;
        prisma = new PrismaClient();
        escrowService = require('../services/bookingEscrowService');
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── DB-OBSERVED GATE HELPER ────────────────────────────────────────────
    // Polls pg_stat_activity until `count` sessions are BLOCKED ON A LOCK
    // running a query matching `needle`. The interleaving's correctness comes
    // from this observed state; the timeout is only a safety bound. No timer
    // ever establishes queue position.
    const waitForBlocked = async ({ needle, count = 1, timeoutMs = 15000 }) => {
        const started = Date.now();
        for (;;) {
            const rows = await prisma.$queryRaw`
                SELECT count(*)::int AS n
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND query LIKE ${'%' + needle + '%'}`;
            if (rows[0].n >= count) return rows[0].n;
            if (Date.now() - started > timeoutMs) {
                throw new Error(
                    `DB-observed gate timeout: expected ${count} blocked session(s) on "${needle}", saw ${rows[0].n}`
                );
            }
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    const userBal = async (id) => {
        const u = await prisma.user.findUnique({ where: { id } });
        return {
            available: Number(u.availableBalance),
            locked: Number(u.escrowLockedBalance),
        };
    };

    const ledgerCount = (escrowId, type) =>
        prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId, entryType: type } });

    const historyCount = (userId, type) =>
        prisma.transactionHistory.count({ where: { userId, type } });

    // ── SEEDING ────────────────────────────────────────────────────────────
    // Real service paths only: bookings are created directly, escrows via the
    // real createBookingEscrow, money via the real fundBookingEscrow.
    const seedBooking = async ({ status = 'PENDING', linkEscrow = true, amountUsdc = 50 } = {}) => {
        const { biz, owner } = await seedBusiness(prisma);
        const payer = await seedUser(prisma, { availableBalance: 200 });

        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id,
                customerId: payer.id,
                status,
                pickupAddress: 'Accra Central',
                dropoffAddress: 'Kumasi',
                scheduledAt: new Date(Date.now() + 3600_000),
                amountUsdc,
                bookingRef: `TRN-41F-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            },
        });

        let escrow = null;
        if (linkEscrow) {
            const created = await escrowService.createBookingEscrow(prisma, {
                bookingType: 'TRANSIT',
                bookingId: booking.id,
                payerId: payer.id,
                payeeId: owner.id,
                amountUsdc,
                businessProfileId: biz.id,
            });
            escrow = created.escrow;
        }
        return { biz, owner, payer, booking, escrow };
    };

    // Gate transaction holding a row lock until released.
    const gateOn = async (table, id) => {
        let taken; const gateOpen = new Promise((r) => { taken = r; });
        let release; const gateHold = new Promise((r) => { release = r; });
        const tx = prisma.$transaction(async (g) => {
            await g.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
            taken();
            await gateHold;
        }, { timeout: 30000 });
        await gateOpen;
        return { release: async () => { release(); await tx; } };
    };

    // ═══════════════════════════════════════════════════════════════════════
    // A. CANCEL-vs-FUND — cancellation wins the escrow authority first
    // ═══════════════════════════════════════════════════════════════════════

    test('A. cancellation wins the escrow lock first — the queued funding wakes to committed CANCELLED truth and fails closed with zero economic side effects', async () => {
        const { payer, booking, escrow } = await seedBooking();
        expect(escrow.status).toBe('DRAFT');
        expect(booking.status).toBe('PENDING');
        const before = await userBal(payer.id);
        expect(before.available).toBe(200);

        // GATE holds the escrow row. Lock-queue arrivals decide the
        // interleaving: cancellation first, funding second.
        const gate = await gateOn('SmartEscrow', escrow.id);
        try {

            const { cancelTransitBooking } = require('../services/transitBookingService');

            // Queue position 1: the REAL cancellation parks on the escrow
            // FOR UPDATE (its first and only shared-authority lock).
            const cancelPromise = cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id })
                .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'SELECT id FROM "SmartEscrow"' }); // OBSERVED

            // Queue position 2: the REAL funding parks on its escrow claim
            // (UPDATE "SmartEscrow" ... status = FUNDED), behind the cancellation.
            const fundPromise = escrowService.fundBookingEscrow(prisma, {
                escrowId: escrow.id, payerId: payer.id,
                bookingType: 'TRANSIT', bookingId: booking.id,
            }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'UPDATE "public"."SmartEscrow"' }); // OBSERVED

            // Release: the cancellation commits CANCELLED (escrow stays DRAFT —
            // NO_FUNDS, no money moved). The funding then acquires the escrow:
            // its DRAFT→FUNDED claim is allowed by the escrow row alone, but the
            // escrow-linked booking is CANCELLED — the funding FAILS CLOSED and
            // its WHOLE transaction (claim included) rolls back.
            await gate.release();
            const cancel = await cancelPromise;
            const fund = await fundPromise;

            expect(cancel.ok).toBe(true);
            expect(cancel.v.booking.status).toBe('CANCELLED');
            expect(cancel.v.refund.outcome).toBe('NO_FUNDS'); // DRAFT — nothing locked

            expect(fund.ok).toBe(false);
            expect(fund.e.code).toBe('TRANSIT_FUNDING_CONFLICT');

            // The escrow is back to DRAFT — the FUNDED claim rolled back.
            const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(escrowAfter.status).toBe('DRAFT');

            // Payer untouched by the losing fund: no debit, no lock, no fee,
            // no ledger, no history. Exactly zero economic side effects.
            const after = await userBal(payer.id);
            expect(after.available).toBeCloseTo(before.available, 6);
            expect(after.locked).toBeCloseTo(0, 6);
            expect(await ledgerCount(escrow.id, 'ESCROW_LOCK')).toBe(0);
            expect(await historyCount(payer.id, 'TICKET_ESCROW_FUND')).toBe(0);
            const fees = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
            expect(fees?.balance ?? 0).toBeCloseTo(0, 6);

            // The booking stays CANCELLED — no resurrection to CONFIRMED.
            expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status)
                .toBe('CANCELLED');
        } finally {
            // A failed observation must not leak parked transactions.
            try { await gate.release(); } catch (_) {}
        }
    }, 45000);

    // ═══════════════════════════════════════════════════════════════════════
    // B. CANCEL-vs-FUND — funding wins the escrow authority first
    // ═══════════════════════════════════════════════════════════════════════

    test('B. funding wins the escrow lock first — it confirms PENDING and commits economics; the queued cancellation then wins the legitimate second lifecycle step (CANCELLED + REFUNDED, one economic movement each way)', async () => {
        const { payer, booking, escrow } = await seedBooking();
        const before = await userBal(payer.id);

        const gate = await gateOn('SmartEscrow', escrow.id);
        try {
            const { cancelTransitBooking } = require('../services/transitBookingService');

            // Queue position 1: the REAL funding parks on its escrow claim.
            const fundPromise = escrowService.fundBookingEscrow(prisma, {
                escrowId: escrow.id, payerId: payer.id,
                bookingType: 'TRANSIT', bookingId: booking.id,
            }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'UPDATE "public"."SmartEscrow"' }); // OBSERVED

            // Queue position 2: the REAL cancellation parks on the escrow
            // FOR UPDATE, behind the funding.
            const cancelPromise = cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id })
                .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'SELECT id FROM "SmartEscrow"' }); // OBSERVED — cancellation queued behind the funding

            // Release: funding commits first (escrow FUNDED + booking PENDING→
            // CONFIRMED + debit + ledger, all one transaction). The cancellation
            // then wakes: escrow is FUNDED, booking CONFIRMED — it wins its
            // LEGITIMATE lifecycle step, CAS-claims CONFIRMED→CANCELLED and
            // refunds the locked principal in the same transaction.
            await gate.release();
            const fund = await fundPromise;
            const cancel = await cancelPromise;

            expect(fund.ok).toBe(true);
            expect(fund.v.success).toBe(true);
            expect(cancel.ok).toBe(true);
            expect(cancel.v.booking.status).toBe('CANCELLED');
            expect(cancel.v.refund.outcome).toBe('REFUNDED');

            // Exactly ONE debit and ONE refund — no duplicates from the interleave.
            expect(await ledgerCount(escrow.id, 'ESCROW_LOCK')).toBe(1);
            expect(await ledgerCount(escrow.id, 'ESCROW_REFUND')).toBe(1);
            expect(await historyCount(payer.id, 'TICKET_ESCROW_FUND')).toBe(1);
            expect(await historyCount(payer.id, 'TICKET_ESCROW_REFUND')).toBe(1);

            // Money: principal moved out and back; the fee was realized at lock
            // time and is NOT refunded (the documented economic identity).
            const after = await userBal(payer.id);
            expect(after.locked).toBeCloseTo(0, 6);
            const fee = Number(escrow.feeUsdc);
            expect(after.available).toBeCloseTo(before.available - fee, 6);

            const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(escrowAfter.status).toBe('REFUNDED');
        } finally {
            // A failed observation must not leak parked transactions.
            try { await gate.release(); } catch (_) {}
        }
    }, 45000);

    // ═══════════════════════════════════════════════════════════════════════
    // C. CREATE/LINK-vs-CANCEL — both interleavings, no terminal linking
    // ═══════════════════════════════════════════════════════════════════════

    test('C1. cancellation wins first — the create/link loses on the terminal booking and rolls back the WHOLE ticket+escrow aggregate', async () => {
        const { biz, owner, payer, booking } = await seedBooking({ linkEscrow: false });

        const gate = await gateOn('TransitBooking', booking.id);
        try {
            const { cancelTransitBooking } = require('../services/transitBookingService');

            // Queue position 1: the REAL cancellation parks on its booking CAS
            // (UPDATE "TransitBooking" ... status = CANCELLED).
            const cancelPromise = cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id })
                .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'UPDATE "public"."TransitBooking"' }); // OBSERVED

            // Queue position 2: the REAL createBookingEscrow parks on its link
            // updateMany (UPDATE "TransitBooking" SET escrowId...), behind the
            // cancellation. Its pre-writes (ticket + DRAFT escrow) are already in
            // its uncommitted transaction.
            const createPromise = escrowService.createBookingEscrow(prisma, {
                bookingType: 'TRANSIT', bookingId: booking.id,
                payerId: payer.id, payeeId: owner.id,
                amountUsdc: 50, businessProfileId: biz.id,
            }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            await waitForBlocked({ needle: 'UPDATE "public"."TransitBooking"', count: 2 }); // OBSERVED — both queued

            // Release: the cancellation commits CANCELLED. The create/link's
            // pre-terminal predicate (PENDING|CONFIRMED|IN_PROGRESS) matches ZERO
            // rows → BOOKING_ESCROW_LINK_CONFLICT → the WHOLE aggregate rolls
            // back: no orphan ticket, no orphan DRAFT escrow, nothing attached.
            await gate.release();
            const cancel = await cancelPromise;
            const create = await createPromise;

            expect(cancel.ok).toBe(true);
            expect(cancel.v.booking.status).toBe('CANCELLED');

            expect(create.ok).toBe(false);
            expect(create.e.code).toBe('BOOKING_ESCROW_LINK_CONFLICT');

            // No orphan ticket/escrow can be attached to the terminal booking.
            const bookingAfter = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(bookingAfter.status).toBe('CANCELLED');
            expect(bookingAfter.escrowId).toBeNull();
            expect(bookingAfter.ticketId).toBeNull();
            const escrows = await prisma.smartEscrow.findMany({
                where: { payerId: payer.id, status: 'DRAFT' },
            });
            expect(escrows.length).toBe(0); // rolled back with the aggregate
            const tickets = await prisma.ticket.findMany({ where: { creatorId: payer.id } });
            expect(tickets.length).toBe(0);
        } finally {
            // A failed observation must not leak parked transactions.
            try { await gate.release(); } catch (_) {}
        }
    }, 45000);

    test('C2. create/link wins first — cancellation sees the linked escrow through the shared authority, and the leftover DRAFT escrow is UNFUNDABLE on the terminal booking', async () => {
        const { payer, booking, escrow } = await seedBooking();
        const { cancelTransitBooking } = require('../services/transitBookingService');
        const before = await userBal(payer.id);

        // The create/link committed first: booking PENDING with a linked DRAFT
        // escrow. The cancellation runs through the shared escrow authority.
        const cancel = await cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id });
        expect(cancel.success).toBe(true);
        expect(cancel.booking.status).toBe('CANCELLED');
        expect(cancel.refund.outcome).toBe('NO_FUNDS'); // DRAFT — nothing locked

        // The DRAFT escrow survives (it expires naturally) but is NOT
        // fundable: the funding fails closed against the terminal booking
        // before ANY money moves.
        const fund = await escrowService.fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: payer.id,
            bookingType: 'TRANSIT', bookingId: booking.id,
        }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        expect(fund.ok).toBe(false);
        expect(fund.e.code).toBe('TRANSIT_FUNDING_CONFLICT');

        const after = await userBal(payer.id);
        expect(after.available).toBeCloseTo(before.available, 6);
        expect(after.locked).toBeCloseTo(0, 6);
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('DRAFT'); // claim rolled back — no FUNDED orphan
    }, 30000);

    // ═══════════════════════════════════════════════════════════════════════
    // D. LINKAGE + CONVERGENCE CONTRACTS (sequential, no race needed)
    // ═══════════════════════════════════════════════════════════════════════

    test('D1. caller-supplied bookingId must match the escrow-linked booking — mismatched linkage fails closed with no money moved', async () => {
        const { payer, booking, escrow } = await seedBooking();
        // A second, unlinked PENDING booking.
        const other = await prisma.transitBooking.create({
            data: {
                businessProfileId: booking.businessProfileId,
                customerId: payer.id,
                status: 'PENDING',
                pickupAddress: 'a', dropoffAddress: 'b',
                scheduledAt: new Date(Date.now() + 3600_000),
                amountUsdc: 50,
                bookingRef: `TRN-41F-${Date.now()}-x`,
            },
        });

        const fund = await escrowService.fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: payer.id,
            bookingType: 'TRANSIT', bookingId: other.id, // mismatched — NOT the linked booking
        }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

        expect(fund.ok).toBe(false);
        expect(fund.e.code).toBe('TRANSIT_FUNDING_CONFLICT');

        // Neither booking was confirmed; no money moved anywhere.
        expect((await prisma.transitBooking.findUnique({ where: { id: other.id } })).status).toBe('PENDING');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrow.id } })).status).toBe('DRAFT');
        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(200, 6);
        expect(bal.locked).toBeCloseTo(0, 6);
    }, 30000);

    test('D2. CONFIRMED and IN_PROGRESS bookings converge on funding without rewriting state — the established transit contract', async () => {
        for (const status of ['CONFIRMED', 'IN_PROGRESS']) {
            const { payer, booking, escrow } = await seedBooking({ status });

            const fund = await escrowService.fundBookingEscrow(prisma, {
                escrowId: escrow.id, payerId: payer.id,
                bookingType: 'TRANSIT', bookingId: booking.id,
            });
            expect(fund.success).toBe(true);

            // The pre-terminal state was NOT rewritten by funding.
            const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(after.status).toBe(status);
            const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(escrowAfter.status).toBe('FUNDED');
            const bal = await userBal(payer.id);
            expect(bal.locked).toBeCloseTo(50, 6);
            expect(bal.available).toBeCloseTo(200 - 50.25, 6); // 200 - principal - 0.25 fee
        }
    }, 30000);

    test('D3. PENDING funding confirms the booking atomically with the economic mutation', async () => {
        const { payer, booking, escrow } = await seedBooking();
        const fund = await escrowService.fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: payer.id,
            bookingType: 'TRANSIT', bookingId: booking.id,
        });
        expect(fund.success).toBe(true);
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status)
            .toBe('CONFIRMED');
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('FUNDED');
        const bal = await userBal(payer.id);
        expect(bal.locked).toBeCloseTo(50, 6);
        expect(await ledgerCount(escrow.id, 'ESCROW_LOCK')).toBe(1);
    }, 30000);
});
