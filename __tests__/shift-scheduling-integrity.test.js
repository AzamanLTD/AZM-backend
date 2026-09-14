// __tests__/shift-scheduling-integrity.test.js
// =============================================================================
// P0 — Business OS shift scheduling/state integrity (real PostgreSQL).
//
// Proofs (run when TEST_DATABASE_URL is set — CI provides it):
//   1. concurrent createShift (same employee, overlapping interval) -> one winner
//   2. concurrent createShift (non-overlapping) -> both succeed
//   3. concurrent time-changing updateShift cannot commit an overlapping pair
//   4. update-to-overlap is rejected and changes nothing
//   5. delete vs clock-in race -> consistent final state, never a deleted
//      active shift
//   6. business isolation: another business's scope cannot mutate the shift
//   7. generic status mutation via updateShift remains rejected
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[shift-scheduling-integrity] TEST_DATABASE_URL not set — skipping.');

const { ShiftService } = require('../services/businessOS/shiftService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');
const { seedUser, seedBusiness } = require('./helpers/factories');

describeOrSkip('Shift scheduling/state integrity (real PostgreSQL)', () => {
    let prisma, svc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        svc    = new ShiftService(prisma);
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "Shift", "BusinessEmployee", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedBizWithEmployee() {
        const { owner, biz } = await seedBusiness(prisma);
        const empUser = await seedUser(prisma);
        const employee = await prisma.businessEmployee.create({
            data: {
                businessProfileId: biz.id,
                userId: empUser.id,
                role: 'HOUSEKEEPER',
                status: 'ACTIVE',
                title: 'Shift Test Staff',
                permissions: [],
            },
        });
        return { owner, biz, employee, empUser };
    }

    // Runs fn with the business-owner request context (mutation authority).
    const ownerCtx = (bizId, fn) =>
        runWithBusinessRequestContext({
            userId: 1, businessProfileId: bizId, isBusinessOwner: true, isAdmin: false,
        }, fn);

    const mkShiftArgs = (biz, employee, startISO, endISO, extra = {}) => ({
        businessProfileId: biz.id,
        employeeId: employee.id,
        shiftDate: new Date(startISO),
        startTime: new Date(startISO),
        endTime: new Date(endISO),
        breakMinutes: 30,
        ...extra,
    });

    test('1. concurrent createShift for the same employee + overlapping interval: exactly one succeeds', async () => {
        const { biz, employee } = await seedBizWithEmployee();

        const call = () => ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T08:00:00.000Z', '2026-10-01T16:00:00.000Z')))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([call(), call()]);

        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok)[0].e.message)
            .toBe('Employee already has a conflicting shift at this time.');

        const shifts = await prisma.shift.findMany({ where: { employeeId: employee.id } });
        expect(shifts).toHaveLength(1);
        expect(shifts[0].status).toBe('SCHEDULED');
    });

    test('2. concurrent createShift for non-overlapping intervals: both succeed', async () => {
        const { biz, employee } = await seedBizWithEmployee();

        const call = (start, end) => ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, start, end)))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([
            call('2026-10-01T08:00:00.000Z', '2026-10-01T12:00:00.000Z'),
            call('2026-10-01T13:00:00.000Z', '2026-10-01T17:00:00.000Z'),
        ]);

        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(await prisma.shift.count({ where: { employeeId: employee.id } })).toBe(2);
    });

    test('3. concurrent time-changing updateShift attempts cannot commit an overlapping schedule', async () => {
        const { biz, employee } = await seedBizWithEmployee();

        const shiftA = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T08:00:00.000Z', '2026-10-01T12:00:00.000Z')));
        const shiftB = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T16:00:00.000Z', '2026-10-01T20:00:00.000Z')));

        // Each update is VALID against the committed schedule but the two
        // RESULTS would overlap each other — without serialization both
        // could commit an invalid schedule (the race the lock closes).
        const growA = () => ownerCtx(biz.id, () =>
            svc.updateShift(shiftA.id, { endTime: '2026-10-01T15:30:00.000Z' }))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));
        const growB = () => ownerCtx(biz.id, () =>
            svc.updateShift(shiftB.id, { startTime: '2026-10-01T15:00:00.000Z' }))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const outcomes = await Promise.all([growA(), growB()]);

        // The advisory lock serializes them: the first commits, the second
        // sees the now-committed overlap and is rejected.
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok)[0].e.message)
            .toBe('Employee already has a conflicting shift at this time.');

        const [a, b] = await Promise.all([
            prisma.shift.findUnique({ where: { id: shiftA.id } }),
            prisma.shift.findUnique({ where: { id: shiftB.id } }),
        ]);
        // Invariant: the committed schedule has no overlapping active pair.
        expect(new Date(a.endTime) <= new Date(b.startTime) ||
                new Date(b.endTime) <= new Date(a.startTime)).toBe(true);
    });

    test('4. update-to-overlap is rejected; both shifts remain unchanged', async () => {
        const { biz, employee } = await seedBizWithEmployee();

        const shiftA = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T08:00:00.000Z', '2026-10-01T12:00:00.000Z')));
        const shiftB = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T16:00:00.000Z', '2026-10-01T20:00:00.000Z')));

        await expect(ownerCtx(biz.id, () =>
            svc.updateShift(shiftA.id, { endTime: '2026-10-01T18:00:00.000Z' })))
            .rejects.toThrow('Employee already has a conflicting shift at this time.');

        const [a, b] = await Promise.all([
            prisma.shift.findUnique({ where: { id: shiftA.id } }),
            prisma.shift.findUnique({ where: { id: shiftB.id } }),
        ]);
        expect(new Date(a.endTime).toISOString()).toBe('2026-10-01T12:00:00.000Z');
        expect(new Date(b.startTime).toISOString()).toBe('2026-10-01T16:00:00.000Z');

        // Non-time updates carry no overlap work and still succeed.
        const relabeled = await ownerCtx(biz.id, () =>
            svc.updateShift(shiftA.id, { shiftLabel: 'Quiet shift' }));
        expect(relabeled.shiftLabel).toBe('Quiet shift');
    });

    test('5. delete vs clock-in race: final state is consistent, never a deleted active shift', async () => {
        const { biz, employee } = await seedBizWithEmployee();
        const shift = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee,
                new Date(Date.now() + 3600_000).toISOString(),
                new Date(Date.now() + 7200_000).toISOString())));

        const del = () => ownerCtx(biz.id, () => svc.deleteShift(shift.id))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));
        const clock = () => ownerCtx(biz.id, () => svc.clockIn(shift.id))
            .then(() => ({ ok: true })).catch((e) => ({ ok: false, e }));

        const [delOutcome, clockOutcome] = await Promise.all([del(), clock()]);

        // Exactly one of the two may win — never both, never neither.
        expect(delOutcome.ok).not.toBe(clockOutcome.ok);

        const row = await prisma.shift.findUnique({ where: { id: shift.id } });
        if (delOutcome.ok) {
            expect(row).toBeNull();               // delete won: shift is gone
            // clockIn's pre-read may have beaten the committed delete, but its
            // guarded SCHEDULED-only transition then correctly refuses.
            expect(['Shift not found.', 'Shift was already resolved or clocked in.'])
                .toContain(clockOutcome.e.message);
        } else {
            expect(row).not.toBeNull();           // clock-in won: shift is active
            expect(['CLOCKED_IN', 'LATE']).toContain(row.status);
            expect(delOutcome.e.message).toBe('Cannot delete an active shift.');
        }
    });

    test('6. business isolation: another business scope cannot mutate the shift', async () => {
        const { biz, employee } = await seedBizWithEmployee();
        const other = await seedBizWithEmployee();
        const shift = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T08:00:00.000Z', '2026-10-01T16:00:00.000Z',
                { shiftLabel: 'Morning' })));

        // Same shift id, DIFFERENT business context.
        await expect(ownerCtx(other.biz.id, () =>
            svc.updateShift(shift.id, { shiftLabel: 'tampered' })))
            .rejects.toThrow('Shift not found.');
        await expect(ownerCtx(other.biz.id, () => svc.deleteShift(shift.id)))
            .rejects.toThrow('Shift not found.');

        const row = await prisma.shift.findUnique({ where: { id: shift.id } });
        expect(row).not.toBeNull();
        expect(row.shiftLabel).toBe('Morning');   // untouched
    });

    test('7. generic status mutation via updateShift remains rejected', async () => {
        const { biz, employee } = await seedBizWithEmployee();
        const shift = await ownerCtx(biz.id, () =>
            svc.createShift(mkShiftArgs(biz, employee, '2026-10-01T08:00:00.000Z', '2026-10-01T16:00:00.000Z')));

        await expect(ownerCtx(biz.id, () =>
            svc.updateShift(shift.id, { status: 'CLOCKED_OUT' })))
            .rejects.toThrow('Shift status must be changed through the clock-in, clock-out, or no-show actions.');

        const row = await prisma.shift.findUnique({ where: { id: shift.id } });
        expect(row.status).toBe('SCHEDULED');
    });
});
