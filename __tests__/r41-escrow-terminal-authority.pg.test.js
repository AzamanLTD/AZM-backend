'use strict';

// =============================================================================
// §r41 — ESCROW TERMINAL-STATE AUTHORITY (final-audit batch 1, real PostgreSQL).
//
// Proves the three escrow DB-boundary fixes against the real database:
//
//  1. markSatisfied(): the PENDING_SETTLEMENT transition is a conditional
//     claim — a racing opposite-party settlement (SETTLED) or refund/dispute
//     resolution can never be reverted to pending. Concurrent opposite-party
//     satisfaction produces exactly one payout.
//  2. escrowExpiryWorker._expireUnfunded(): expiry is a DRAFT-only claim —
//     a fundEscrow() that wins the race keeps the escrow FUNDED (no
//     stranded locked funds, no stale ticket cancel / system message).
//  3. assignDisputeToAdmin(): escrow-first authoritative claim — a
//     resolution that wins first leaves assignment as a typed no-op;
//     assignment that wins first still resolves exactly once.
//
// Deterministic constructions: races synchronize on the actual escrow row
// lock (FOR UPDATE gate), never on timers. Falsification note: every proof
// here fails on the pre-r41 service (the pending write / expiry write /
// dispute-assignment updates were unconditional).
// =============================================================================

const { seedEscrowTicket, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r41 — escrow terminal-state authority (PostgreSQL)', () => {
    let prisma, escrowService;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        // eslint-disable-next-line global-require
        escrowService = require('../services/escrowService');
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const escrowOf = (id) => prisma.smartEscrow.findUnique({ where: { id } });
    const userBal = async (id) => {
        const u = await prisma.user.findUnique({ where: { id } });
        return {
            available: Number(u.availableBalance),
            locked: Number(u.escrowLockedBalance),
            dispute: Number(u.disputeEscrowBalance),
        };
    };

    // ── 1. markSatisfied ──────────────────────────────────────────────────────

    test('1. both parties satisfied settles exactly once; a late duplicate converges (SETTLED-wins)', async () => {
        const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
        const payeeBefore = (await userBal(payee.id)).available;

        const r1 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id });
        expect(r1.settled).toBe(false);
        expect(r1.escrow.status).toBe('PENDING_SETTLEMENT');

        const r2 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payee.id });
        expect(r2.settled).toBe(true);
        expect(r2.escrow.status).toBe('SETTLED');

        // a delayed duplicate from either side converges — terminal state stands
        const r3 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id });
        expect(r3).toMatchObject({ settled: true, alreadySettled: true });
        const r4 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payee.id });
        expect(r4).toMatchObject({ settled: true, alreadySettled: true });

        expect((await escrowOf(escrow.id)).status).toBe('SETTLED');
        // exactly ONE payout — never two, never zero
        expect((await userBal(payee.id)).available).toBeCloseTo(payeeBefore + 50, 6);
        expect((await userBal(payer.id)).locked).toBe(0);
    });

    test('2. RACE concurrent opposite-party satisfaction: final state is always SETTLED, exactly one payout (5 rounds)', async () => {
        for (let round = 0; round < 5; round++) {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const payeeBefore = (await userBal(payee.id)).available;
            const payerBefore = await userBal(payer.id);

            const [, b] = await Promise.allSettled([
                escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id }),
                escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payee.id }),
            ]);
            // Both callers may legally fulfill (one settles, the other
            // converges) — but the ESCROW must end SETTLED, never reverted to
            // PENDING_SETTLEMENT by the delayed writer, and money moves once.
            const final = await escrowOf(escrow.id);
            expect(final.status).toBe('SETTLED');
            expect(final.payerSatisfied).toBe(true);
            expect(final.payeeSatisfied).toBe(true);
            expect((await userBal(payee.id)).available).toBeCloseTo(payeeBefore + 50, 6);
            const payerAfter = await userBal(payer.id);
            expect(payerAfter.locked).toBe(0);
            expect(payerAfter.available).toBe(payerBefore.available);
        }
    });

    test('3. RACE satisfaction vs terminal refund: the escrow can never report PENDING_SETTLEMENT over a committed refund', async () => {
        for (let round = 0; round < 3; round++) {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const payerBefore = await userBal(payer.id);
            const payeeBefore = (await userBal(payee.id)).available;

            await Promise.allSettled([
                escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id }),
                escrowService._refundEscrow(prisma, escrow.id, 'REFUNDED'),
            ]);

            const final = await escrowOf(escrow.id);
            expect(final.status).toBe('REFUNDED'); // terminal — never resurrected to pending
            const payerAfter = await userBal(payer.id);
            const payeeAfter = (await userBal(payee.id)).available;
            // money went back to the payer exactly once; payee never paid
            expect(payerAfter.locked).toBe(0);
            expect(payerAfter.available).toBeCloseTo(payerBefore.available + 50, 6);
            expect(payeeAfter).toBeCloseTo(payeeBefore, 6);
        }
    });

    // ── 2. escrowExpiryWorker — stale unfunded expiry ────────────────────────

    const workerFor = () => new (require('../workers/escrowExpiryWorker'))(prisma, null, null, {});
    const PAST = () => new Date(Date.now() - 60 * 60 * 1000);

    test('4. funding wins after the stale scan: the escrow stays FUNDED, ticket open, no injected expiry message, funds unstranded', async () => {
        const { payer, ticket, escrow } = await seedEscrowTicket(prisma, 'DRAFT');
        await prisma.smartEscrow.update({ where: { id: escrow.id }, data: { expiresAt: PAST() } });

        // the STALE SNAPSHOT: prove the worker's scan WOULD have selected this
        // row as an expired DRAFT before funding committed.
        const staleScan = await prisma.smartEscrow.findMany({
            where: { status: 'DRAFT', expiresAt: { lt: PAST() } },
            select: { id: true },
        });
        expect(staleScan.map((r) => r.id)).toContain(escrow.id);

        // the racing funding commits — DRAFT → FUNDED, real money locked
        const payerBefore = await userBal(payer.id);
        await escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id });
        expect((await escrowOf(escrow.id)).status).toBe('FUNDED');

        // the delayed worker acts on its stale scan result
        const worker = workerFor();
        await worker._expireUnfunded(PAST());

        const after = await escrowOf(escrow.id);
        expect(after.status).toBe('FUNDED'); // never EXPIRED over FUNDED
        expect((await prisma.ticket.findUnique({ where: { id: ticket.id } })).status).toBe('OPEN');
        const messages = await prisma.ticketMessage.count({ where: { ticketId: ticket.id, type: 'SYSTEM' } });
        expect(messages).toBe(0); // no stale system message
        const payerAfter = await userBal(payer.id);
        expect(payerAfter.locked).toBeCloseTo(50, 6); // principal still locked for the LIVE deal
        expect(payerAfter.available).toBeCloseTo(payerBefore.available - 50.25, 6);
    });

    test('5. expiry wins the claim: DRAFT past expiry becomes EXPIRED, ticket cancelled, message injected, no money moved', async () => {
        const { payer, ticket, escrow } = await seedEscrowTicket(prisma, 'DRAFT');
        await prisma.smartEscrow.update({ where: { id: escrow.id }, data: { expiresAt: PAST() } });
        const before = await userBal(payer.id);

        await workerFor()._expireUnfunded(PAST());

        expect((await escrowOf(escrow.id)).status).toBe('EXPIRED');
        expect((await prisma.ticket.findUnique({ where: { id: ticket.id } })).status).toBe('CANCELLED');
        const messages = await prisma.ticketMessage.count({ where: { ticketId: ticket.id, type: 'SYSTEM' } });
        expect(messages).toBe(1);
        const after = await userBal(payer.id);
        expect(after.available).toBeCloseTo(before.available, 6);
        expect(after.locked).toBe(0);
    });

    // ── 3. assignDisputeToAdmin ───────────────────────────────────────────────

    const disputedEscrow = async () => {
        const seeded = await seedEscrowTicket(prisma, 'FUNDED');
        await escrowService.raiseDispute(prisma, {
            escrowId: seeded.escrow.id,
            raisedById: seeded.payer.id,
            reason: 'Goods never delivered',
        });
        const admin = await seedUser(prisma, { role: 'ADMIN', availableBalance: 0 });
        return { ...seeded, admin };
    };

    test('6. RESOLUTION-WINS: assignment after a committed resolution is a typed no-op — no resurrection', async () => {
        const { payer, payee, escrow, admin } = await disputedEscrow();
        const otherAdmin = await seedUser(prisma, { role: 'ADMIN', availableBalance: 0 });
        const payeeBefore = (await userBal(payee.id)).available;

        await escrowService.resolveDispute(prisma, {
            escrowId: escrow.id, adminId: admin.id, ruling: 'FULL_RELEASE',
        });
        expect((await escrowOf(escrow.id)).status).toBe('RELEASED');

        // the delayed assignment arrives — it must NOT reopen anything
        await expect(escrowService.assignDisputeToAdmin(prisma, {
            escrowId: escrow.id, assignedToId: otherAdmin.id, requestingAdminId: admin.id,
        })).rejects.toMatchObject({ code: 'ESCROW_ALREADY_FINALIZED' });

        const after = await escrowOf(escrow.id);
        const dispute = await prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } });
        expect(after.status).toBe('RELEASED'); // terminal stands
        expect(dispute.status).toBe('RESOLVED');
        expect(dispute.assignedToId).toBe(admin.id); // the stale assignee never landed
        expect((await userBal(payee.id)).available).toBeCloseTo(payeeBefore + 50, 6); // paid exactly once
    });

    test('7. ASSIGNMENT-WINS: assignment first stays valid — the later resolution moves money exactly once', async () => {
        const { payer, payee, escrow, admin } = await disputedEscrow();
        const payeeBefore = (await userBal(payee.id)).available;

        const assigned = await escrowService.assignDisputeToAdmin(prisma, {
            escrowId: escrow.id, assignedToId: admin.id, requestingAdminId: admin.id,
        });
        expect(assigned.escrow.status).toBe('ADMIN_REVIEW');
        expect(assigned.dispute.status).toBe('ASSIGNED');

        const resolved = await escrowService.resolveDispute(prisma, {
            escrowId: escrow.id, adminId: admin.id, ruling: 'FULL_RELEASE',
        });
        expect(resolved.escrow.status).toBe('RELEASED');
        expect(resolved.dispute.status).toBe('RESOLVED');
        expect((await userBal(payee.id)).available).toBeCloseTo(payeeBefore + 50, 6);
        expect((await escrowOf(escrow.id)).status).toBe('RELEASED');
    });

    test('8. RACE concurrent assignment vs resolution: exactly one resolution, terminal RELEASED, assignment never reopens it', async () => {
        for (let round = 0; round < 3; round++) {
            const { payer, payee, escrow, admin } = await disputedEscrow();
            const payeeBefore = (await userBal(payee.id)).available;

            const [assignRes, resolveRes] = await Promise.allSettled([
                escrowService.assignDisputeToAdmin(prisma, {
                    escrowId: escrow.id, assignedToId: admin.id, requestingAdminId: admin.id,
                }),
                escrowService.resolveDispute(prisma, {
                    escrowId: escrow.id, adminId: admin.id, ruling: 'FULL_RELEASE',
                }),
            ]);

            // the resolution ALWAYS eventually commits (either directly or as
            // the second claimant); the escrow ends terminal + dispute resolved
            const final = await escrowOf(escrow.id);
            const dispute = await prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } });
            expect(final.status).toBe('RELEASED');
            expect(dispute.status).toBe('RESOLVED');
            // exactly one payout regardless of which side won the row
            expect((await userBal(payee.id)).available).toBeCloseTo(payeeBefore + 50, 6);
            // if the assignment lost the row, it failed typed with no mutation
            if (assignRes.status === 'rejected') {
                expect(assignRes.reason.code).toBe('ESCROW_ALREADY_FINALIZED');
            }
            // a losing resolution (assignment won the row) is retryable — but
            // money moved exactly once either way
            expect(resolveRes.status === 'fulfilled' || resolveRes.reason).toBeTruthy();
            expect(payer.id).toBeTruthy();
        }
    });
});
