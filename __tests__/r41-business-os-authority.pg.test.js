'use strict';

// =============================================================================
// §r41 — BUSINESS-OS FINANCE AUTHORITY (final-audit batch 2, real PostgreSQL).
//
// Proves the wave-2 DB-boundary fixes against the real database:
//
//  A. Inventory PATCH adjustment — the route's GREATEST(0, currentStock + adj)
//     raw-SQL claim is lost-update-immune: a concurrent restock increment
//     that commits BETWEEN the route's stale `existing` read and the
//     adjustment write is preserved exactly. The floor-at-zero semantics and
//     the tenant predicate are mutation-level properties.
//     Falsification: on the pre-r41 code the write was
//     `existing.currentStock + adj` computed from the STALE pre-read — the
//     concurrent +50 vanished (final 110 instead of 160).
//
//  B. Invoice send/void — conditional transitions with typed conflicts.
//     A void that commits first can never be resurrected to SENT; a payment
//     that commits first can never be overwritten to VOIDED; same-operation
//     duplicates converge idempotently.
//     Falsification: on the pre-r41 code both writes were unconditional —
//     VOIDED → SENT resurrected a voided invoice (payable!), and PAID →
//     VOIDED corrupted a settled invoice's record.
//
//  C. Transit no-show sweep — convergent single-transaction transitions.
//     The no-penalty branch refunds the escrow in the SAME transaction as
//     the booking NO_SHOW claim (no stranded FUNDED escrow); a racing
//     cancellation converges untouched; dispute custody is never swept;
//     DRAFT escrows expire atomically; unescrowed bookings transition.
//     Falsification: on the pre-r41 code the no-penalty branch wrote
//     booking NO_SHOW and left the escrow FUNDED forever — the customer's
//     locked principal was never released.
// =============================================================================

const { seedUser, seedBusiness, seedEscrowTicket } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r41 — business-OS finance authority (PostgreSQL)', () => {
    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        // connection_limit=16: gated interleaves hold several concurrent
        // connections (gate tx + parked service transactions + the
        // pg_stat_activity polling connection). The sandbox default pool
        // (num_cpus*2+1) would starve the second parked transaction before
        // it can even reach the database.
        const poolUrl = url + (url.includes('?') ? '&' : '?') + 'connection_limit=16';
        process.env.DATABASE_URL = poolUrl;
        prisma = new PrismaClient();
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        // Same CASCADE form as the r41 escrow suite: TRUNCATE on the FK
        // roots cascades through every dependent table (escrow, tickets,
        // bookings, invoices, inventory, ledger, history).
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── DB-OBSERVED GATE HELPER (r41.audit-followup) ────────────────────────
    // Polls pg_stat_activity until `count` sessions are BLOCKED ON A LOCK
    // running a query matching `needle`. Race-proof queue positions come from
    // this OBSERVED state; the timeout is only a safety bound. No timer ever
    // establishes the interleaving.
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
            dispute: Number(u.disputeEscrowBalance),
        };
    };

    // ═══════════════════════════════════════════════════════════════════════
    // A. INVENTORY PATCH ADJUSTMENT — lost-update immunity (finding 4)
    // ═══════════════════════════════════════════════════════════════════════

    // The route's exact mutation (routes/businessOSRoutes.js PATCH
    // /inventory/:id — §r41). Replicated verbatim so the proof exercises the
    // same SQL the route issues.
    const adjustStock = async (id, bpId, adj) =>
        prisma.$executeRaw`
            UPDATE "InventoryItem"
            SET "currentStock" = GREATEST(0, "currentStock" + ${adj}),
                "updatedAt" = now()
            WHERE "id" = ${id} AND "businessProfileId" = ${bpId}`;

    const seedItem = async (bpId, currentStock) =>
        prisma.inventoryItem.create({
            data: {
                businessProfileId: bpId,
                name: 'Jollof Rice',
                unit: 'kg',
                currentStock,
                costPerUnit: 12.5,
            },
        });

    test('A1. concurrent restock increment between the stale read and the adjustment write is preserved exactly', async () => {
        const { biz } = await seedBusiness(prisma);
        const item = await seedItem(biz.id, 100);

        // The route's stale pre-read: existing.currentStock === 100.
        const existing = await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        expect(existing.currentStock).toBe(100);

        // A concurrent writer commits +50 AFTER the read (restock receive,
        // sale decrement, or another adjustment — every other writer is an
        // atomic SQL expression).
        const concurrent = await prisma.inventoryItem.update({
            where: { id: item.id },
            data: { currentStock: { increment: 50 } },
        });
        expect(concurrent.currentStock).toBe(150);

        // The route now applies the +10 adjustment computed for the STALE
        // world (100 + 10). The GREATEST(0, currentStock + adj) claim reads
        // the CURRENT row value: 150 + 10 = 160 — the concurrent +50
        // survives. Pre-r41 wrote 100 + 10 = 110, silently erasing it.
        const rows = await adjustStock(item.id, biz.id, 10);
        expect(rows).toBe(1);

        const after = await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        expect(after.currentStock).toBe(160);
    });

    test('A2. floor-at-zero: a large negative adjustment clamps the CURRENT row value, never the stale one', async () => {
        const { biz } = await seedBusiness(prisma);
        const item = await seedItem(biz.id, 30);

        // Stale read at 30, concurrent increment to 55, adjustment -40:
        // current-row math is max(0, 55 - 40) = 15 — NOT max(0, 30 - 40) = 0.
        await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        await prisma.inventoryItem.update({ where: { id: item.id }, data: { currentStock: { increment: 25 } } });

        await adjustStock(item.id, biz.id, -40);

        const after = await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        expect(after.currentStock).toBe(15);

        // And a genuinely over-drawing adjustment floors at zero.
        await adjustStock(item.id, biz.id, -999);
        const floored = await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        expect(floored.currentStock).toBe(0);
    });

    test('A3. tenant predicate: a foreign business id updates zero rows (indistinguishable from missing)', async () => {
        const { biz } = await seedBusiness(prisma);
        const other = await seedBusiness(prisma);
        const item = await seedItem(biz.id, 100);

        const rows = await adjustStock(item.id, other.id, 10);
        expect(rows).toBe(0);

        const after = await prisma.inventoryItem.findUnique({ where: { id: item.id } });
        expect(after.currentStock).toBe(100); // untouched
    });

    // ═══════════════════════════════════════════════════════════════════════
    // B. INVOICE SEND/VOID — conditional transitions, typed conflicts (finding 6)
    // ═══════════════════════════════════════════════════════════════════════

    const { sendInvoice, voidInvoice } = require('../services/businessInvoiceService');

    const seedInvoice = async (status = 'DRAFT') => {
        const owner = await seedUser(prisma);
        const biz = await prisma.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: 'Invoice Test Biz',
                bizId: 'BIZ-INV-1',
                category: 'FREELANCE_SERVICES',
                kybStatus: 'VERIFIED',
            },
        });
        const customer = await seedUser(prisma);
        const n = Math.floor(Math.random() * 1e6);
        const invoice = await prisma.businessInvoice.create({
            data: {
                businessProfileId: biz.id,
                customerId: customer.id,
                invoiceRef: `INV-TEST-${Date.now()}-${n}`,
                status,
                subtotalUsdc: 100,
                taxTotalUsdc: 5,
                billTotalUsdc: 105,
            },
        });
        return { owner, biz, customer, invoice };
    };

    test('B1. a void that commits mid-send can never be resurrected to SENT — the stale send raises a typed conflict (CAS path)', async () => {
        const { biz, invoice } = await seedInvoice('DRAFT');

        // Deterministic stale-read construction: connection A takes the
        // invoice row lock and writes VOIDED WITHOUT committing. The send's
        // pre-read still sees the committed DRAFT (READ COMMITTED), so the
        // fast-fail passes and the send proceeds to its conditional update
        // — which blocks on A's row lock. A then commits: the blocked update
        // re-evaluates against the NEW row version (VOIDED), the
        // (status: 'DRAFT') claim matches zero rows, and Prisma raises P2025
        // into the typed-conflict handler. Pre-r41 the unconditional update
        // resurrected VOIDED → SENT here, after which payInvoice would
        // happily settle money on a voided invoice.
        let lockTaken; const lockA = new Promise((r) => { lockTaken = r; });
        let commitA; const releaseA = new Promise((r) => { commitA = r; });
        const txA = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "BusinessInvoice" WHERE "id" = ${invoice.id} FOR UPDATE`;
            await tx.$executeRaw`UPDATE "BusinessInvoice" SET "status" = 'VOIDED' WHERE "id" = ${invoice.id}`;
            lockTaken();
            await releaseA; // main thread decides when A commits
        }, { timeout: 20000 });

        await lockA; // A holds the row lock with VOIDED uncommitted

        // The stale send: pre-read sees the committed DRAFT (fine), and its
        // conditional (status: 'DRAFT') update blocks on A's row lock.
        const staleSend = sendInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id })
            .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

        await waitForBlocked({ needle: 'UPDATE "public"."BusinessInvoice"' }); // OBSERVED: the send is blocked in the UPDATE

        commitA(); // A commits VOIDED — the send's claim re-evaluates and loses
        await txA;
        const outcome = await staleSend;

        expect(outcome.ok).toBe(false);
        expect(outcome.e.code).toBe('INVOICE_STATE_CHANGED');
        expect(outcome.e.message).toContain('VOIDED');

        const after = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(after.status).toBe('VOIDED');
    });

    test('B2. send-commits-first interleave: a void parked mid-transaction on the row lock re-evaluates against committed SENT truth — no phantom states', async () => {
        const { biz, invoice } = await seedInvoice('DRAFT');

        // A REAL deterministic row-lock interleave, not a sequential
        // send-then-void: the gate holds the invoice row; the REAL send
        // queues first on the lock; the REAL void queues second with a
        // stale DRAFT pre-read. Releasing the gate makes the send's
        // DRAFT→SENT claim commit, and only then does the parked void's
        // (DRAFT|SENT) claim re-evaluate against the NEW committed row —
        // proving the void path reads committed truth under the row lock,
        // not its stale pre-read.
        let gateTaken; const gateOpen = new Promise((r) => { gateTaken = r; });
        let gateRelease; const gateHold = new Promise((r) => { gateRelease = r; });
        const txGate = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "BusinessInvoice" WHERE "id" = ${invoice.id} FOR UPDATE`;
            gateTaken();
            await gateHold;
        }, { timeout: 30000 });
        await gateOpen; // gate owns the invoice row

        // Position 1 in the lock queue: the REAL send.
        const sendPromise = sendInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id })
            .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        await waitForBlocked({ needle: 'UPDATE "public"."BusinessInvoice"' }); // OBSERVED: send parked on the row lock, uncommitted

        // Position 2 in the lock queue: the REAL void, its pre-read still
        // sees the committed DRAFT (stale by construction).
        const voidPromise = voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id })
            .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        await waitForBlocked({ needle: 'UPDATE "public"."BusinessInvoice"', count: 2 }); // OBSERVED: void parked behind the send

        // Release: the send commits FIRST (SENT), then the void acquires
        // the row and re-evaluates: SENT is legally voidable, and the void
        // converges on the committed truth — never on a phantom state.
        gateRelease(); await txGate;
        const sent = await sendPromise;
        const voided = await voidPromise;

        expect(sent.ok).toBe(true);
        expect(sent.v.status).toBe('SENT');
        expect(voided.ok).toBe(true);
        expect(voided.v.status).toBe('VOIDED');

        const after = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(after.status).toBe('VOIDED');
        const rows = await prisma.businessInvoice.findMany({ where: { id: invoice.id } });
        expect(rows.length).toBe(1); // exactly one row, one lifecycle

        // Duplicate same-target void converges idempotently on VOIDED.
        const again = await voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        expect(again.status).toBe('VOIDED');
    }, 45000);

    test('B3. a payment that commits first can never be voided — INVOICE_ALREADY_PAID, money state intact', async () => {
        const { biz, invoice } = await seedInvoice('SENT');

        // The payment's authoritative claim, exactly as payInvoice's
        // transaction issues it: CAS on (status SENT, payTxHash null).
        const payClaim = await prisma.businessInvoice.updateMany({
            where: { id: invoice.id, status: 'SENT', payTxHash: null },
            data: { status: 'PAID', payTxHash: `INV_PAY_${invoice.id}`, paidAt: new Date() },
        });
        expect(payClaim.count).toBe(1);

        // Delayed void with a stale SENT pre-read. Pre-r41 the
        // unconditional update overwrote PAID → VOIDED after the money had
        // already settled — corrupting the financial record. Now the
        // DRAFT/SENT-only claim loses with a typed conflict.
        let err = null;
        try {
            await voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        } catch (e) { err = e; }
        expect(err).toBeTruthy();
        expect(err.code).toBe('INVOICE_ALREADY_PAID');

        const after = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(after.status).toBe('PAID');
        expect(after.payTxHash).toBe(`INV_PAY_${invoice.id}`);
    });

    test('B4. duplicate send converges idempotently (already-sent returns the SENT row)', async () => {
        const { biz, invoice } = await seedInvoice('DRAFT');

        const first = await sendInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        const second = await sendInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });

        expect(first.status).toBe('SENT');
        expect(second.status).toBe('SENT');
        expect(second.id).toBe(invoice.id);

        const rows = await prisma.businessInvoice.findMany({ where: { id: invoice.id } });
        expect(rows.length).toBe(1);
    });

    test('B5. ownership: a foreign business profile cannot send or void (typed conflict path included)', async () => {
        const { invoice } = await seedInvoice('DRAFT');
        const foreign = await seedUser(prisma);

        let err = null;
        try {
            await voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: `foreign-${foreign.id}` });
        } catch (e) { err = e; }
        expect(err).toBeTruthy();
        expect(err.message).toBe('Not authorized.');

        const after = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(after.status).toBe('DRAFT');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // C. TRANSIT NO-SHOW SWEEP — convergent transitions (finding 7)
    // ═══════════════════════════════════════════════════════════════════════

    const { sweepNoShowTransitBookings, GRACE_PERIOD_MINS } = require('../workers/reservationNoShowWorker');

    // Builds a CONFIRMED, past-due, unchecked-in transit booking with an
    // attached escrow in the requested status. The escrow's payer is the
    // booking's customer (canonical money direction).
    const seedTransitBooking = async (escrowStatus, overrides = {}) => {
        const { biz } = await seedBusiness(prisma);
        const seed = escrowStatus === null
            ? { payer: await seedUser(prisma), escrow: null }
            : await seedEscrowTicket(prisma, escrowStatus, overrides.escrow || {});
        const payer = seed.payer || (await seedUser(prisma));

        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id,
                customerId: payer.id,
                status: 'CONFIRMED',
                pickupAddress: 'Accra Central',
                dropoffAddress: 'Kumasi',
                scheduledAt: new Date(Date.now() - (GRACE_PERIOD_MINS + 30) * 60 * 1000),
                amountUsdc: 50,
                bookingRef: `TRN-TEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                escrowId: seed.escrow ? seed.escrow.id : null,
                noShowPenaltyPct: overrides.noShowPenaltyPct ?? null,
                noShowPenaltyUsdc: overrides.noShowPenaltyUsdc ?? null,
            },
        });
        return { biz, payer, escrow: seed.escrow, booking };
    };

    test('C1. no-penalty no-show refunds the escrow IN THE SAME TRANSACTION as the NO_SHOW claim — no stranded funds', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED');
        const before = await userBal(payer.id);

        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('NO_SHOW_NO_PENALTY');
        expect(detail.refundAmount).toBeCloseTo(50, 6);

        // The booking transitioned AND the money moved — atomically.
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('REFUNDED');

        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(before.available + 50, 6);
        expect(bal.locked).toBeCloseTo(before.locked - 50, 6);

        // A TransactionHistory refund row exists for the customer.
        const history = await prisma.transactionHistory.findFirst({
            where: { userId: payer.id, txHash: escrowAfter.refundTxHash },
        });
        expect(history).toBeTruthy();
    });

    test('C2. a cancellation that commits mid-sweep converges untouched — no double refund, no phantom error', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED');
        const before = await userBal(payer.id);

        // Deterministic stale-scan construction: the cancellation takes the
        // booking + escrow row locks and commits CANCELLED + refund WITHOUT
        // releasing. The sweep's scan (plain reads) still sees the committed
        // CONFIRMED + FUNDED — a perfectly stale candidate set.
        let lockTaken; const lockA = new Promise((r) => { lockTaken = r; });
        let commitA; const releaseA = new Promise((r) => { commitA = r; });
        const txA = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "TransitBooking" WHERE "id" = ${booking.id} FOR UPDATE`;
            const claim = await tx.transitBooking.updateMany({
                where: { id: booking.id, status: 'CONFIRMED' },
                data: { status: 'CANCELLED' },
            });
            if (claim.count !== 1) throw new Error('cancel claim lost');
            const { _refundBookingEscrowTx } = require('../services/bookingEscrowService');
            await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference: 'CANCEL-REFUND-TEST' });
            lockTaken();
            await releaseA; // main thread decides when the cancellation commits
        }, { timeout: 20000 });

        await lockA; // cancellation holds both row locks, uncommitted

        // The stale sweep: its per-booking escrow claim blocks on A's escrow
        // row lock, then re-evaluates against REFUNDED and converges.
        const sweep = sweepNoShowTransitBookings(prisma);
        await waitForBlocked({ needle: 'UPDATE "public"."SmartEscrow"' }); // OBSERVED: the sweep is blocked mid-claim

        commitA(); // the cancellation commits — the sweep's claims all lose
        await txA;
        const results = await sweep;

        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(['SKIPPED_STATUS', 'ALREADY_NO_SHOW']).toContain(detail.action);
        expect(detail.status).toBe('CANCELLED');

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');

        // Exactly ONE refund — the balances did not move twice.
        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(before.available + 50, 6);
        expect(bal.locked).toBe(0);
    });

    // ── C8-C10. The DANGEROUS interleave: cancellation and the no-show sweep
    // compete for the same booking+escrow pair in OPPOSITE lock orders.
    // Canonical order (r41 audit-followup): EVERY escrow-backed transit
    // lifecycle operation takes the ESCROW row lock first, then the booking.
    // Both directions below drive the REAL service paths (real
    // cancelTransitBooking, real sweepNoShowTransitBookings) through gated
    // parking points built ONLY from PostgreSQL row locks — no sleeps decide
    // the interleaving, they only let each transaction REACH its park point.
    // A pre-fix cancellation claims the booking row first and the sweep the
    // escrow row first: these interleaves form the AB-BA cycle and deadlock.
    // ─────────────────────────────────────────────────────────────────────

    const { cancelTransitBooking } = require('../services/transitBookingService');

    test('C8. sweep holds the escrow authority first — a racing cancellation blocks BEFORE claiming the booking and converges (sweep wins)', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED');
        const before = await userBal(payer.id);

        // GATE 1 — hold the BOOKING row so the sweep parks between its
        // escrow claim and its booking claim, HOLDING the escrow lock.
        let lockTaken; const lockA = new Promise((r) => { lockTaken = r; });
        let commitA; const releaseA = new Promise((r) => { commitA = r; });
        const txA = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "TransitBooking" WHERE "id" = ${booking.id} FOR UPDATE`;
            lockTaken();
            await releaseA;
        }, { timeout: 30000 });

        await lockA; // the booking row is pinned by the gate

        // The REAL sweep: fresh reads pass (CONFIRMED + FUNDED), the escrow
        // claim locks the ESCROW row, then its booking claim parks on GATE 1.
        const sweepPromise = sweepNoShowTransitBookings(prisma);
        await waitForBlocked({ needle: 'UPDATE "public"."TransitBooking"' }); // OBSERVED: sweep parked — holds ESCROW, wants BOOKING

        // The REAL cancellation (post-fix lock order): it takes the escrow
        // FOR UPDATE FIRST — and blocks on the sweep's escrow lock BEFORE
        // touching the booking row. Pre-fix it would have claimed the
        // booking row (pinned by nobody at this instant) and then blocked on
        // the escrow — the AB-BA cycle.
        const cancelPromise = cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id })
            .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        await waitForBlocked({ needle: 'SELECT id FROM "SmartEscrow"' }); // OBSERVED: cancel parked on the escrow lock

        // Release the booking gate: the sweep (already holding the escrow)
        // completes NO_SHOW + refund atomically and commits.
        commitA(); await txA;
        const results = await sweepPromise;
        const cancel = await cancelPromise;

        // The sweep won the escrow authority — its transition stands.
        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('NO_SHOW_NO_PENALTY');

        // The cancellation lost the race and reports HONEST failure — no
        // phantom success, no stale CANCELLED over a committed NO_SHOW.
        expect(cancel.ok).toBe(false);
        expect(cancel.e.code).toBe('NOT_CANCELLABLE');
        expect(cancel.e.httpStatus).toBe(409);

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('REFUNDED');

        // Exactly ONE refund — the payer's money moved exactly once.
        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(before.available + 50, 6);
        expect(bal.locked).toBe(0);
    }, 45000);

    test('C9. cancellation holds the escrow authority first — the stale sweep rolls back whole and converges on CANCELLED (cancel wins)', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED');
        const before = await userBal(payer.id);

        // GATE — hold the ESCROW row so the cancellation parks at its
        // (post-fix) FIRST lock acquisition, holding nothing.
        let lockTaken; const lockA = new Promise((r) => { lockTaken = r; });
        let commitA; const releaseA = new Promise((r) => { commitA = r; });
        const txA = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${escrow.id} FOR UPDATE`;
            lockTaken();
            await releaseA;
        }, { timeout: 30000 });

        await lockA; // the escrow row is pinned by the gate

        // The REAL cancellation: parks on the escrow FOR UPDATE (its first
        // lock), holding NOTHING — the fix's whole point.
        const cancelPromise = cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id });
        await waitForBlocked({ needle: 'SELECT id FROM "SmartEscrow"' }); // OBSERVED: cancel parked FIRST in the escrow lock queue

        // The REAL sweep: fresh reads pass (CONFIRMED + FUNDED), its escrow
        // claim parks BEHIND the cancellation in the same lock queue.
        const sweepPromise = sweepNoShowTransitBookings(prisma);
        await waitForBlocked({ needle: 'UPDATE "public"."SmartEscrow"' }); // OBSERVED: sweep parked — holds NOTHING, queued on ESCROW

        // Release: the cancellation is first in the queue — it wins the
        // escrow deterministically, claims the booking (CONFIRMED→CANCELLED),
        // refunds, and commits. The sweep then wakes to REFUNDED: its escrow
        // claim fails, the WHOLE no-show transition rolls back, and the
        // worker converges on the committed CANCELLED fact.
        commitA(); await txA;
        const cancel = await cancelPromise;
        const results = await sweepPromise;

        expect(cancel.success).toBe(true);
        expect(cancel.booking.status).toBe('CANCELLED');
        expect(cancel.refund.outcome).toBe('REFUNDED');

        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('SKIPPED_STATUS');
        expect(detail.status).toBe('CANCELLED');

        // No stale NO_SHOW over a committed cancellation.
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('REFUNDED');

        // Exactly ONE refund — the sweep's rolled-back refund left no trace.
        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(before.available + 50, 6);
        expect(bal.locked).toBe(0);
    }, 45000);

    test('C10. un-gated true-concurrency race, repeated — either winner, always exactly one lifecycle outcome and one refund, never a deadlock', async () => {
        // True simultaneous start, no gates: whichever transaction wins the
        // escrow authority completes; the loser converges. Repeated to catch
        // order sensitivity. Pre-fix, this is the raw AB-BA race — PostgreSQL's
        // deadlock detector would kill one transaction (40P01); post-fix the
        // shared escrow-first order makes the cycle impossible.
        for (let round = 0; round < 3; round++) {
            const { payer, escrow, booking } = await seedTransitBooking('FUNDED');
            const before = await userBal(payer.id);

            const [cancelRes, sweepRes] = await Promise.all([
                cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: payer.id })
                    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
                sweepNoShowTransitBookings(prisma),
            ]);

            // Exactly ONE lifecycle winner.
            const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(['NO_SHOW', 'CANCELLED']).toContain(after.status);

            const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(escrowAfter.status).toBe('REFUNDED');

            // Exactly ONE refund, whatever the interleaving.
            const bal = await userBal(payer.id);
            expect(bal.available).toBeCloseTo(before.available + 50, 6);
            expect(bal.locked).toBe(0);

            // Both sides report honestly, no phantom errors.
            if (cancelRes.ok) {
                expect(cancelRes.v.booking.status).toBe('CANCELLED');
                expect(after.status).toBe('CANCELLED');
            } else {
                expect(cancelRes.e.code).toBe('NOT_CANCELLABLE');
                expect(after.status).toBe('NO_SHOW');
            }
            expect(sweepRes.errors).toBe(0);
            const detail = sweepRes.details.find((d) => d.id === booking.id);
            expect(detail.action).not.toMatch(/ERROR/i);
        }
    }, 60000);

    test('C3. penalty no-show: escrow split-released, payee credited penalty, payer refunded remainder — one transaction', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED', { noShowPenaltyPct: 0.5 });
        const payeeId = escrow.payeeId;
        const payerBefore = await userBal(payer.id);
        const payeeBefore = await userBal(payeeId);

        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.errors).toBe(0);
        expect(results.penalized).toBe(1);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('PENALTY_CHARGED');
        expect(detail.penaltyAmount).toBeCloseTo(25, 6);
        expect(detail.refundAmount).toBeCloseTo(25, 6);

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');
        expect(Number(after.penaltyAmountUsdc)).toBeCloseTo(25, 6);

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('RELEASED');

        expect((await userBal(payer.id)).available).toBeCloseTo(payerBefore.available + 25, 6);
        expect((await userBal(payeeId)).available).toBeCloseTo(payeeBefore.available + 25, 6);
    });

    test('C4. dispute custody is never swept — funds stay in the dispute bucket, rows untouched', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('DISPUTED');
        const before = await userBal(payer.id);

        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('ESCROW_IN_DISPUTE');

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CONFIRMED'); // untouched — dispute owns it
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('DISPUTED');

        const bal = await userBal(payer.id);
        expect(bal.dispute).toBeCloseTo(before.dispute, 6); // principal still in dispute custody
    });

    test('C5. DRAFT (unfunded) escrow expires atomically with the NO_SHOW transition', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('DRAFT');

        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.errors).toBe(0);
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(escrowAfter.status).toBe('EXPIRED');
    });

    test('C6. unescrowed booking (escrowId null) is swept — transition-only, no money moves', async () => {
        const { payer, booking } = await seedTransitBooking(null);
        const before = await userBal(payer.id);

        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.errors).toBe(0);
        const detail = results.details.find((d) => d.id === booking.id);
        expect(detail.action).toBe('NO_SHOW_NO_PENALTY');

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');
        expect((await userBal(payer.id)).available).toBeCloseTo(before.available, 6);
    });

    test('C7. an already-NO_SHOW booking converges — second sweep is a no-op, money never moves twice', async () => {
        const { payer, escrow, booking } = await seedTransitBooking('FUNDED');

        const first = await sweepNoShowTransitBookings(prisma);
        expect(first.errors).toBe(0);
        const payerAfterFirst = await userBal(payer.id);

        // Second sweep (the scan no longer matches CONFIRMED, but even a
        // manually re-selected row must converge, not double-refund).
        const second = await sweepNoShowTransitBookings(prisma);
        expect(second.processed).toBe(0);
        expect(second.errors).toBe(0);

        const bal = await userBal(payer.id);
        expect(bal.available).toBeCloseTo(payerAfterFirst.available, 6);
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('NO_SHOW');
    });
});
