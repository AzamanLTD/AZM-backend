// __tests__/r272-withdrawal-full-flow-authoritative-roles.test.js
// =============================================================================
// r272 P0 follow-up — FULL-FLOW proof that the live authorization path can
// actually PRODUCE valid >= 50,000 USDC withdrawal approval evidence.
//
// Pre-fix defect: approveRequest stamped every approval with
// `req.user.role` — the JWT claim, minted at login from the Prisma Role
// enum (USER/VENDOR/ADMIN only). FINANCE_ADMIN / COMPLIANCE_ADMIN could
// therefore never be stamped by a real account: the >= 50,000 tier's
// Finance/Compliance participation invariant was unsatisfiable in
// production, and the multi-step role catalog was documentary policy.
//
// This suite drives the ENTIRE real flow against real PostgreSQL:
//   1. A withdrawal is created.
//   2. Its approval request is created through the REAL
//      createApprovalRequest controller.
//   3. The request is approved through the REAL approveRequest controller
//      by admins holding authoritative AdminRoleAssignment designations.
//      The final request's role evidence is NEVER manually seeded — and
//      the JWT role claims are deliberately GARBAGE / forged, proving the
//      evidence derives from the persistent role source, not the token.
//   4. approveWithdrawal then approves the withdrawal at the >= 50,000
//      tier, consuming that controller-produced evidence exactly once.
//
// Negative full-flow proof included: when the Finance/Compliance
// assignments are revoked before consumption, the recorded participation
// is no longer REAL — approveWithdrawal re-derives every approver's role
// from the authoritative source and refuses, leaving the withdrawal
// PENDING and the evidence unconsumed.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-full-flow] TEST_DATABASE_URL not set — skipping.');

const { PrismaClient } = require('@prisma/client');

describeOrSkip('r272 full-flow: authoritative admin roles produce >= 50k approval evidence (real PostgreSQL)', () => {
    let prisma, ctrl, rbacCtrl;
    let requester, finAdmin, compAdmin, plainAdmin, member;
    const adminIds = () => [requester.id, finAdmin.id, compAdmin.id, plainAdmin.id];

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        ctrl = require('../controllers/adminController');
        rbacCtrl = require('../controllers/adminRbacController');

        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const mkAdmin = async (name) => prisma.user.create({
            data: {
                username: `r272ff_${name}_${uniq}`,
                email: `r272ff_${name}_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN', // the enum holds only USER/VENDOR/ADMIN
            },
        });
        requester = await mkAdmin('requester');   // legacy full admin
        finAdmin = await mkAdmin('fin');
        compAdmin = await mkAdmin('comp');
        plainAdmin = await mkAdmin('plain');       // never specialized
        // THE authoritative specialized designations — the only persistent
        // source of a FINANCE_ADMIN / COMPLIANCE_ADMIN identity.
        await prisma.adminRoleAssignment.create({ data: { userId: finAdmin.id, role: 'FINANCE_ADMIN' } });
        await prisma.adminRoleAssignment.create({ data: { userId: compAdmin.id, role: 'COMPLIANCE_ADMIN' } });

        member = await prisma.user.create({
            data: {
                username: `r272ff_member_${uniq}`,
                email: `r272ff_member_${uniq}@test.local`,
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
        await prisma.adminApprovalRequest.deleteMany({ where: { requestedBy: { in: adminIds() } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: adminIds() } } });
        await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: adminIds() } } });
        await prisma.user.deleteMany({ where: { id: { in: [...adminIds(), member.id] } } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.transactionHistory.deleteMany({ where: { userId: member.id } });
        await prisma.withdrawal.deleteMany({ where: { userId: member.id } });
        await prisma.adminApprovalRequest.deleteMany({ where: { requestedBy: { in: adminIds() } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: adminIds() } } });
        // The suite's assignments are created in beforeAll and revoked only
        // inside the revocation test — restore them so every test starts
        // from the same authoritative baseline.
        for (const [uid, role] of [[finAdmin.id, 'FINANCE_ADMIN'], [compAdmin.id, 'COMPLIANCE_ADMIN']]) {
            await prisma.adminRoleAssignment.upsert({
                where: { userId: uid },
                create: { userId: uid, role },
                update: { role },
            });
        }
    });

    function appStub() {
        return {
            get(k) {
                if (k === 'prisma') return prisma;
                if (k === 'socketio' || k === 'io') return { to: () => ({ emit: () => {} }), emit: () => {} };
                if (k === 'emitBalanceUpdate') return () => {};
                if (k === 'notificationService') return { sendNotification: async () => {} };
                return undefined;
            },
        };
    }
    function makeRes() {
        const r = { _status: 200, _body: null };
        r.status = (s) => { r._status = s; return r; };
        r.json = (b) => { r._body = b; return r; };
        return r;
    }
    // The `claim` is the JWT role claim — DELIBERATELY untrustworthy here.
    const makeUser = (user, claim) => ({ id: user.id, role: claim, username: user.username });

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

    test('full flow: real controllers produce and consume >= 50,000 evidence derived from authoritative roles', async () => {
        const w = await seedWithdrawal(75000); // >= 50,000: 3 approvals + Finance/Compliance

        // ── 1. Create the approval request through the REAL controller.
        // The requester's JWT claim is garbage — authority must resolve
        // authoritatively (legacy ADMIN holds withdrawals.approve).
        const createRes = makeRes();
        await rbacCtrl.createApprovalRequest(
            {
                user: makeUser(requester, 'NOT_EVEN_A_ROLE'),
                body: { type: 'WITHDRAWAL', entityId: String(w.id), amount: 75000, description: 'r272 full-flow' },
                params: {},
                app: appStub(),
            },
            createRes
        );
        expect(createRes._status).toBe(200);
        expect(createRes._body.autoApproved).toBe(false);
        const requestId = createRes._body.request.id;
        expect(createRes._body.request.requiredApprovals).toBe(3);
        expect(createRes._body.request.status).toBe('PENDING');

        // A non-admin (forged ADMIN claim) cannot approve through the real
        // controller — the claim decides nothing.
        const memberRes = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(member, 'ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
            memberRes
        );
        expect(memberRes._status).toBe(403);

        // An unassigned admin cannot satisfy the >= 50,000 Finance/
        // Compliance participation when nobody else has yet.
        const plainFirstRes = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(plainAdmin, 'FINANCE_ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
            plainFirstRes
        );
        expect(plainFirstRes._status).toBe(403);
        expect(plainFirstRes._body.message).toMatch(/Finance or Compliance/i);

        // ── 2. Approve through the REAL controller as the ASSIGNED roles.
        // First: COMPLIANCE_ADMIN (garbage claim), which satisfies the
        // Finance/Compliance participation invariant.
        const rComp = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(compAdmin, 'USER'), params: { id: String(requestId) }, body: {}, app: appStub() },
            rComp
        );
        expect(rComp._status).toBe(200);
        expect(rComp._body.fullyApproved).toBe(false);

        // Second: FINANCE_ADMIN (also a garbage claim — the assignment row
        // is the only thing that makes this a FINANCE_ADMIN approval).
        const rFin = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(finAdmin, 'SUPPORT_ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
            rFin
        );
        expect(rFin._status).toBe(200);
        expect(rFin._body.fullyApproved).toBe(false);

        // Third: the UNASSIGNED admin completes the quorum. Note the forged
        // FINANCE_ADMIN claim — the recorded evidence must say ADMIN.
        const rPlain = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(plainAdmin, 'FINANCE_ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
            rPlain
        );
        expect(rPlain._status).toBe(200);
        expect(rPlain._body.fullyApproved).toBe(true);

        // The recorded evidence was produced ENTIRELY by the real flow —
        // no manual seeding — and every stamp carries the AUTHORITATIVE
        // role, never the JWT claim.
        const approvedRequest = await prisma.adminApprovalRequest.findUnique({ where: { id: requestId } });
        expect(approvedRequest.status).toBe('APPROVED');
        const stamps = approvedRequest.approvals.map((a) => ({ userId: a.userId, role: a.role }));
        expect(stamps).toEqual([
            { userId: compAdmin.id, role: 'COMPLIANCE_ADMIN' },
            { userId: finAdmin.id, role: 'FINANCE_ADMIN' },
            { userId: plainAdmin.id, role: 'ADMIN' },
        ]);

        // ── 3. Approve the WITHDRAWAL at the >= 50,000 tier, consuming the
        // controller-produced evidence exactly once.
        const approveRes = makeRes();
        await ctrl.approveWithdrawal(
            {
                params: { id: String(w.id) },
                body: { adminNotes: 'r272 full-flow consumption' },
                user: makeUser(requester, 'READ_ONLY_ADMIN'), // forged claim; requester is a legacy ADMIN
                app: appStub(),
            },
            approveRes
        );
        expect(approveRes._status).toBe(200);
        expect(approveRes._body.success).toBe(true);

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(wAfter.status).toBe('APPROVED');

        const consumed = await prisma.adminApprovalRequest.findUnique({ where: { id: requestId } });
        expect(consumed.status).toBe('EXECUTED');
        expect(consumed.executedAt).not.toBeNull();

        // Replay: nothing left to consume; the withdrawal is final.
        const replay = makeRes();
        await ctrl.approveWithdrawal(
            { params: { id: String(w.id) }, body: {}, user: makeUser(requester, 'ADMIN'), app: appStub() },
            replay
        );
        expect(replay._status).toBe(400); // status no longer PENDING
    });

    test('revoked Finance/Compliance assignments make recorded participation unreal — consumption refuses', async () => {
        const w = await seedWithdrawal(60000);

        // Real-controller request + three real approvals (comp + fin + plain).
        const createRes = makeRes();
        await rbacCtrl.createApprovalRequest(
            {
                user: makeUser(requester, 'ADMIN'),
                body: { type: 'WITHDRAWAL', entityId: String(w.id), amount: 60000, description: 'r272 revocation' },
                params: {},
                app: appStub(),
            },
            createRes
        );
        expect(createRes._status).toBe(200);
        const requestId = createRes._body.request.id;

        for (const approver of [compAdmin, finAdmin, plainAdmin]) {
            const r = makeRes();
            await rbacCtrl.approveRequest(
                { user: makeUser(approver, 'ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
                r
            );
            expect(r._status).toBe(200);
        }
        const approvedRequest = await prisma.adminApprovalRequest.findUnique({ where: { id: requestId } });
        expect(approvedRequest.status).toBe('APPROVED');
        expect(approvedRequest.approvals).toHaveLength(3);

        // The Finance and Compliance designations are revoked BEFORE the
        // withdrawal is approved. The recorded stamps still say
        // COMPLIANCE_ADMIN / FINANCE_ADMIN — but they are audit records,
        // never the trust basis.
        await prisma.adminRoleAssignment.deleteMany({
            where: { userId: { in: [finAdmin.id, compAdmin.id] } },
        });

        const approveRes = makeRes();
        await ctrl.approveWithdrawal(
            {
                params: { id: String(w.id) },
                body: { adminNotes: 'r272 revocation refusal' },
                user: makeUser(requester, 'ADMIN'),
                app: appStub(),
            },
            approveRes
        );
        expect(approveRes._status).toBe(403);
        expect(approveRes._body.code).toBe('WITHDRAWAL_APPROVAL_QUORUM_REQUIRED');
        expect(approveRes._body.message).toMatch(/Finance\/Compliance participation/i);

        // Fail closed: withdrawal untouched, evidence unconsumed.
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(wAfter.status).toBe('PENDING');
        const requestAfter = await prisma.adminApprovalRequest.findUnique({ where: { id: requestId } });
        expect(requestAfter.status).toBe('APPROVED');
        expect(requestAfter.executedAt).toBeNull();
    });
});
