// __tests__/r272-withdrawal-approval-evidence-binding.test.js
// =============================================================================
// P0 (r272 follow-up) — approval-evidence BINDING on the withdrawal approval
// boundary, proven fail-first against real PostgreSQL through the REAL
// controllers.
//
// Pre-fix defect: approveWithdrawal consumed ANY APPROVED request matching
// type = WITHDRAWAL + entityId — it never proved the evidence matched the
// withdrawal's ACTUAL amount or the authoritative tier. createApprovalRequest
// derived the tier from the CLIENT-SUPPLIED amount. Together, a quorum
// formed for a 15,000 withdrawal (2-approval tier) could authorize a 60,000
// withdrawal (3-approval tier + Finance/Compliance participation) — a
// two-admin approval could launder a three-admin withdrawal.
//
// Post-fix contract proven here:
//   1. A 50,000+ withdrawal with a lower-amount APPROVED request (2-approval
//      tier) is REFUSED: withdrawal stays PENDING, request stays APPROVED
//      (unconsumed).
//   2. An amount-MATCHING request with an insufficient tier (2 vs the
//      authoritative 3) is refused and remains unconsumed.
//   3. An amount-matching, correct-tier request whose recorded approvals
//      lack Finance/Compliance participation is refused for >= 50,000 and
//      remains unconsumed.
//   4. An amount-matching request whose recorded quorum count is below the
//      authoritative requirement is refused and remains unconsumed.
//   5. createApprovalRequest cannot create misleading WITHDRAWAL evidence:
//      a client amount differing from the persisted withdrawal amount is
//      400-rejected with no row created; a missing withdrawal is 404; a
//      non-PENDING withdrawal is 409-ineligible; a request without a client
//      amount is bound to the authoritative amount and its real tier.
//   6. An exact-amount, correct-tier, valid-quorum request still succeeds
//      and is consumed exactly once (APPROVED -> EXECUTED, executedAt set).
//   7. Only the ONE validated request is consumed — an invalid APPROVED
//      sibling for the same withdrawal is left APPROVED (no bulk transition).
//   8. Exact-Decimal boundary: 15000.5 vs 15000.50000001 is a REFUSED
//      mismatch (no float rounding forgives the difference).
//   9. The concurrent-approval guarantee survives: two simultaneous
//      approvals over valid evidence -> exactly one 200 and one 409, one
//      consumption, one flip.
//
// Against the pre-fix implementation tests 1-4, 7 and 8 fail: the
// withdrawal flips APPROVED on unproven (or someone else's) evidence.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-evidence-binding] TEST_DATABASE_URL not set — skipping.');

const { PrismaClient } = require('@prisma/client');

describeOrSkip('r272 withdrawal approval-evidence binding (real PostgreSQL)', () => {
    let prisma, ctrl, rbacCtrl, admin, financeAdmin, complianceAdmin, thirdAdmin, plainAdmin, member;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        ctrl = require('../controllers/adminController');
        rbacCtrl = require('../controllers/adminRbacController');

        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // NOTE: the Prisma Role enum only has USER/VENDOR/ADMIN, so the
        // specialized FINANCE_ADMIN / COMPLIANCE_ADMIN designations live in
        // the AUTHORITATIVE AdminRoleAssignment table — the only persistent
        // source of a specialized role. Recorded approvals-JSON role strings
        // are audit records; the consumption validator re-derives every
        // approver's role from this table.
        const mkAdmin = async (name) => prisma.user.create({
            data: {
                username: `r272eb_${name}_${uniq}`,
                email: `r272eb_${name}_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN',
            },
        });
        admin = await mkAdmin('admin');
        financeAdmin = await mkAdmin('fin');
        complianceAdmin = await mkAdmin('comp');
        thirdAdmin = await mkAdmin('third');
        plainAdmin = await mkAdmin('plain'); // no specialized assignment
        await prisma.adminRoleAssignment.create({ data: { userId: financeAdmin.id, role: 'FINANCE_ADMIN' } });
        await prisma.adminRoleAssignment.create({ data: { userId: complianceAdmin.id, role: 'COMPLIANCE_ADMIN' } });
        member = await prisma.user.create({
            data: {
                username: `r272eb_member_${uniq}`,
                email: `r272eb_member_${uniq}@test.local`,
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
        await prisma.adminApprovalRequest.deleteMany({
            where: { requestedBy: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id, plainAdmin.id] } }
        });
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id, plainAdmin.id] } }
        });
        await prisma.adminRoleAssignment.deleteMany({
            where: { userId: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id, plainAdmin.id] } }
        });
        await prisma.user.deleteMany({
            where: { id: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id, plainAdmin.id, member.id] } }
        });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.withdrawal.deleteMany({ where: { userId: member.id } });
        await prisma.adminApprovalRequest.deleteMany({
            where: { requestedBy: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id] } }
        });
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: [admin.id, financeAdmin.id, complianceAdmin.id, thirdAdmin.id] } }
        });
    });

    function makeReq(user, withdrawalId) {
        return {
            params: { id: String(withdrawalId) },
            body: { adminNotes: 'r272 evidence-binding test' },
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
        return prisma.withdrawal.create({
            data: {
                userId: member.id,
                amount,
                payoutMethod: 'MOMO',
                network: 'MTN',
                destination: '0240000000',
                status: 'PENDING',
            },
        });
    }

    async function seedRequest(withdrawalId, { amount, requiredApprovals, approvals, status = 'APPROVED' } = {}) {
        return prisma.adminApprovalRequest.create({
            data: {
                type: 'WITHDRAWAL',
                entityId: String(withdrawalId),
                amount,
                description: 'r272 evidence-binding test',
                metadata: { withdrawalId },
                requestedBy: admin.id,
                requiredApprovals,
                approvals,
                status,
                approvedBy: approvals?.[approvals.length - 1]?.userId ?? null,
                approvedAt: status === 'APPROVED' ? new Date() : null,
            },
        });
    }

    // Convenience approval stamps.
    const byAdmin = (u, role = 'ADMIN') => ({ userId: u.id, role, at: new Date().toISOString() });
    const byFinance = (u) => byAdmin(u, 'FINANCE_ADMIN');
    const byCompliance = (u) => byAdmin(u, 'COMPLIANCE_ADMIN');

    async function assertRefusedUnconsumed(res, withdrawalId, requestId, expectCode) {
        expect(res._status).toBe(403);
        if (expectCode) expect(res._body.code).toBe(expectCode);
        const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
        expect(w.status).toBe('PENDING'); // withdrawal untouched
        const reqRow = await prisma.adminApprovalRequest.findUnique({ where: { id: requestId } });
        expect(reqRow.status).toBe('APPROVED'); // evidence NOT consumed
        expect(reqRow.executedAt).toBeNull();
    }

    test('50,000+ withdrawal with a LOWER-AMOUNT 2-approval request → refused, PENDING, unconsumed', async () => {
        const w = await seedWithdrawal(60000);
        // The laundering fixture: quorum formed on 15,000 (2-approval tier),
        // pointed at a 60,000 withdrawal (3-approval tier).
        const bad = await seedRequest(w.id, {
            amount: 15000,
            requiredApprovals: 2,
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        await assertRefusedUnconsumed(res, w.id, bad.id, 'WITHDRAWAL_APPROVAL_QUORUM_REQUIRED');
    });

    test('amount-MATCHING request with an insufficient tier (2 of 3) → refused, unconsumed', async () => {
        const w = await seedWithdrawal(60000);
        const bad = await seedRequest(w.id, {
            amount: 60000,
            requiredApprovals: 2, // authoritative tier for 60,000 is 3
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        await assertRefusedUnconsumed(res, w.id, bad.id);
    });

    test('amount-matching, correct-tier request WITHOUT Finance/Compliance participation → refused, unconsumed', async () => {
        const w = await seedWithdrawal(60000);
        // None of these three approvers holds a FINANCE_ADMIN /
        // COMPLIANCE_ADMIN assignment, so the authoritative source proves
        // the required participation is absent — even though the recorded
        // stamps (deliberately) claim otherwise for one of them.
        const bad = await seedRequest(w.id, {
            amount: 60000,
            requiredApprovals: 3,
            approvals: [byAdmin(admin), byAdmin(thirdAdmin), byAdmin(plainAdmin, 'FINANCE_ADMIN')], // forged FINANCE_ADMIN stamp on an unassigned admin
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        await assertRefusedUnconsumed(res, w.id, bad.id);
    });

    test('amount-matching request with quorum count below requirement → refused, unconsumed', async () => {
        const w = await seedWithdrawal(60000);
        const bad = await seedRequest(w.id, {
            amount: 60000,
            requiredApprovals: 3,
            approvals: [byFinance(financeAdmin), byAdmin(admin)], // 2 recorded < 3 required
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        await assertRefusedUnconsumed(res, w.id, bad.id);
    });

    test('createApprovalRequest cannot create misleading WITHDRAWAL evidence (client amount ≠ persisted amount)', async () => {
        const w = await seedWithdrawal(60000);
        const res = makeRes();
        const req = makeReq(admin, w.id);
        req.body = { type: 'WITHDRAWAL', entityId: String(w.id), amount: 15000, description: 'misleading' };
        await rbacCtrl.createApprovalRequest(req, res);
        expect(res._status).toBe(400);
        expect(res._body.success).toBe(false);

        // No misleading row was created.
        const rows = await prisma.adminApprovalRequest.findMany({
            where: { type: 'WITHDRAWAL', entityId: String(w.id) },
        });
        expect(rows).toHaveLength(0);
    });

    test('createApprovalRequest binds WITHDRAWAL evidence to the authoritative amount and tier', async () => {
        const w = await seedWithdrawal(60000);
        const res = makeRes();
        const req = makeReq(admin, w.id);
        // No client amount at all — the persisted withdrawal decides.
        req.body = { type: 'WITHDRAWAL', entityId: String(w.id), description: 'bound to actual' };
        await rbacCtrl.createApprovalRequest(req, res);
        expect(res._status).toBe(200);
        expect(res._body.success).toBe(true);

        const created = await prisma.adminApprovalRequest.findFirst({
            where: { type: 'WITHDRAWAL', entityId: String(w.id) },
            orderBy: { id: 'desc' },
        });
        // Exact amount: Decimal equality against the persisted withdrawal.
        const persisted = await prisma.withdrawal.findUnique({ where: { id: w.id }, select: { amount: true } });
        expect(new (require('@prisma/client').Prisma).Decimal(created.amount).equals(new (require('@prisma/client').Prisma).Decimal(persisted.amount))).toBe(true);
        expect(created.requiredApprovals).toBe(3); // the AUTHORITATIVE tier for 60,000
        expect(created.status).toBe('PENDING');
    });

    test('createApprovalRequest rejects missing and non-PENDING withdrawals as evidence targets', async () => {
        // Missing withdrawal → 404.
        const resMissing = makeRes();
        const reqMissing = makeReq(admin, 999999999);
        reqMissing.body = { type: 'WITHDRAWAL', entityId: '999999999', description: 'ghost' };
        await rbacCtrl.createApprovalRequest(reqMissing, resMissing);
        expect(resMissing._status).toBe(404);

        // Already-APPROVED withdrawal → ineligible for evidence.
        const w = await seedWithdrawal(15000);
        await prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'APPROVED' } });
        const resDone = makeRes();
        const reqDone = makeReq(admin, w.id);
        reqDone.body = { type: 'WITHDRAWAL', entityId: String(w.id), description: 'stale' };
        await rbacCtrl.createApprovalRequest(reqDone, resDone);
        expect(resDone._status).toBe(409);

        const rows = await prisma.adminApprovalRequest.findMany({
            where: { type: 'WITHDRAWAL', entityId: String(w.id) },
        });
        expect(rows).toHaveLength(0);
    });

    test('exact-amount, correct-tier, valid-quorum request still succeeds and is consumed once', async () => {
        const w = await seedWithdrawal(60000);
        const good = await seedRequest(w.id, {
            amount: 60000,
            requiredApprovals: 3,
            approvals: [byFinance(financeAdmin), byAdmin(admin), byCompliance(complianceAdmin)],
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        expect(res._status).toBe(200);
        expect(res._body.success).toBe(true);

        const after = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(after.status).toBe('APPROVED');

        const consumed = await prisma.adminApprovalRequest.findUnique({ where: { id: good.id } });
        expect(consumed.status).toBe('EXECUTED');
        expect(consumed.executedAt).not.toBeNull();

        // Replay refuses: the consumed evidence cannot flip anything again.
        const replay = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), replay);
        expect(replay._status).toBe(400); // status no longer PENDING
    });

    test('only the ONE validated request is consumed — an invalid APPROVED sibling survives untouched', async () => {
        const w = await seedWithdrawal(30000);
        // Lower-amount sibling quorum (the laundering case) + one honest
        // request. The honest one is consumed; the misleading sibling stays
        // APPROVED — evidence is never bulk-transitioned.
        const badSibling = await seedRequest(w.id, {
            amount: 12000,
            requiredApprovals: 2,
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });
        const good = await seedRequest(w.id, {
            amount: 30000,
            requiredApprovals: 2,
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });

        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        expect(res._status).toBe(200);

        const goodAfter = await prisma.adminApprovalRequest.findUnique({ where: { id: good.id } });
        const badAfter = await prisma.adminApprovalRequest.findUnique({ where: { id: badSibling.id } });
        expect(goodAfter.status).toBe('EXECUTED');
        expect(badAfter.status).toBe('APPROVED'); // NOT bulk-consumed
        expect(badAfter.executedAt).toBeNull();

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(wAfter.status).toBe('APPROVED');
    });

    test('exact-Decimal boundary: 15000.5 vs 15000.50000001 evidence is refused', async () => {
        const w = await seedWithdrawal('15000.50000001');
        const nearMiss = await seedRequest(w.id, {
            amount: '15000.5', // differs in the 8th decimal place — float-equal, Decimal-different
            requiredApprovals: 2,
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });
        const res = makeRes();
        await ctrl.approveWithdrawal(makeReq(admin, w.id), res);
        await assertRefusedUnconsumed(res, w.id, nearMiss.id);
    });

    test('concurrent approvals over VALID evidence → exactly one 200 and one 409, one consumption, one flip', async () => {
        const w = await seedWithdrawal(30000);
        await seedRequest(w.id, {
            amount: 30000,
            requiredApprovals: 2, // the authoritative tier for 30,000
            approvals: [byFinance(financeAdmin), byAdmin(admin)],
        });

        const r1 = makeRes();
        const r2 = makeRes();
        await Promise.all([
            ctrl.approveWithdrawal(makeReq(admin, w.id), r1),
            ctrl.approveWithdrawal(makeReq(thirdAdmin, w.id), r2),
        ]);
        expect([r1._status, r2._status].sort()).toEqual([200, 409]);

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(wAfter.status).toBe('APPROVED'); // flipped exactly once

        const executed = await prisma.adminApprovalRequest.findMany({
            where: { type: 'WITHDRAWAL', entityId: String(w.id), status: 'EXECUTED' },
        });
        expect(executed).toHaveLength(1); // consumed exactly once
    });
});
