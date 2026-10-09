// __tests__/r272-withdrawal-rbac-tier-enforcement.test.js
// =============================================================================
// r272 finding 3 — advisory-only RBAC, real-PostgreSQL proof that the declared
// approval tiers are now AUTHORITATIVE at the withdrawal-approval boundary.
//
// Pre-fix defect: APPROVAL_TIERS (>= $10k → 2 approvals, >= $50k → 3 with
// Finance/Compliance participation) and the whole AdminApprovalRequest
// workflow were enforced only when a NEW request was created — the endpoint
// that actually flipped a withdrawal to APPROVED never consulted them. Any
// ADMIN could single-handedly approve a withdrawal of ANY size; the
// AdminApprovalRequest ledger was pure ceremony.
//
// Post-fix contract proven here through the REAL controller on real
// PostgreSQL:
//   1. Sub-tier withdrawal (< $10k): a single authorized admin approval still
//      succeeds — no ceremony invented for small amounts.
//   2. ≥ $10k with NO quorum-approved request → 403
//      WITHDRAWAL_APPROVAL_QUORUM_REQUIRED, withdrawal stays PENDING.
//   3. ≥ $10k with an APPROVED request → success, and the request is
//      consumed EXACTLY ONCE (APPROVED → EXECUTED, executedAt stamped).
//   4. The consumed request cannot authorize a SECOND high-value withdrawal
//      (single-use consumption — the replay gets 403, not a free ride).
//   5. An admin whose role lacks withdrawals.approve is refused before
//      economics (action-permission gate).
//   6. Two concurrent approvals of the same ≥ $10k withdrawal → exactly one
//      commits; the loser gets a deterministic 409, the request is consumed
//      once, and the withdrawal flips once.
//   7. A role WITHOUT the action permission cannot bypass the quorum by
//      approving a sub-$1k... (covered by 5) — and CRITICAL: the quorum path
//      requires the request's OWN quorum logic to have run; consumption
//      here never re-derives WHO approved, only that the request reached
//      APPROVED through the RBAC controller's own enforcement.
//
// Against the pre-fix implementation tests 2 and 6 fail: the withdrawal
// flips APPROVED with no quorum at all.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-withdrawal-rbac] TEST_DATABASE_URL not set — skipping.');

const { PrismaClient } = require('@prisma/client');

describeOrSkip('r272 RBAC approval tiers are enforced on approveWithdrawal (real PostgreSQL)', () => {
    let prisma, ctrl, admin, financeAdmin, member;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        ctrl = require('../controllers/adminController');

        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        admin = await prisma.user.create({
            data: {
                username: `r272rbac_admin_${uniq}`,
                email: `r272rbac_admin_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN',
            },
        });
        // NOTE: the Prisma Role enum only has USER/VENDOR/ADMIN; the RBAC
        // catalog's FINANCE_ADMIN / COMPLIANCE_ADMIN / SUPER_ADMIN identities
        // live inside the approvals JSON of the AdminApprovalRequest, not as
        // persisted user roles (checkAdminPermission treats plain ADMIN as
        // legacy full admin, which holds withdrawals.approve).
        financeAdmin = await prisma.user.create({
            data: {
                username: `r272rbac_fin_${uniq}`,
                email: `r272rbac_fin_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN',
            },
        });
        member = await prisma.user.create({
            data: {
                username: `r272rbac_member_${uniq}`,
                email: `r272rbac_member_${uniq}@test.local`,
                password: 'test_password',
                role: 'USER',
                availableBalance: 1000000,
            },
        });
    });

    afterAll(async () => {
        if (!prisma) return;
        await prisma.transactionHistory.deleteMany({ where: { userId: member.id } });
        await prisma.withdrawal.deleteMany({ where: { userId: member.id } });
        await prisma.adminApprovalRequest.deleteMany({ where: { requestedBy: { in: [admin.id, financeAdmin.id] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [admin.id, financeAdmin.id] } } });
        await prisma.user.deleteMany({ where: { id: { in: [admin.id, financeAdmin.id, member.id] } } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.withdrawal.deleteMany({ where: { userId: member.id } });
        await prisma.adminApprovalRequest.deleteMany({ where: { requestedBy: { in: [admin.id, financeAdmin.id] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [admin.id, financeAdmin.id] } } });
    });

    // Minimal express-like stand-ins — the controller reads app services and
    // writes notifications best-effort; none of them are on the money path
    // under test here.
    function makeReq(user, withdrawalId) {
        return {
            params: { id: String(withdrawalId) },
            body: { adminNotes: 'r272 test' },
            user: { id: user.id, role: user.role, username: user.username },
            app: {
                get(k) {
                    if (k === 'prisma') return prisma;
                    if (k === 'socketio') return { to: () => ({ emit: () => {} }), emit: () => {} };
                    if (k === 'emitBalanceUpdate') return () => {};
                    if (k === 'notificationService') return { sendNotification: async () => {} };
                    return undefined;
                },
            },
        };
    }
    function makeRes() {
        const r = { _status: 200, _body: null };
        r.status = (s) => { r._status = s; return r; };
        r.json = (b) => { r._body = b; return r; };
        return r;
    }

    async function seedWithdrawal(amount) {
        const w = await prisma.withdrawal.create({
            data: {
                userId: member.id,
                amount,
                payoutMethod: 'MOMO',
                network: 'MTN',
                destination: '0240000000',
                status: 'PENDING',
            },
        });
        return w;
    }

    async function seedApprovedRequest(withdrawalId, { amount = 15000, requiredApprovals = 2 } = {}) {
        return prisma.adminApprovalRequest.create({
            data: {
                type: 'WITHDRAWAL',
                entityId: String(withdrawalId),
                amount,
                description: 'r272 tier quorum test',
                metadata: { withdrawalId },
                requestedBy: admin.id,
                requiredApprovals,
                approvals: [
                    { userId: financeAdmin.id, role: 'FINANCE_ADMIN', at: new Date().toISOString() },
                    { userId: admin.id, role: 'ADMIN', at: new Date().toISOString() },
                ],
                status: 'APPROVED',
                approvedBy: financeAdmin.id,
                approvedAt: new Date(),
            },
        });
    }

    test('sub-tier withdrawal (< $10k): single admin approval still succeeds', async () => {
        const w = await seedWithdrawal(500);
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        expect(res._status).toBe(200);
        expect(res._body.success).toBe(true);
        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('APPROVED');
    });

    test('≥ $10k with NO quorum-approved request → 403, withdrawal stays PENDING', async () => {
        const w = await seedWithdrawal(15000);
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        expect(res._status).toBe(403);
        expect(res._body.code).toBe('WITHDRAWAL_APPROVAL_QUORUM_REQUIRED');
        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('PENDING'); // nothing moved
    });

    test('≥ $10k with an APPROVED request → success; request consumed exactly once', async () => {
        const w = await seedWithdrawal(15000);
        const reqRow = await seedApprovedRequest(w.id);
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        expect(res._status).toBe(200);
        expect(res._body.success).toBe(true);

        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('APPROVED');

        const consumed = await prisma.adminApprovalRequest.findUnique({ where: { id: reqRow.id } });
        expect(consumed.status).toBe('EXECUTED'); // single-use consumption
        expect(consumed.executedAt).not.toBeNull();
    });

    test('a consumed request cannot authorize a SECOND high-value withdrawal', async () => {
        const w1 = await seedWithdrawal(15000);
        await seedApprovedRequest(w1.id);
        await ctrl.approveWithdrawal(makeReq(admin, w1.id), makeRes());
        const w1After = await prisma.withdrawal.findUnique({ where: { id: w1.id } });
        expect(w1After.status).toBe('APPROVED');

        const w2 = await seedWithdrawal(20000);
        const res2 = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w2.id), res2);
        expect(res2._status).toBe(403); // the EXECUTED request does not transfer
        const w2After = await prisma.withdrawal.findUnique({ where: { id: w2.id } });
        expect(w2After.status).toBe('PENDING');
    });

    test('a role without withdrawals.approve is refused before economics', async () => {
        const w = await seedWithdrawal(500);
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(member, w.id), res);
        expect(res._status).toBe(403);
        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('PENDING');
    });

    test('concurrent approvals of the same ≥ $10k withdrawal → one commit, one 409, one consumption', async () => {
        const w = await seedWithdrawal(30000);
        // P0 follow-up: the evidence must now match the AUTHORITATIVE tier
        // for 30,000 (>= $10k → 2 approvals). The old fixture seeded a
        // 3-approval request that 30,000 never required — exactly the
        // misleading-evidence mismatch the binding fix refuses.
        await seedApprovedRequest(w.id, { amount: 30000, requiredApprovals: 2 });

        const r1 = makeRes();
        const r2 = makeRes();
        await Promise.all([
            ctrl.approveWithdrawal(makeReq(admin, w.id), r1),
            ctrl.approveWithdrawal(makeReq(admin, w.id), r2),
        ]);
        const statuses = [r1._status, r2._status].sort();
        expect(statuses).toEqual([200, 409]);

        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('APPROVED'); // flipped exactly once

        const executed = await prisma.adminApprovalRequest.findMany({
            where: { type: 'WITHDRAWAL', entityId: String(w.id), status: 'EXECUTED' },
        });
        expect(executed).toHaveLength(1); // consumed exactly once
    });
});
