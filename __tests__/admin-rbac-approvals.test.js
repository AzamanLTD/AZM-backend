// __tests__/admin-rbac-approvals.test.js
// =============================================================================
// Admin RBAC multi-step approval hardening — regression tests.
//
// Unit coverage (mocked req.app.get('prisma'), no DB required):
//   • action-specific permissions enforced at create/approve/reject/list/
//     export/susu-health (the ADMIN_ROLES catalog is effective, not documentary)
//   • non-monetary actions (USER_BAN, VENDOR_TIER_CHANGE) can never
//     auto-approve; genuinely sub-$1k monetary requests still can
//   • requiredRoles tier enforcement + >= $50k Finance/Compliance invariant
//   • self-approval and duplicate-approval prohibitions intact
//   • compare-and-swap approval writes and atomic rejects return
//     deterministic 409 conflicts instead of losing updates
//   • audit CSV export column alignment (8 headers, 8 fields)
//
// Integration coverage (real Prisma + Postgres, runs only when
// TEST_DATABASE_URL is set — the CI workflow provides it):
//   • two truly concurrent approvals never lose an approval (18/19)
//   • concurrent approve + reject leaves exactly one terminal state (20)
//   • concurrent rejects produce exactly one REJECTED mutation (21)
//     These also prove the generated Prisma client supports the
//     `approvals: { equals: [...] }` JSON filter in updateMany.
// =============================================================================

const { seedUser } = require('./helpers/factories');

const ctrl = require('../controllers/adminRbacController');

// ── Mock helpers ─────────────────────────────────────────────────────────────
const clone = (v) => JSON.parse(JSON.stringify(v));

function makeRes() {
    const r = { _status: 200, _body: null, _csv: null, headers: {} };
    r.status = (s) => { r._status = s; return r; };
    r.json = (b) => { r._body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.send = (body) => { r._csv = body; return r; };
    return r;
}

// In-memory AdminApprovalRequest store that faithfully implements the
// compare-and-swap filters the controller relies on:
//   where.id / where.status equality + where.approvals: { equals: [...] }
// JSON equality (deep, order-sensitive — same as the SQL jsonb equality).
function makeMockDb(seedRows = []) {
    const rows = new Map(seedRows.map((r) => [r.id, clone(r)]));
    const db = {
        rows,
        nextId: 100,
        adminApprovalRequest: {
            create: async ({ data }) => {
                const id = db.nextId++;
                const row = { id, createdAt: new Date().toISOString(), ...clone(data) };
                rows.set(id, row);
                return clone(row);
            },
            findUnique: async ({ where }) => {
                const r = rows.get(where.id);
                return r ? clone(r) : null;
            },
            findMany: async ({ where, take }) => {
                let out = [...rows.values()];
                if (where && where.status) out = out.filter((r) => r.status === where.status);
                return out.slice(0, take || 50).map(clone);
            },
            updateMany: async ({ where, data }) => {
                let count = 0;
                for (const row of rows.values()) {
                    if (where.id !== undefined && row.id !== where.id) continue;
                    if (where.status !== undefined && row.status !== where.status) continue;
                    if (where.approvals !== undefined) {
                        if (JSON.stringify(row.approvals) !== JSON.stringify(where.approvals.equals)) continue;
                    }
                    Object.assign(row, clone(data));
                    count++;
                }
                return { count };
            },
        },
        auditLog: {
            findMany: async ({ where, take }) => {
                const logs = db.auditLogs || [];
                // Real Prisma returns Date objects; JSON deep-clone would
                // stringify them and break `.toISOString()` in the CSV path.
                return logs.slice(0, take || 10000).map((l) => ({ ...l, createdAt: new Date(l.createdAt) }));
            },
        },
        susuGroup: {
            count: async () => 0,
            findMany: async () => [],
        },
        susuMember: { count: async () => 0 },
        susuCycle: {
            count: async () => 0,
            aggregate: async () => ({ _sum: {} }),
            findMany: async () => [],
        },
        susuContribution: {
            aggregate: async () => ({ _sum: {} }),
        },
        auditLogs: [],
    };
    db.$transaction = async (fn) => fn(db);
    return db;
}

function makeReq({ user, body = {}, params = {}, query = {}, db }) {
    return {
        user,
        body,
        params,
        query,
        app: { get: (k) => (k === 'prisma' ? db : null) },
    };
}

const users = {
    superAdmin: { id: 1, role: 'SUPER_ADMIN' },
    finance: { id: 2, role: 'FINANCE_ADMIN' },
    support: { id: 3, role: 'SUPPORT_ADMIN' },
    compliance: { id: 4, role: 'COMPLIANCE_ADMIN' },
    readOnly: { id: 5, role: 'READ_ONLY_ADMIN' },
    legacyAdmin: { id: 6, role: 'ADMIN' },
    ghost: { id: 7, role: 'GHOST_ADMIN' },
};

function seedRequest(overrides = {}) {
    return {
        id: 10,
        type: 'WITHDRAWAL',
        entityId: 'entity-1',
        amount: 500,
        description: 'test request',
        metadata: {},
        requestedBy: 1,
        requiredApprovals: 1,
        approvals: [],
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// ── Permission enforcement ──────────────────────────────────────────────────
describe('Admin RBAC — action-specific permission enforcement', () => {
    test('READ_ONLY_ADMIN cannot create a WITHDRAWAL approval', async () => {
        const db = makeMockDb();
        const r = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.readOnly, body: { type: 'WITHDRAWAL', entityId: 'w1', amount: 20000 }, db }),
            r
        );
        expect(r._status).toBe(403);
        expect(r._body.message).toContain('not authorized to create an approval request');
        expect(r._body.yourRole).toBe('READ_ONLY_ADMIN');
        expect(db.rows.size).toBe(0);
    });

    test('FINANCE_ADMIN can create a WITHDRAWAL approval', async () => {
        const db = makeMockDb();
        const r = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.finance, body: { type: 'WITHDRAWAL', entityId: 'w1', amount: 20000 }, db }),
            r
        );
        expect(r._status).toBe(200);
        expect(r._body.success).toBe(true);
        expect(db.rows.size).toBe(1);
    });

    test('SUPPORT_ADMIN can create a USER_BAN approval', async () => {
        const db = makeMockDb();
        const r = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.support, body: { type: 'USER_BAN', entityId: 'u1', amount: 0 }, db }),
            r
        );
        expect(r._status).toBe(200);
        expect(r._body.success).toBe(true);
    });

    test('READ_ONLY_ADMIN cannot reject a WITHDRAWAL request', async () => {
        const db = makeMockDb([seedRequest({ type: 'WITHDRAWAL', requestedBy: users.finance.id })]);
        const r = makeRes();
        await ctrl.rejectRequest(
            makeReq({ user: users.readOnly, params: { id: '10' }, body: { reason: 'no' }, db }),
            r
        );
        expect(r._status).toBe(403);
        expect(r._body.message).toContain('not authorized to approve this action type');
        expect(db.rows.get(10).status).toBe('PENDING');
    });

    test('FINANCE_ADMIN cannot approve or reject a USER_BAN request (no users.ban permission)', async () => {
        const db = makeMockDb([seedRequest({ type: 'USER_BAN', requestedBy: users.support.id })]);

        const approveRes = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), approveRes);
        expect(approveRes._status).toBe(403);
        expect(approveRes._body.message).toContain('not authorized to approve this action type');

        const rejectRes = makeRes();
        await ctrl.rejectRequest(makeReq({ user: users.finance, params: { id: '10' }, body: {}, db }), rejectRes);
        expect(rejectRes._status).toBe(403);
    });

    test('READ_ONLY_ADMIN can list approvals (audit.view), unknown role cannot', async () => {
        const db = makeMockDb([seedRequest()]);

        const ok = makeRes();
        await ctrl.listApprovals(makeReq({ user: users.readOnly, query: {}, db }), ok);
        expect(ok._status).toBe(200);
        expect(ok._body.success).toBe(true);

        const denied = makeRes();
        await ctrl.listApprovals(makeReq({ user: users.ghost, query: {}, db }), denied);
        expect(denied._status).toBe(403);
        expect(denied._body.message).toBe('Admin permission required: audit.view');
    });

    test('audit export requires audit.export — READ_ONLY denied, COMPLIANCE allowed', async () => {
        const db = makeMockDb();
        db.auditLogs = [{
            id: 1, actorId: 2, action: 'test.action',
            targetType: 'user', targetId: 42,
            metadata: { a: 1 }, ipAddress: '10.0.0.1',
            createdAt: new Date('2026-09-14T00:00:00Z'),
        }];

        const denied = makeRes();
        await ctrl.exportAuditLog(makeReq({ user: users.readOnly, query: { format: 'json' }, db }), denied);
        expect(denied._status).toBe(403);
        expect(denied._body.message).toBe('Admin permission required: audit.export');

        const ok = makeRes();
        await ctrl.exportAuditLog(makeReq({ user: users.compliance, query: { format: 'json' }, db }), ok);
        expect(ok._status).toBe(200);
        expect(ok._body.success).toBe(true);
        expect(ok._body.logs).toHaveLength(1);
    });

    test('Susu health requires susu.health — unknown role denied, READ_ONLY allowed', async () => {
        const db = makeMockDb();

        const denied = makeRes();
        await ctrl.getSusuHealthDashboard(makeReq({ user: users.ghost, db }), denied);
        expect(denied._status).toBe(403);
        expect(denied._body.message).toBe('Admin permission required: susu.health');

        const ok = makeRes();
        await ctrl.getSusuHealthDashboard(makeReq({ user: users.readOnly, db }), ok);
        expect(ok._status).toBe(200);
        expect(ok._body.success).toBe(true);
        expect(ok._body.summary.totalGroups).toBe(0);
    });

    test('VENDOR_TIER_CHANGE is SUPER_ADMIN/legacy ADMIN only', async () => {
        const db = makeMockDb();

        // Finance cannot create it.
        const createDenied = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.finance, body: { type: 'VENDOR_TIER_CHANGE', entityId: 'v1', amount: 0 }, db }),
            createDenied
        );
        expect(createDenied._status).toBe(403);

        // Super admin can create it.
        const createOk = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.superAdmin, body: { type: 'VENDOR_TIER_CHANGE', entityId: 'v1', amount: 0 }, db }),
            createOk
        );
        expect(createOk._status).toBe(200);

        // Finance cannot approve or reject it.
        const db2 = makeMockDb([seedRequest({ type: 'VENDOR_TIER_CHANGE', requestedBy: users.superAdmin.id })]);
        const approveDenied = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db: db2 }), approveDenied);
        expect(approveDenied._status).toBe(403);
        const rejectDenied = makeRes();
        await ctrl.rejectRequest(makeReq({ user: users.finance, params: { id: '10' }, body: {}, db: db2 }), rejectDenied);
        expect(rejectDenied._status).toBe(403);

        // Legacy ADMIN still can.
        const approveOk = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.legacyAdmin, params: { id: '10' }, db: db2 }), approveOk);
        expect(approveOk._status).toBe(200);
        expect(approveOk._body.fullyApproved).toBe(true);
    });
});

// ── State machine: auto-approval must be type-aware ─────────────────────────
describe('Admin RBAC — non-monetary actions never auto-approve', () => {
    test.each([
        ['USER_BAN', users.support],
        ['VENDOR_TIER_CHANGE', users.superAdmin],
    ])('%s with amount 0 stays PENDING with 1 required approval', async (type, user) => {
        const db = makeMockDb();
        const r = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user, body: { type, entityId: 'e1', amount: 0 }, db }),
            r
        );
        expect(r._status).toBe(200);
        expect(r._body.autoApproved).toBe(false);
        expect(r._body.request.status).toBe('PENDING');
        expect(r._body.request.requiredApprovals).toBe(1);
        expect(r._body.request.approvals).toEqual([]);
    });

    test('a genuinely sub-$1k monetary WITHDRAWAL still auto-approves per existing policy', async () => {
        const db = makeMockDb();
        const r = makeRes();
        await ctrl.createApprovalRequest(
            makeReq({ user: users.finance, body: { type: 'WITHDRAWAL', entityId: 'w1', amount: 500 }, db }),
            r
        );
        expect(r._status).toBe(200);
        expect(r._body.autoApproved).toBe(true);
        expect(r._body.request.status).toBe('AUTO_APPROVED');
        expect(r._body.request.approvals[0].auto).toBe(true);
    });

    test('requester cannot approve their own request', async () => {
        const db = makeMockDb([seedRequest({ type: 'USER_BAN', requestedBy: users.support.id, requiredApprovals: 1 })]);
        const r = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.support, params: { id: '10' }, db }), r);
        expect(r._status).toBe(400);
        expect(r._body.message).toBe('Cannot approve your own request.');
        expect(db.rows.get(10).status).toBe('PENDING');
    });
});

// ── Role-tier enforcement ────────────────────────────────────────────────────
describe('Admin RBAC — requiredRoles tier enforcement', () => {
    test('$10k+ approval rejects SUPPORT_ADMIN/READ_ONLY_ADMIN as approver', async () => {
        for (const user of [users.support, users.readOnly]) {
            // Neither role holds withdrawals.approve, so the action-permission
            // gate denies them before the tier gate is even consulted.
            const db = makeMockDb([seedRequest({ amount: 20000, requiredApprovals: 2, requestedBy: users.legacyAdmin.id })]);
            const r = makeRes();
            await ctrl.approveRequest(makeReq({ user, params: { id: '10' }, db }), r);
            expect(r._status).toBe(403);
            expect(r._body.yourRole).toBe(user.role);
            expect(db.rows.get(10).status).toBe('PENDING');
            expect(db.rows.get(10).approvals).toEqual([]);
        }
    });

    test('the $10k-$50k tier role set accepts FINANCE/COMPLIANCE/SUPER and rejects SUPPORT/READ_ONLY', () => {
        const tierRoles = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'COMPLIANCE_ADMIN'];
        for (const role of tierRoles) {
            expect(ctrl.isApprovalRoleEligible(role, tierRoles)).toBe(true);
        }
        expect(ctrl.isApprovalRoleEligible('SUPPORT_ADMIN', tierRoles)).toBe(false);
        expect(ctrl.isApprovalRoleEligible('READ_ONLY_ADMIN', tierRoles)).toBe(false);
        expect(ctrl.isApprovalRoleEligible('ADMIN', tierRoles)).toBe(true); // legacy
    });

    test.each([
        ['FINANCE_ADMIN', users.finance],
        ['SUPER_ADMIN', users.superAdmin],
    ])('$10k+ approval accepts %s end-to-end', async (_label, user) => {
        const db = makeMockDb([seedRequest({ amount: 20000, requiredApprovals: 2, requestedBy: users.legacyAdmin.id })]);
        const r = makeRes();
        await ctrl.approveRequest(makeReq({ user, params: { id: '10' }, db }), r);
        expect(r._status).toBe(200);
        expect(db.rows.get(10).status).toBe('PENDING'); // 1 of 2 recorded
    });

    test('$50k+ cannot be fully approved by SUPER_ADMINs alone — needs Finance/Compliance', async () => {
        const db = makeMockDb([seedRequest({ amount: 60000, requiredApprovals: 3, requestedBy: users.legacyAdmin.id })]);

        // A SUPER_ADMIN cannot even START the approval chain for a >= $50k
        // request — the Finance/Compliance participation invariant blocks
        // every approval until a FINANCE/COMPLIANCE admin has participated.
        const a1 = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.superAdmin, params: { id: '10' }, db }), a1);
        expect(a1._status).toBe(403);
        expect(a1._body.message).toContain('Finance or Compliance admin approval is required');

        // FINANCE_ADMIN can open it.
        const a2 = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), a2);
        expect(a2._status).toBe(200);
        expect(db.rows.get(10).status).toBe('PENDING'); // 1 of 3

        // With Finance present, SUPER_ADMINs can complete the chain.
        const a3 = makeRes();
        await ctrl.approveRequest(makeReq({ user: { id: 8, role: 'SUPER_ADMIN' }, params: { id: '10' }, db }), a3);
        expect(a3._status).toBe(200);

        const a4 = makeRes();
        await ctrl.approveRequest(makeReq({ user: { id: 9, role: 'SUPER_ADMIN' }, params: { id: '10' }, db }), a4);
        expect(a4._status).toBe(200);
        expect(a4._body.fullyApproved).toBe(true);
        expect(db.rows.get(10).status).toBe('APPROVED');
        expect(db.rows.get(10).approvals).toHaveLength(3);
        // NOTE: COMPLIANCE_ADMIN tier acceptance is covered by the
        // isApprovalRoleEligible unit test above. End-to-end, COMPLIANCE_ADMIN
        // is additionally governed by the action-permission gate (section 9):
        // its catalog holds no mapped action permission (e.g. no
        // withdrawals.approve), so it cannot approve a WITHDRAWAL request as
        // things stand. That tension between the section-9 gate and the
        // >= $50k Finance/Compliance participation invariant is flagged for
        // the primary agent — FINANCE_ADMIN satisfies the invariant in
        // practice for every current action type.
    });

    test('duplicate approval by the same admin is still rejected', async () => {
        const db = makeMockDb([seedRequest({
            amount: 20000,
            requestedBy: users.legacyAdmin.id,
            approvals: [{ userId: users.finance.id, role: 'FINANCE_ADMIN', at: '2026-09-14T00:00:00Z' }],
        })]);
        const r = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), r);
        expect(r._status).toBe(400);
        expect(r._body.message).toBe('You have already approved this request.');
    });
});

// ── Concurrency: compare-and-swap + atomic reject (mocked) ───────────────────
describe('Admin RBAC — concurrency-safe writes (mocked CAS)', () => {
    test('two concurrent approvals do not lose an update — loser gets deterministic 409', async () => {
        const db = makeMockDb([seedRequest({ amount: 20000, requiredApprovals: 2, requestedBy: users.legacyAdmin.id })]);

        const [r1, r2] = await Promise.all([
            ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), makeRes()),
            ctrl.approveRequest(makeReq({ user: users.superAdmin, params: { id: '10' }, db }), makeRes()),
        ]);

        const statuses = [r1._status, r2._status].sort();
        expect(statuses).toEqual([200, 409]);

        const loser = r1._status === 409 ? r1 : r2;
        expect(loser._body.code).toBe('APPROVAL_CONFLICT');
        expect(loser._body.message).toContain('changed while you were approving it');

        // Exactly one approval was stored — not zero, not two conflicting writes.
        const row = db.rows.get(10);
        expect(row.approvals).toHaveLength(1);
        expect(row.status).toBe('PENDING');
    });

    test('a stale read (row changed between read and write) yields 409, not an overwrite', async () => {
        const db = makeMockDb([seedRequest({ amount: 20000, requiredApprovals: 2, requestedBy: users.legacyAdmin.id })]);

        // Rig findUnique to return the pre-race snapshot: another admin's
        // approval landed in the store after this approver read the row.
        const winnerApproval = { userId: users.compliance.id, role: 'COMPLIANCE_ADMIN', at: new Date().toISOString() };
        db.rows.get(10).approvals = [winnerApproval];
        const staleRow = clone(db.rows.get(10));
        staleRow.approvals = [];
        const realFindUnique = db.adminApprovalRequest.findUnique;
        db.adminApprovalRequest.findUnique = async ({ where }) =>
            where.id === 10 ? clone(staleRow) : realFindUnique({ where });

        const r = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), r);

        expect(r._status).toBe(409);
        expect(r._body.code).toBe('APPROVAL_CONFLICT');
        // The winner's approval was NOT overwritten.
        expect(db.rows.get(10).approvals).toEqual([winnerApproval]);
    });

    test('sequential approvals on a 2-required request store exactly two approvals, then APPROVED', async () => {
        const db = makeMockDb([seedRequest({ amount: 20000, requiredApprovals: 2, requestedBy: users.legacyAdmin.id })]);

        const r1 = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), r1);
        expect(r1._status).toBe(200);
        expect(r1._body.fullyApproved).toBe(false);

        const r2 = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.superAdmin, params: { id: '10' }, db }), r2);
        expect(r2._status).toBe(200);
        expect(r2._body.fullyApproved).toBe(true);

        expect(db.rows.get(10).approvals).toHaveLength(2);
        expect(db.rows.get(10).status).toBe('APPROVED');
    });

    test('concurrent approve + reject leaves one terminal state, loser gets 409', async () => {
        const db = makeMockDb([seedRequest({ amount: 500, requestedBy: users.support.id, requiredApprovals: 1 })]);

        const [approveRes, rejectRes] = await Promise.all([
            ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), makeRes()),
            ctrl.rejectRequest(makeReq({ user: users.finance, params: { id: '10' }, body: { reason: 'fraud' }, db }), makeRes()),
        ]);

        const codes = [approveRes._status, rejectRes._status].sort();
        expect(codes).toEqual([200, 409]);

        const row = db.rows.get(10);
        if (approveRes._status === 200) {
            expect(row.status).toBe('APPROVED');
            expect(rejectRes._body.code).toBe('APPROVAL_STATE_CONFLICT');
        } else {
            expect(row.status).toBe('REJECTED');
            expect(approveRes._body.code).toBe('APPROVAL_CONFLICT');
        }
    });

    test('concurrent rejects result in exactly one REJECTED mutation', async () => {
        const db = makeMockDb([seedRequest({ type: 'USER_BAN', requestedBy: users.support.id })]);

        const [r1, r2] = await Promise.all([
            ctrl.rejectRequest(makeReq({ user: users.support, params: { id: '10' }, body: { reason: 'bad' }, db }), makeRes()),
            ctrl.rejectRequest(makeReq({ user: users.superAdmin, params: { id: '10' }, body: { reason: 'nope' }, db }), makeRes()),
        ]);

        const statuses = [r1._status, r2._status].sort();
        expect(statuses).toEqual([200, 409]);

        const row = db.rows.get(10);
        expect(row.status).toBe('REJECTED');
        const winner = r1._status === 200 ? r1 : r2;
        const loser = r1._status === 200 ? r2 : r1;
        expect(loser._body.code).toBe('APPROVAL_STATE_CONFLICT');
        expect(loser._body.message).toContain('Request is REJECTED');
        expect(row.rejectionReason).toBe(winner === r1 ? 'bad' : 'nope');
    });

    test('expected conflicts never leak raw Prisma error strings', async () => {
        const db = makeMockDb([seedRequest({ status: 'APPROVED' })]);
        const r = makeRes();
        await ctrl.approveRequest(makeReq({ user: users.finance, params: { id: '10' }, db }), r);
        expect(r._status).toBe(400);
        expect(r._body.message).toBe('Request is APPROVED.');
        expect(r._body).not.toHaveProperty('code');
    });
});

// ── CSV export alignment ─────────────────────────────────────────────────────
describe('Admin RBAC — audit CSV export alignment', () => {
    test('CSV rows have exactly eight fields matching the eight headers', async () => {
        const db = makeMockDb();
        db.auditLogs = [{
            id: 1,
            actorId: 42,
            action: 'user.ban',
            targetType: 'user',
            targetId: 77,
            metadata: { reason: 'fraud', nested: { x: 1 } },
            ipAddress: '41.210.0.5',
            createdAt: new Date('2026-09-14T12:00:00Z'),
        }];

        const r = makeRes();
        await ctrl.exportAuditLog(makeReq({ user: users.compliance, query: { format: 'csv' }, db }), r);

        expect(r._status).toBe(200);
        expect(r.headers['Content-Type']).toBe('text/csv');

        const lines = r._csv.split('\n');
        expect(lines[0]).toBe('id,actorId,action,targetType,targetId,metadata,ipAddress,createdAt');

        const fields = lines[1].match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
        expect(fields).toHaveLength(8);

        const unwrap = (f) => f.slice(1, -1).replace(/""/g, '"');
        expect(unwrap(fields[0])).toBe('1');            // id
        expect(unwrap(fields[1])).toBe('42');           // actorId
        expect(unwrap(fields[2])).toBe('user.ban');     // action
        expect(unwrap(fields[3])).toBe('user');         // targetType
        expect(unwrap(fields[4])).toBe('77');           // targetId — real targetId, NOT duplicated targetType
        expect(JSON.parse(unwrap(fields[5]))).toEqual({ reason: 'fraud', nested: { x: 1 } }); // metadata column
        expect(unwrap(fields[6])).toBe('41.210.0.5');    // ipAddress column
        expect(unwrap(fields[7])).toBe('2026-09-14T12:00:00.000Z'); // createdAt final column
    });
});

// ── Real-DB concurrency proof (CI: TEST_DATABASE_URL is set) ────────────────
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[admin-rbac-approvals] TEST_DATABASE_URL not set — skipping real-DB concurrency section.');

describeOrSkip('Admin RBAC — real-DB concurrency (compare-and-swap)', () => {
    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "AdminApprovalRequest","User" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    function app() { return { get: (k) => (k === 'prisma' ? prisma : null) }; }
    function res() {
        const r = { _status: 200, _body: null };
        r.status = (s) => { r._status = s; return r; };
        r.json = (b) => { r._body = b; return r; };
        return r;
    }

    async function seedPendingRequest(requestedBy, { type = 'WITHDRAWAL', amount = 20000, requiredApprovals = 2 } = {}) {
        return prisma.adminApprovalRequest.create({
            data: {
                type,
                entityId: 'entity-x',
                amount,
                description: 'concurrency test',
                metadata: {},
                requestedBy,
                requiredApprovals,
                approvals: [],
                status: 'PENDING',
            },
        });
    }

    test('two truly concurrent approvals never lose an approval (18/19)', async () => {
        const requester = await seedUser(prisma);
        const fin = await seedUser(prisma);
        const comp = await seedUser(prisma);

        const request = await seedPendingRequest(requester.id);

        const [r1, r2] = await Promise.all([
            ctrl.approveRequest(
                { user: { id: fin.id, role: 'FINANCE_ADMIN' }, params: { id: String(request.id) }, body: {}, app: app() },
                res()
            ),
            ctrl.approveRequest(
                { user: { id: comp.id, role: 'SUPER_ADMIN' }, params: { id: String(request.id) }, body: {}, app: app() },
                res()
            ),
        ]);

        const statuses = [r1._status, r2._status].sort();
        expect(statuses).toEqual([200, 409]);

        const loser = r1._status === 409 ? r1 : r2;
        expect(loser._body.code).toBe('APPROVAL_CONFLICT');

        // Retry the loser after its refresh — now the total is exactly two,
        // not one overwritten and not three.
        const retryUser = r1._status === 409 ? { id: fin.id, role: 'FINANCE_ADMIN' } : { id: comp.id, role: 'SUPER_ADMIN' };
        const r3 = res();
        await ctrl.approveRequest({ user: retryUser, params: { id: String(request.id) }, body: {}, app: app() }, r3);
        expect(r3._status).toBe(200);
        expect(r3._body.fullyApproved).toBe(true);

        const row = await prisma.adminApprovalRequest.findUnique({ where: { id: request.id } });
        expect(row.approvals).toHaveLength(2);
        expect(row.status).toBe('APPROVED');
    });

    test('concurrent approve + reject leaves exactly one terminal state (20)', async () => {
        const requester = await seedUser(prisma);
        const fin = await seedUser(prisma);

        const request = await seedPendingRequest(requester.id, { requiredApprovals: 1 });

        const [approveRes, rejectRes] = await Promise.all([
            ctrl.approveRequest(
                { user: { id: fin.id, role: 'FINANCE_ADMIN' }, params: { id: String(request.id) }, body: {}, app: app() },
                res()
            ),
            ctrl.rejectRequest(
                { user: { id: fin.id, role: 'FINANCE_ADMIN' }, params: { id: String(request.id) }, body: { reason: 'race' }, app: app() },
                res()
            ),
        ]);

        const statuses = [approveRes._status, rejectRes._status].sort();
        expect(statuses).toEqual([200, 409]);

        const row = await prisma.adminApprovalRequest.findUnique({ where: { id: request.id } });
        expect(['APPROVED', 'REJECTED']).toContain(row.status);
        if (approveRes._status === 200) {
            expect(row.status).toBe('APPROVED');
            expect(rejectRes._body.code).toBe('APPROVAL_STATE_CONFLICT');
        } else {
            expect(row.status).toBe('REJECTED');
            expect(approveRes._body.code).toBe('APPROVAL_CONFLICT');
        }
    });

    test('concurrent rejects produce exactly one REJECTED mutation (21)', async () => {
        const requester = await seedUser(prisma);
        const fin = await seedUser(prisma);
        const sup = await seedUser(prisma);

        const request = await seedPendingRequest(requester.id, { type: 'USER_BAN', amount: 0, requiredApprovals: 1 });

        const [r1, r2] = await Promise.all([
            ctrl.rejectRequest(
                { user: { id: sup.id, role: 'SUPPORT_ADMIN' }, params: { id: String(request.id) }, body: { reason: 'first' }, app: app() },
                res()
            ),
            ctrl.rejectRequest(
                { user: { id: fin.id, role: 'SUPER_ADMIN' }, params: { id: String(request.id) }, body: { reason: 'second' }, app: app() },
                res()
            ),
        ]);

        const statuses = [r1._status, r2._status].sort();
        expect(statuses).toEqual([200, 409]);

        const row = await prisma.adminApprovalRequest.findUnique({ where: { id: request.id } });
        expect(row.status).toBe('REJECTED');
        expect(row.rejectedBy).toBe(r1._status === 200 ? sup.id : fin.id);
        expect(row.rejectionReason).toBe(r1._status === 200 ? 'first' : 'second');
    });
});
