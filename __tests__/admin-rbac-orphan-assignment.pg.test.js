// =============================================================================
// Orphan AdminRoleAssignment must not confer authority.
//
// AdminRoleAssignment.userId has no foreign key to User, so an assignment can
// outlive its account. When the id sequence is recycled the next account inherits
// it. This was not hypothetical: CI run 43728774245 failed admin-actions test C
// because a fresh ADMIN inherited a READ_ONLY_ADMIN assignment from an earlier
// suite and was refused users.ban (403).
//
// The resolution rule under test: an assignment created BEFORE the account
// existed cannot have been granted to it, because the account must exist before
// a role can be assigned. Recycled ids are indistinguishable from real ones;
// timestamps are not.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const d = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[admin-rbac-orphan] TEST_DATABASE_URL not set — skipping.');

d('resolveEffectiveAdminRole — orphan assignments', () => {
    let prisma, rbac;
    const created = [];
    const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        rbac = require('../controllers/adminRbacController');
    });

    // Hermetic: this suite must not leak the very class of row it is about.
    afterAll(async () => {
        if (!prisma) return;
        for (const id of created) {
            await prisma.adminRoleAssignment.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    const makeAdmin = async () => {
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `orph_${u}`, email: `orph_${u}@t.local`, password: 'x', role: 'ADMIN' },
        });
        created.push(user.id);
        return user;
    };

    test('an assignment that predates the account is ignored, so the stored role wins', async () => {
        const admin = await makeAdmin();
        // Simulates a stale row left for a recycled id: created long before this account.
        await prisma.adminRoleAssignment.upsert({
            where: { userId: admin.id },
            update: { role: 'READ_ONLY_ADMIN', assignedAt: new Date(Date.now() - 3600_000) },
            create: { userId: admin.id, role: 'READ_ONLY_ADMIN', assignedAt: new Date(Date.now() - 3600_000) },
        });

        const role = await rbac.resolveEffectiveAdminRole(prisma, admin.id);
        expect(role).toBe('ADMIN'); // NOT READ_ONLY_ADMIN
        // and the narrowing that caused the 403 must now be allowed
        expect(rbac.checkAdminPermission({ id: admin.id, role }, 'users.ban')).toBe(true);
    });

    test('a legitimate assignment (created after the account) is still honoured', async () => {
        const admin = await makeAdmin();
        await prisma.adminRoleAssignment.upsert({
            where: { userId: admin.id },
            update: { role: 'READ_ONLY_ADMIN' },
            create: { userId: admin.id, role: 'READ_ONLY_ADMIN' },
        });

        const role = await rbac.resolveEffectiveAdminRole(prisma, admin.id);
        expect(role).toBe('READ_ONLY_ADMIN');
        expect(rbac.checkAdminPermission({ id: admin.id, role }, 'users.ban')).toBe(false);
    });

    test('the guard does not resurrect authority for a non-admin account', async () => {
        const u = uniq();
        const plain = await prisma.user.create({
            data: { username: `plain_${u}`, email: `plain_${u}@t.local`, password: 'x', role: 'USER' },
        });
        created.push(plain.id);
        await prisma.adminRoleAssignment.upsert({
            where: { userId: plain.id },
            update: { role: 'SUPER_ADMIN', assignedAt: new Date(Date.now() - 3600_000) },
            create: { userId: plain.id, role: 'SUPER_ADMIN', assignedAt: new Date(Date.now() - 3600_000) },
        });

        // storing USER + a predating (orphan) assignment must not yield a role at all
        expect(await rbac.resolveEffectiveAdminRole(prisma, plain.id)).toBeNull();
    });
});
