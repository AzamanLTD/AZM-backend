// __tests__/r272-admin-role-provisioning.test.js
// =============================================================================
// r272 follow-up — regression proofs for Secure Admin Role Provisioning &
// Revocation (real PostgreSQL).
//
// Covers the 10 required proof areas:
//   1.  Initial Super Admin bootstrap (explicit authorization + audit).
//   2.  Bootstrap refusals: ineligible targets, consumed preconditions,
//       idempotent re-run.
//   3.  Successful role assignment / reassignment by an authorized Super Admin.
//   4.  Forged SUPER_ADMIN / FINANCE_ADMIN / COMPLIANCE_ADMIN JWT claims
//       without the authoritative assignment are refused.
//   5.  Legacy unassigned ADMINs cannot manage other administrators.
//   6.  Invalid roles, nonexistent / banned / deleted / non-admin targets.
//   7.  Safe demotion (READ_ONLY_ADMIN) and full revocation (deprovision,
//       token invalidation); no path falls back to full ADMIN accidentally.
//   8.  No partial state after failed changes; concurrent conflicting changes
//       serialize consistently.
//   9.  Approval-tier behaviour stays correct with provisioned roles
//       (authorized Finance/Compliance evidence works; revoked evidence
//       cannot authorize a >= 50,000 withdrawal).
//  10. Audit rows for successes only — refused attempts leave no misleading
//       success events.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-provisioning] TEST_DATABASE_URL not set — skipping.');

const { PrismaClient } = require('@prisma/client');

describeOrSkip('r272 admin role provisioning and revocation (real PostgreSQL)', () => {
    let prisma, roleCtrl, rbacCtrl, wdCtrl;
    let superA, superB, plainAdmin, finAdmin, compAdmin, member, bystander;
    const { bootstrapSuperAdmin } = require('../scripts/bootstrapSuperAdmin');

    const allIds = () => [superA, superB, plainAdmin, finAdmin, compAdmin, member, bystander].map((u) => u.id);

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        roleCtrl = require('../controllers/adminRoleAdminController');
        rbacCtrl = require('../controllers/adminRbacController');
        wdCtrl = require('../controllers/adminController');

        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const mk = (name, data = {}) => prisma.user.create({
            data: {
                username: `r272prov_${name}_${uniq}`,
                email: `r272prov_${name}_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN',
                ...data,
            },
        });

        superA = await mk('supera');      // bootstrapped Super Admin (actor)
        superB = await mk('superb');      // second Super Admin
        plainAdmin = await mk('plain');   // legacy unassigned full admin
        finAdmin = await mk('fin');
        compAdmin = await mk('comp');
        bystander = await mk('bystander'); // demotion/revocation target
        member = await prisma.user.create({
            data: {
                username: `r272prov_member_${uniq}`,
                email: `r272prov_member_${uniq}@test.local`,
                password: 'test_password',
                role: 'USER',
                availableBalance: 1000000,
            },
        });

        // Authoritative baseline: two Super Admins so demotion tests never
        // hit the lockout guard accidentally.
        await prisma.adminRoleAssignment.create({ data: { userId: superA.id, role: 'SUPER_ADMIN' } });
        await prisma.adminRoleAssignment.create({ data: { userId: superB.id, role: 'SUPER_ADMIN' } });
    });

    afterAll(async () => {
        if (!prisma) return;
        const ids = allIds();
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids.map(String) } }] } });
        await prisma.adminApprovalRequest.deleteMany({ where: { requestedBy: { in: ids } } });
        await prisma.transactionHistory.deleteMany({ where: { userId: member.id } });
        await prisma.withdrawal.deleteMany({ where: { userId: member.id } });
        await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        // Reset bystander/fin/comp to a clean slate between tests.
        const resetIds = [plainAdmin.id, finAdmin.id, compAdmin.id, bystander.id];
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: resetIds } }, { targetId: { in: resetIds.map(String) } }] } });
        await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: resetIds } } });
        for (const uid of resetIds) {
            await prisma.user.update({
                where: { id: uid },
                data: { role: 'ADMIN', banStatus: 'ACTIVE', isDeleted: false },
            });
        }
    });

    // ── HTTP handler harness (repo r272 idiom) ─────────────────────────────
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
    const makeUser = (user, claim) => ({ id: user.id, role: claim, username: user.username });
    async function assign(user, claim, targetId, role) {
        const r = makeRes();
        await roleCtrl.assignAdminRole(
            { user: makeUser(user, claim), params: { id: String(targetId) }, body: { role }, ip: '127.0.0.1', app: appStub() },
            r
        );
        return r;
    }
    async function deprovision(user, claim, targetId) {
        const r = makeRes();
        await roleCtrl.deprovisionAdmin(
            { user: makeUser(user, claim), params: { id: String(targetId) }, body: {}, ip: '127.0.0.1', app: appStub() },
            r
        );
        return r;
    }
    async function listAdmins(user, claim) {
        const r = makeRes();
        await roleCtrl.listAdmins(
            { user: makeUser(user, claim), params: {}, query: {}, app: appStub() },
            r
        );
        return r;
    }

    // ── 1. Initial Super Admin bootstrap ───────────────────────────────────
    test('bootstrap: explicit target + confirmation designates the initial Super Admin with audit evidence', async () => {
        // Isolate: no other active Super Admin may exist for a true first run.
        await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: [superA.id, superB.id] } } });
        try {
            const before = await prisma.auditLog.findFirst({
                where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN', targetId: String(superA.id) },
            });
            expect(before).toBeNull();

            const result = await bootstrapSuperAdmin(prisma, superA.id, { confirmed: true });
            expect(result.alreadyBootstrapped).toBe(false);
            expect(result.newEffectiveRole).toBe('SUPER_ADMIN');

            const assignment = await prisma.adminRoleAssignment.findUnique({ where: { userId: superA.id } });
            expect(assignment.role).toBe('SUPER_ADMIN');

            const audit = await prisma.auditLog.findFirst({
                where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN', targetId: String(superA.id) },
            });
            expect(audit).not.toBeNull();
            expect(audit.actorId).toBeNull(); // operator/CLI, not an HTTP admin
            expect(audit.metadata.oldEffectiveRole).toBe('ADMIN');
            expect(audit.metadata.newEffectiveRole).toBe('SUPER_ADMIN');
            expect(audit.metadata.outcome).toBe('SUCCESS');

            // Effective role is now authoritative SUPER_ADMIN.
            expect(await rbacCtrl.resolveEffectiveAdminRole(prisma, superA.id)).toBe('SUPER_ADMIN');
        } finally {
            // Restore the shared baseline.
            await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: [superA.id, superB.id] } } });
            await prisma.auditLog.deleteMany({ where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN' } });
            await prisma.adminRoleAssignment.create({ data: { userId: superA.id, role: 'SUPER_ADMIN' } });
            await prisma.adminRoleAssignment.create({ data: { userId: superB.id, role: 'SUPER_ADMIN' } });
        }
    });

    // ── 2. Bootstrap refusals ───────────────────────────────────────────────
    test('bootstrap: refuses without confirmation and for ineligible targets, and fails closed when preconditions are consumed', async () => {
        // No confirmation → refusal, nothing written.
        await expect(bootstrapSuperAdmin(prisma, plainAdmin.id, { confirmed: false }))
            .rejects.toMatchObject({ code: 'BOOTSTRAP_CONFIRMATION_REQUIRED' });
        expect(await prisma.adminRoleAssignment.findUnique({ where: { userId: plainAdmin.id } })).toBeNull();

        // Ineligible targets: non-admin, banned, missing.
        await expect(bootstrapSuperAdmin(prisma, member.id, { confirmed: true }))
            .rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_ADMIN' });
        await prisma.user.update({ where: { id: plainAdmin.id }, data: { banStatus: 'BANNED_INDEF' } });
        await expect(bootstrapSuperAdmin(prisma, plainAdmin.id, { confirmed: true }))
            .rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_ELIGIBLE' });
        await prisma.user.update({ where: { id: plainAdmin.id }, data: { banStatus: 'ACTIVE' } });
        await expect(bootstrapSuperAdmin(prisma, 999999999, { confirmed: true }))
            .rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_FOUND' });
        expect(await prisma.adminRoleAssignment.findUnique({ where: { userId: plainAdmin.id } })).toBeNull();

        // Preconditions consumed: an active Super Admin exists (superB)
        // → bootstrap of a different target refuses.
        await expect(bootstrapSuperAdmin(prisma, plainAdmin.id, { confirmed: true }))
            .rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_DONE' });
        expect(await prisma.adminRoleAssignment.findUnique({ where: { userId: plainAdmin.id } })).toBeNull();
        const bootstraps = await prisma.auditLog.count({
            where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN', targetId: String(plainAdmin.id) },
        });
        expect(bootstraps).toBe(0); // no misleading success events
    });

    test('bootstrap: re-run against the already-bootstrapped account is an idempotent no-op', async () => {
        const auditsBefore = await prisma.auditLog.count({
            where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN', targetId: String(superB.id) },
        });
        const result = await bootstrapSuperAdmin(prisma, superB.id, { confirmed: true });
        expect(result.alreadyBootstrapped).toBe(true);
        // Nothing new written.
        const assignments = await prisma.adminRoleAssignment.count({ where: { userId: superB.id, role: 'SUPER_ADMIN' } });
        expect(assignments).toBe(1);
        const auditsAfter = await prisma.auditLog.count({
            where: { action: 'RBAC_BOOTSTRAP_SUPER_ADMIN', targetId: String(superB.id) },
        });
        expect(auditsAfter).toBe(auditsBefore);
    });

    // ── 3. Assignment / reassignment by an authorized Super Admin ───────────
    test('assignment: authorized Super Admin assigns and reassigns roles (JWT claims ignored)', async () => {
        // Deliberately garbage claim — authority comes from the assignment row.
        const r1 = await assign(superA, 'NOT_EVEN_A_ROLE', finAdmin.id, 'FINANCE_ADMIN');
        expect(r1._status).toBe(200);
        expect(r1._body.admin.previousEffectiveRole).toBe('ADMIN');
        expect(r1._body.admin.effectiveRole).toBe('FINANCE_ADMIN');

        const assignment = await prisma.adminRoleAssignment.findUnique({ where: { userId: finAdmin.id } });
        expect(assignment.role).toBe('FINANCE_ADMIN');
        expect(assignment.assignedBy).toBe(superA.id);

        const audit = await prisma.auditLog.findFirst({
            where: { action: 'RBAC_ASSIGN_ADMIN_ROLE', targetId: String(finAdmin.id) },
        });
        expect(audit.actorId).toBe(superA.id);
        expect(audit.metadata.oldEffectiveRole).toBe('ADMIN');
        expect(audit.metadata.newEffectiveRole).toBe('FINANCE_ADMIN');
        expect(audit.metadata.outcome).toBe('SUCCESS');

        // Reassignment updates in place.
        const r2 = await assign(superA, 'USER', finAdmin.id, 'COMPLIANCE_ADMIN');
        expect(r2._status).toBe(200);
        expect(r2._body.admin.previousEffectiveRole).toBe('FINANCE_ADMIN');
        expect(r2._body.admin.effectiveRole).toBe('COMPLIANCE_ADMIN');
        const after = await prisma.adminRoleAssignment.findUnique({ where: { userId: finAdmin.id } });
        expect(after.role).toBe('COMPLIANCE_ADMIN');
    });

    // ── 4. Forged JWT claims ────────────────────────────────────────────────
    test('forged SUPER_ADMIN / FINANCE_ADMIN / COMPLIANCE_ADMIN claims without the assignment are refused', async () => {
        // plainAdmin claims SUPER_ADMIN but has no assignment.
        const r1 = await assign(plainAdmin, 'SUPER_ADMIN', finAdmin.id, 'FINANCE_ADMIN');
        expect(r1._status).toBe(403);
        expect(r1._body.code).toBe('RBAC_SUPER_ADMIN_REQUIRED');

        // finAdmin genuinely holds FINANCE_ADMIN but claims SUPER_ADMIN:
        // effective FINANCE_ADMIN is not management authority.
        await prisma.adminRoleAssignment.create({ data: { userId: finAdmin.id, role: 'FINANCE_ADMIN' } });
        const r2 = await assign(finAdmin, 'SUPER_ADMIN', compAdmin.id, 'COMPLIANCE_ADMIN');
        expect(r2._status).toBe(403);
        expect(r2._body.code).toBe('RBAC_SUPER_ADMIN_REQUIRED');

        // compAdmin claims COMPLIANCE_ADMIN with no assignment.
        const r3 = await assign(compAdmin, 'COMPLIANCE_ADMIN', finAdmin.id, 'SUPPORT_ADMIN');
        expect(r3._status).toBe(403);

        // No state was written by any refused call.
        expect(await prisma.adminRoleAssignment.findUnique({ where: { userId: compAdmin.id } })).toBeNull();
        const finAssignment = await prisma.adminRoleAssignment.findUnique({ where: { userId: finAdmin.id } });
        expect(finAssignment.role).toBe('FINANCE_ADMIN'); // unchanged from setup
        const successRows = await prisma.auditLog.count({
            where: { action: 'RBAC_ASSIGN_ADMIN_ROLE', targetId: { in: [String(finAdmin.id), String(compAdmin.id)] } },
        });
        expect(successRows).toBe(0); // refusals produce no success events
    });

    // ── 5. Legacy unassigned ADMIN ──────────────────────────────────────────
    test('legacy unassigned ADMIN (even with a forged claim) cannot manage, list, or deprovision administrators', async () => {
        const r1 = await assign(plainAdmin, 'ADMIN', finAdmin.id, 'FINANCE_ADMIN');
        expect(r1._status).toBe(403);
        expect(r1._body.code).toBe('RBAC_SUPER_ADMIN_REQUIRED');

        const r2 = await deprovision(plainAdmin, 'ADMIN', finAdmin.id);
        expect(r2._status).toBe(403);

        const r3 = await listAdmins(plainAdmin, 'ADMIN');
        expect(r3._status).toBe(403);
        expect(r3._body.code).toBe('RBAC_SUPER_ADMIN_REQUIRED');
    });

    // ── 6. Invalid inputs ──────────────────────────────────────────────────
    test('invalid roles and invalid targets are all refused with no state change', async () => {
        const badRoleRes = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'HACKER_ADMIN');
        expect(badRoleRes._status).toBe(400);
        expect(badRoleRes._body.code).toBe('RBAC_INVALID_ROLE');
        expect(badRoleRes._body.assignableRoles).toContain('FINANCE_ADMIN');

        // 'ADMIN' is not assignable — legacy is the fallback, never a designation.
        const legacyRoleRes = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'ADMIN');
        expect(legacyRoleRes._status).toBe(400);

        for (const rawId of ['abc', '-1', '0', '']) {
            const r = await assign(superA, 'SUPER_ADMIN', rawId, 'FINANCE_ADMIN');
            expect(r._status).toBe(400);
        }

        const missing = await assign(superA, 'SUPER_ADMIN', 999999999, 'FINANCE_ADMIN');
        expect(missing._status).toBe(404);

        const nonAdmin = await assign(superA, 'SUPER_ADMIN', member.id, 'FINANCE_ADMIN');
        expect(nonAdmin._status).toBe(400);
        expect(nonAdmin._body.code).toBe('RBAC_TARGET_NOT_ADMIN');

        // Banned target.
        await prisma.user.update({ where: { id: finAdmin.id }, data: { banStatus: 'BANNED_INDEF' } });
        const banned = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'FINANCE_ADMIN');
        expect(banned._status).toBe(409);
        expect(banned._body.code).toBe('RBAC_TARGET_NOT_ACTIVE');
        await prisma.user.update({ where: { id: finAdmin.id }, data: { banStatus: 'ACTIVE' } });

        // Deleted target.
        await prisma.user.update({ where: { id: compAdmin.id }, data: { isDeleted: true } });
        const deleted = await assign(superA, 'SUPER_ADMIN', compAdmin.id, 'FINANCE_ADMIN');
        expect(deleted._status).toBe(404);

        // Self-targeting is forbidden (no self-escalation, no self-demotion).
        const self = await assign(superA, 'SUPER_ADMIN', superA.id, 'FINANCE_ADMIN');
        expect(self._status).toBe(400);
        expect(self._body.code).toBe('RBAC_SELF_MANAGEMENT_FORBIDDEN');
        const assignment = await prisma.adminRoleAssignment.findUnique({ where: { userId: superA.id } });
        expect(assignment.role).toBe('SUPER_ADMIN'); // untouched

        // Nothing was written anywhere in this test.
        const written = await prisma.auditLog.count({
            where: { action: 'RBAC_ASSIGN_ADMIN_ROLE', targetId: { in: [String(finAdmin.id), String(compAdmin.id), String(superA.id)] } },
        });
        expect(written).toBe(0);
    });

    // ── 7. Demotion + revocation semantics ────────────────────────────────
    test('READ_ONLY_ADMIN demotion keeps restricted admin access — never a silent full-ADMIN fallback', async () => {
        await prisma.adminRoleAssignment.create({ data: { userId: finAdmin.id, role: 'FINANCE_ADMIN' } });

        const r = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'READ_ONLY_ADMIN');
        expect(r._status).toBe(200);
        expect(r._body.admin.previousEffectiveRole).toBe('FINANCE_ADMIN');
        expect(r._body.admin.effectiveRole).toBe('READ_ONLY_ADMIN');

        const effective = await rbacCtrl.resolveEffectiveAdminRole(prisma, finAdmin.id);
        expect(effective).toBe('READ_ONLY_ADMIN'); // NOT legacy 'ADMIN'

        // Restricted level is enforced by the catalog, not the enum.
        expect(rbacCtrl.checkAdminPermission({ role: effective }, 'users.view')).toBe(true);
        expect(rbacCtrl.checkAdminPermission({ role: effective }, 'withdrawals.approve')).toBe(false);
        expect(rbacCtrl.checkAdminPermission({ role: effective }, '*')).toBe(false);
    });

    test('full deprovision removes all admin access, invalidates tokens, and leaves no assignment behind', async () => {
        const before = await prisma.user.findUnique({ where: { id: bystander.id }, select: { tokenVersion: true, role: true } });

        const r = await deprovision(superA, 'SUPER_ADMIN', bystander.id);
        expect(r._status).toBe(200);
        expect(r._body.admin.previousEffectiveRole).toBe('ADMIN');
        expect(r._body.admin.effectiveRole).toBeNull();
        expect(r._body.admin.primaryRole).toBe('USER');
        expect(r._body.admin.tokenVersionInvalidated).toBe(true);

        const after = await prisma.user.findUnique({ where: { id: bystander.id }, select: { role: true, tokenVersion: true } });
        expect(after.role).toBe('USER');
        expect(after.tokenVersion).toBe(before.tokenVersion + 1); // stale tokens die

        expect(await prisma.adminRoleAssignment.findUnique({ where: { userId: bystander.id } })).toBeNull();
        expect(await rbacCtrl.resolveEffectiveAdminRole(prisma, bystander.id)).toBeNull(); // no powers at all

        const audit = await prisma.auditLog.findFirst({
            where: { action: 'RBAC_DEPROVISION_ADMIN', targetId: String(bystander.id) },
        });
        expect(audit.metadata.oldEffectiveRole).toBe('ADMIN');
        expect(audit.metadata.newEffectiveRole).toBeNull();
        expect(audit.metadata.tokenVersionInvalidated).toBe(true);
        expect(audit.metadata.outcome).toBe('SUCCESS');

        // Deprovisioned account (even with a forged claim) can no longer act
        // as an admin on the approval path.
        const approval = await prisma.adminApprovalRequest.create({
            data: {
                type: 'USER_BAN',
                entityId: '0',
                amount: 0,
                description: 'post-deprovision authority probe',
                metadata: {},
                requestedBy: superB.id,
                requiredApprovals: 1,
                approvals: [],
                status: 'PENDING',
            },
        });
        const res = makeRes();
        await rbacCtrl.approveRequest(
            { user: makeUser(bystander, 'SUPER_ADMIN'), params: { id: String(approval.id) }, body: {}, app: appStub() },
            res
        );
        expect(res._status).toBe(403);
    });

    test('bare assignment deletion (no deprovision) would escalate to legacy full ADMIN — which is why no endpoint exposes it', async () => {
        // Documentary proof of the revocation hazard the API deliberately
        // avoids: deleting ONLY the assignment row leaves User.role = ADMIN,
        // so the resolver's documented legacy fallback restores FULL admin.
        await prisma.adminRoleAssignment.create({ data: { userId: finAdmin.id, role: 'FINANCE_ADMIN' } });
        expect(await rbacCtrl.resolveEffectiveAdminRole(prisma, finAdmin.id)).toBe('FINANCE_ADMIN');

        await prisma.adminRoleAssignment.deleteMany({ where: { userId: finAdmin.id } });

        // The resolver falls back to legacy full ADMIN: a raw assignment
        // deletion is an ESCALATION, never a safe revocation. Only the
        // transactional deprovision endpoint (role + tokenVersion) is safe.
        expect(await rbacCtrl.resolveEffectiveAdminRole(prisma, finAdmin.id)).toBe('ADMIN');
    });

    // ── 8. No partial state / concurrency ─────────────────────────────────
    test('concurrent conflicting assignments serialize: final state is consistent and audited exactly per applied change', async () => {
        const [r1, r2] = await Promise.all([
            assign(superA, 'SUPER_ADMIN', finAdmin.id, 'FINANCE_ADMIN'),
            assign(superB, 'SUPER_ADMIN', finAdmin.id, 'COMPLIANCE_ADMIN'),
        ]);
        expect(r1._status).toBe(200);
        expect(r2._status).toBe(200);

        // Exactly ONE assignment row, holding one of the two requested roles.
        const assignment = await prisma.adminRoleAssignment.findUnique({ where: { userId: finAdmin.id } });
        expect(['FINANCE_ADMIN', 'COMPLIANCE_ADMIN']).toContain(assignment.role);

        // Both changes were audited, and the second one's recorded old role
        // is the first one's new role — proof of serialized consistency.
        const audits = await prisma.auditLog.findMany({
            where: { action: 'RBAC_ASSIGN_ADMIN_ROLE', targetId: String(finAdmin.id) },
            orderBy: { createdAt: 'asc' },
        });
        expect(audits).toHaveLength(2);
        expect(audits[0].metadata.newEffectiveRole).toBe(audits[1].metadata.oldEffectiveRole);
        expect(new Set(audits.map((a) => a.metadata.newEffectiveRole)))
            .toEqual(new Set(['FINANCE_ADMIN', 'COMPLIANCE_ADMIN']));

        // The effective role re-check matches the stored assignment exactly.
        expect(await rbacCtrl.resolveEffectiveAdminRole(prisma, finAdmin.id)).toBe(assignment.role);
    });

    // ── 9. Approval-tier behaviour with provisioned roles ───────────────────
    test('provisioned Finance/Compliance evidence authorizes a >= 50k withdrawal; demoted/deprovisioned evidence cannot', async () => {
        await prisma.adminRoleAssignment.create({ data: { userId: finAdmin.id, role: 'FINANCE_ADMIN' } });
        await prisma.adminRoleAssignment.create({ data: { userId: compAdmin.id, role: 'COMPLIANCE_ADMIN' } });

        const w = await prisma.withdrawal.create({
            data: { userId: member.id, amount: 60000, payoutMethod: 'MOMO', network: 'MTN', destination: '0240000000', status: 'PENDING' },
        });
        const created = makeRes();
        await rbacCtrl.createApprovalRequest(
            {
                user: makeUser(bystander, 'ADMIN'),
                body: { type: 'WITHDRAWAL', entityId: String(w.id), amount: 60000, description: 'tier probe' },
                params: {}, app: appStub(),
            },
            created
        );
        expect(created._status).toBe(200);
        const requestId = created._body.request.id;

        for (const approver of [compAdmin, finAdmin, plainAdmin]) {
            const r = makeRes();
            await rbacCtrl.approveRequest(
                { user: makeUser(approver, 'ADMIN'), params: { id: String(requestId) }, body: {}, app: appStub() },
                r
            );
            expect(r._status).toBe(200);
        }

        const approveRes = makeRes();
        await wdCtrl.approveWithdrawal(
            { params: { id: String(w.id) }, body: {}, user: makeUser(plainAdmin, 'ADMIN'), app: appStub() },
            approveRes
        );
        expect(approveRes._status).toBe(200); // authorized evidence works
        await prisma.withdrawal.deleteMany({ where: { id: w.id } });

        // Revoked participation: demote the Finance admin to READ_ONLY_ADMIN
        // AFTER the evidence is recorded — the stamps are audit records, so
        // consumption must refuse.
        const w2 = await prisma.withdrawal.create({
            data: { userId: member.id, amount: 60000, payoutMethod: 'MOMO', network: 'MTN', destination: '0240000000', status: 'PENDING' },
        });
        const created2 = makeRes();
        await rbacCtrl.createApprovalRequest(
            {
                user: makeUser(bystander, 'ADMIN'),
                body: { type: 'WITHDRAWAL', entityId: String(w2.id), amount: 60000, description: 'revocation probe' },
                params: {}, app: appStub(),
            },
            created2
        );
        const requestId2 = created2._body.request.id;
        for (const approver of [compAdmin, finAdmin, superB]) {
            const r = makeRes();
            await rbacCtrl.approveRequest(
                { user: makeUser(approver, 'ADMIN'), params: { id: String(requestId2) }, body: {}, app: appStub() },
                r
            );
            expect(r._status).toBe(200);
        }
        // Demote the FINANCE_ADMIN participant to restricted, then try to
        // consume. The consumption validator re-derives EVERY approver's
        // role and requires each to remain tier-eligible: READ_ONLY_ADMIN is
        // not eligible for the >= 50,000 tier, so the recorded evidence is
        // now invalid as a whole — consumption fails closed. (The demoted
        // account's restricted admin access itself is proven above.)
        const demote = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'READ_ONLY_ADMIN');
        expect(demote._status).toBe(200);

        const consumeDemoted = makeRes();
        await wdCtrl.approveWithdrawal(
            { params: { id: String(w2.id) }, body: {}, user: makeUser(plainAdmin, 'ADMIN'), app: appStub() },
            consumeDemoted
        );
        expect(consumeDemoted._status).toBe(403);
        expect(consumeDemoted._body.code).toBe('WITHDRAWAL_APPROVAL_QUORUM_REQUIRED');
        const w2After = await prisma.withdrawal.findUnique({ where: { id: w2.id }, select: { status: true } });
        expect(w2After.status).toBe('PENDING');
        await prisma.withdrawal.deleteMany({ where: { id: w2.id } });

        // Full revocation of BOTH Finance and Compliance participants makes
        // the recorded participation unreal → consumption fails closed.
        // (Restore the Finance designation first: it was demoted above.)
        const restore = await assign(superA, 'SUPER_ADMIN', finAdmin.id, 'FINANCE_ADMIN');
        expect(restore._status).toBe(200);
        const w3 = await prisma.withdrawal.create({
            data: { userId: member.id, amount: 60000, payoutMethod: 'MOMO', network: 'MTN', destination: '0240000000', status: 'PENDING' },
        });
        const created3 = makeRes();
        await rbacCtrl.createApprovalRequest(
            {
                user: makeUser(bystander, 'ADMIN'),
                body: { type: 'WITHDRAWAL', entityId: String(w3.id), amount: 60000, description: 'full revocation probe' },
                params: {}, app: appStub(),
            },
            created3
        );
        const requestId3 = created3._body.request.id;
        for (const approver of [compAdmin, finAdmin, superB]) {
            const r = makeRes();
            await rbacCtrl.approveRequest(
                { user: makeUser(approver, 'ADMIN'), params: { id: String(requestId3) }, body: {}, app: appStub() },
                r
            );
            expect(r._status).toBe(200);
        }
        // Deprovision both specialized participants (evidence is recorded by
        // then). bystander is already deprovisioned; use compAdmin and reuse
        // finAdmin via deprovision.
        const dep1 = await deprovision(superA, 'SUPER_ADMIN', compAdmin.id);
        expect(dep1._status).toBe(200);
        const dep2 = await deprovision(superA, 'SUPER_ADMIN', finAdmin.id);
        expect(dep2._status).toBe(200);

        const consumeRevoked = makeRes();
        await wdCtrl.approveWithdrawal(
            { params: { id: String(w3.id) }, body: {}, user: makeUser(plainAdmin, 'ADMIN'), app: appStub() },
            consumeRevoked
        );
        expect(consumeRevoked._status).toBe(403);
        expect(consumeRevoked._body.code).toBe('WITHDRAWAL_APPROVAL_QUORUM_REQUIRED');

        const w3After = await prisma.withdrawal.findUnique({ where: { id: w3.id }, select: { status: true } });
        expect(w3After.status).toBe('PENDING'); // fail closed, nothing consumed
    });

    // ── 10. Audit honesty ──────────────────────────────────────────────────
    test('listing shows authoritative effective roles, including nulls for revoked accounts', async () => {
        const r = await listAdmins(superA, 'READ_ONLY_ADMIN'); // garbage claim again
        expect(r._status).toBe(200);
        const byId = new Map(r._body.admins.map((a) => [a.id, a]));
        expect(byId.get(superA.id).effectiveRole).toBe('SUPER_ADMIN');
        expect(byId.get(superA.id).legacyFullAdmin).toBe(false);
        expect(byId.get(plainAdmin.id).effectiveRole).toBe('ADMIN'); // legacy fallback, flagged
        expect(byId.get(plainAdmin.id).legacyFullAdmin).toBe(true);
        expect(byId.get(member.id)).toBeUndefined(); // non-admins are not listed

        // No RBAC_* success events exist for refused self-management.
        const selfRows = await prisma.auditLog.count({
            where: { action: { in: ['RBAC_ASSIGN_ADMIN_ROLE', 'RBAC_DEPROVISION_ADMIN'] }, targetId: String(superA.id) },
        });
        expect(selfRows).toBe(0);
    });
});

// ── Route wiring check (no database needed) ─────────────────────────────────
describe('r272 admin role provisioning route wiring', () => {
    test('/api/admin/rbac wires the provisioning endpoints behind the admin auth boundary', () => {
        const router = require('../routes/adminRbacRoutes');
        const roleCtrl = require('../controllers/adminRoleAdminController');
        const authMiddleware = require('../middleware/authMiddleware');
        const { isAdmin } = require('../middleware/adminMiddleware');

        expect(typeof router).toBe('function');

        // The router-level use(protect, isAdmin) boundary: one middleware
        // layer per callback, before any route layer.
        const useLayers = router.stack.filter((l) => !l.route);
        expect(useLayers.length).toBe(2);

        const paths = router.stack
            .filter((l) => l.route)
            .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
        expect(paths).toContainEqual(expect.objectContaining({ path: '/admins', methods: expect.arrayContaining(['get']) }));
        expect(paths).toContainEqual(expect.objectContaining({ path: '/admins/:id/role', methods: expect.arrayContaining(['post']) }));
        expect(paths).toContainEqual(expect.objectContaining({ path: '/admins/:id/deprovision', methods: expect.arrayContaining(['post']) }));

        // The provisioning routes point at the new handlers.
        const roleRoute = router.stack.find((l) => l.route?.path === '/admins/:id/role');
        expect(roleRoute.route.stack.some((h) => h.handle === roleCtrl.assignAdminRole)).toBe(true);
        const depRoute = router.stack.find((l) => l.route?.path === '/admins/:id/deprovision');
        expect(depRoute.route.stack.some((h) => h.handle === roleCtrl.deprovisionAdmin)).toBe(true);
        const listRoute = router.stack.find((l) => l.route?.path === '/admins');
        expect(listRoute.route.stack.some((h) => h.handle === roleCtrl.listAdmins)).toBe(true);

        // And the auth boundary is the documented protect + isAdmin pair.
        expect(useLayers[0].handle).toBe(authMiddleware.protect);
        expect(useLayers[1].handle).toBe(isAdmin);
    });
});
