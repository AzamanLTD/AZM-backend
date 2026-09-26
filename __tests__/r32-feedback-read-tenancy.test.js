// __tests__/r32-feedback-read-tenancy.test.js
// =============================================================================
// r32 audit item C — EMPLOYEE FEEDBACK READ TENANCY (real PostgreSQL proofs).
//
// Historical defect: GET /feedback/for/:employeeId and /feedback/by/:employeeId
// passed ONLY the employee id into the service, which queried
// receiverEmployeeId/giverEmployeeId with no business binding — any tenant
// holding feedback.view could enumerate another tenant's feedback by id.
//
// Fixed contract:
//   • both read methods REQUIRE businessProfileId;
//   • the target employee is resolved INSIDE the effective business first;
//   • foreign employee ids → 'Employee not found.', never foreign feedback;
//   • the feedback query itself is business-scoped (defense in depth);
//   • the create-feedback same-business guard is preserved.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 C — employee feedback read tenancy (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { process.env.DATABASE_URL = url; db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => db.$executeRawUnsafe('TRUNCATE TABLE "EmployeeFeedback", "BusinessEmployee", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'));

    test('1. feedback FOR a same-business employee is returned; the query is business-scoped', async () => {
        const { biz: bizA, owner: ownerA } = await seedBusiness(db);
        const { biz: bizB, owner: ownerB } = await seedBusiness(db);
        const mkEmp = async (biz, user) => db.businessEmployee.create({
            data: { businessProfileId: biz.id, userId: user.id, role: 'STAFF', permissions: [] },
        });
        const extraUserA = await db.user.create({ data: { username: `fbx_a_${++seq}`, email: `fbx_a_${seq}@test.com`, password: 'x', azamanId: `AZM-FBA-${seq}` } });
        const extraUserB = await db.user.create({ data: { username: `fbx_b_${++seq}`, email: `fbx_b_${seq}@test.com`, password: 'x', azamanId: `AZM-FBB-${seq}` } });
        const empA1 = await mkEmp(bizA, ownerA, 1);
        const empA2 = await mkEmp(bizA, extraUserA, 2);
        const empB1 = await mkEmp(bizB, ownerB, 1);
        const empB2 = await mkEmp(bizB, extraUserB, 2);

        // Same-business feedback in A, and feedback in B.
        await db.employeeFeedback.create({
            data: { businessProfileId: bizA.id, giverEmployeeId: empA2.id, receiverEmployeeId: empA1.id, givenByUserId: extraUserA.id, receivedByUserId: ownerA.id, rating: 5, tags: [], periodStart: new Date(), periodEnd: new Date() },
        });
        await db.employeeFeedback.create({
            data: { businessProfileId: bizB.id, giverEmployeeId: empB2.id, receiverEmployeeId: empB1.id, givenByUserId: extraUserB.id, receivedByUserId: ownerB.id, rating: 1, tags: [], periodStart: new Date(), periodEnd: new Date() },
        });

        const svc = new EmployeeFeedbackService(db);
        const forA1 = await svc.getFeedbackForEmployee(empA1.id, bizA.id);
        expect(forA1).toHaveLength(1);
        expect(forA1[0].rating).toBe(5);
        expect(forA1[0].businessProfileId).toBe(bizA.id);

        const byA2 = await svc.getFeedbackByEmployee(empA2.id, bizA.id);
        expect(byA2).toHaveLength(1);
        expect(byA2[0].receiverEmployeeId).toBe(empA1.id);
    });

    test('2. feedback FOR a FOREIGN employee is refused — no cross-business exposure', async () => {
        const { biz: bizA, owner: ownerA } = await seedBusiness(db);
        const { biz: bizB, owner: ownerB } = await seedBusiness(db);
        const mkEmp = async (biz, user) => db.businessEmployee.create({
            data: { businessProfileId: biz.id, userId: user.id, role: 'STAFF', permissions: [] },
        });
        const empA1 = await mkEmp(bizA, ownerA);
        const empB1 = await mkEmp(bizB, ownerB);
        const giverB = await mkEmp(bizB, await db.user.create({ data: { username: `fbgiver_${++seq}`, email: `fbgiver_${seq}@test.com`, password: 'x', azamanId: `AZM-FBG-${seq}` } }));
        await db.employeeFeedback.create({
            data: { businessProfileId: bizB.id, giverEmployeeId: giverB.id, receiverEmployeeId: empB1.id, givenByUserId: giverB.userId, receivedByUserId: ownerB.id, rating: 1, tags: [], periodStart: new Date(), periodEnd: new Date() },
        });

        const svc = new EmployeeFeedbackService(db);
        // An A-scoped caller asks for B's employee: refused, never leaked.
        await expect(svc.getFeedbackForEmployee(empB1.id, bizA.id)).rejects.toThrow('Employee not found.');
        await expect(svc.getFeedbackByEmployee(empB1.id, bizA.id)).rejects.toThrow('Employee not found.');
    });

    test('3. read methods refuse to run without business scope', async () => {
        const { biz, owner } = await seedBusiness(db);
        const emp = await db.businessEmployee.create({
            data: { businessProfileId: biz.id, userId: owner.id, role: 'STAFF', permissions: [] },
        });
        const svc = new EmployeeFeedbackService(db);
        await expect(svc.getFeedbackForEmployee(emp.id)).rejects.toThrow('Business profile context is required.');
        await expect(svc.getFeedbackByEmployee(emp.id, null)).rejects.toThrow('Business profile context is required.');
    });

    test('4. a foreign receiver id with MATCHING feedback rows in the caller business is still scoped correctly', async () => {
        // Defense in depth: even if an EmployeeFeedback row pointed at a
        // receiver row that (through legacy data) belongs to another tenant,
        // the business-scoped where-clause keeps only the caller's rows.
        const { biz: bizA, owner: ownerA } = await seedBusiness(db);
        const { biz: bizB, owner: ownerB } = await seedBusiness(db);
        const empA1 = await db.businessEmployee.create({ data: { businessProfileId: bizA.id, userId: ownerA.id, role: 'STAFF', permissions: [] } });
        const empB1 = await db.businessEmployee.create({ data: { businessProfileId: bizB.id, userId: ownerB.id, role: 'STAFF', permissions: [] } });
        await db.employeeFeedback.create({
            data: { businessProfileId: bizA.id, giverEmployeeId: empA1.id, receiverEmployeeId: empB1.id, givenByUserId: ownerA.id, receivedByUserId: ownerB.id, rating: 4, tags: [], periodStart: new Date(), periodEnd: new Date() },
        });

        const svc = new EmployeeFeedbackService(db);
        // The receiver is foreign → refused outright.
        await expect(svc.getFeedbackForEmployee(empB1.id, bizA.id)).rejects.toThrow('Employee not found.');
        // The giver resolves inside A → the read works and returns only A rows.
        const rows = await svc.getFeedbackByEmployee(empA1.id, bizA.id);
        expect(rows).toHaveLength(1);
        expect(rows.every((r) => r.businessProfileId === bizA.id)).toBe(true);
    });

    test('5. create-feedback cross-business guard still holds', async () => {
        const { biz: bizA, owner: ownerA } = await seedBusiness(db);
        const { biz: bizB, owner: ownerB } = await seedBusiness(db);
        const empA1 = await db.businessEmployee.create({ data: { businessProfileId: bizA.id, userId: ownerA.id, role: 'STAFF', permissions: [] } });
        const empB1 = await db.businessEmployee.create({ data: { businessProfileId: bizB.id, userId: ownerB.id, role: 'STAFF', permissions: [] } });
        const svc = new EmployeeFeedbackService(db);
        await expect(svc.createFeedback({
            businessProfileId: bizA.id, fromEmployeeId: empA1.id, toEmployeeId: empB1.id, rating: 5,
        })).rejects.toThrow('Both employees must belong to the same business.');
    });
});
