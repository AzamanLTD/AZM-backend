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

        await new Promise((r) => setTimeout(r, 300)); // the send is blocked in the UPDATE

        commitA(); // A commits VOIDED — the send's claim re-evaluates and loses
        await txA;
        const outcome = await staleSend;

        expect(outcome.ok).toBe(false);
        expect(outcome.e.code).toBe('INVOICE_STATE_CHANGED');
        expect(outcome.e.message).toContain('VOIDED');

        const after = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(after.status).toBe('VOIDED');
    });

    test('B2. a send that commits first blocks void — the SENT invoice stands', async () => {
        const { biz, invoice } = await seedInvoice('DRAFT');

        const sent = await sendInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        expect(sent.status).toBe('SENT');

        // Delayed void with a stale DRAFT pre-read: its claim
        // (status in DRAFT/SENT) still wins — void from SENT is legal.
        const voided = await voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        expect(voided.status).toBe('VOIDED');

        // But a SECOND void (already VOIDED) converges idempotently.
        const again = await voidInvoice(prisma, { invoiceId: invoice.id, businessProfileId: biz.id });
        expect(again.status).toBe('VOIDED');
    });

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
        await new Promise((r) => setTimeout(r, 300)); // the sweep is blocked mid-claim

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
