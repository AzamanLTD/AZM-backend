// 📁 __tests__/business-os.test.js
// __tests__/business-os.test.js
// =============================================================================
// Business OS — Employee Management, Shifts, Payroll, EWA, Ledger,
// Hotel Ops, Restaurant Ops, Transit Ops, Feedback
//
// SKIPS unless TEST_DATABASE_URL is set.
// Run: TEST_DATABASE_URL=postgres://... JWT_SECRET=$(openssl rand -hex 32) npx jest business-os.test.js
//
// SCHEMA NOTES (v2 corrections):
// - BusinessProfile uses `userId` (not ownerId), `isVerified` (not verified), no `businessType` field
// - User role enum has USER, VENDOR, ADMIN — there is no BUSINESS role
// - EmployeeFeedback model uses `rating` and `tags` fields — tests reference these
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[business-os.test] TEST_DATABASE_URL not set — skipping.');

const describeIf = hasDb ? describe : describe.skip;

// ── Test fixtures ─────────────────────────────────────────────────────────────

let prisma;
let businessOwner;
let testEmployee;
let secondEmployee;
let businessProfile;
let testLocation;
let testRoom;
let testVehicle;
let testTrip;
let testProduct;

async function setupFixtures() {
    // Create a business owner user
    const hashedPw = await bcrypt.hash('testpass123', 10);
    businessOwner = await prisma.user.create({
        data: {
            username: `bos_owner_${Date.now()}`,
            email: `bos_owner_${Date.now()}@test.com`,
            password: hashedPw,
            azamanId: `AZM-BOSS-${Date.now()}`,
            role: 'VENDOR',
        },
    });

    // Create a business profile
    businessProfile = await prisma.businessProfile.create({
        data: {
            userId: businessOwner.id,
            businessName: 'Test Hotel & Transit Co',
            category: 'REAL_ESTATE',
            isVerified: true,
            bizId: `BIZ-${Date.now()}`,
        },
    });

    // Create an employee user
    const empUser = await prisma.user.create({
        data: {
            username: `bos_emp_${Date.now()}`,
            email: `bos_emp_${Date.now()}@test.com`,
            password: hashedPw,
            azamanId: `AZM-EMP-${Date.now()}`,
        },
    });

    // Create a second employee user
    const emp2User = await prisma.user.create({
        data: {
            username: `bos_emp2_${Date.now()}`,
            email: `bos_emp2_${Date.now()}@test.com`,
            password: hashedPw,
            azamanId: `AZM-EMP2-${Date.now()}`,
        },
    });

    // Create a test location
    testLocation = await prisma.businessLocation.create({
        data: {
            businessProfileId: businessProfile.id,
            label: 'Main Branch',
            address: '123 Test Street',
            city: 'Accra',
            phoneNumber: '+233500000000',
            isPrimary: true,
            latitude: 5.6037,
            longitude: -0.1870,
        },
    });

    // Create employees
    const { EmployeeService } = require('../services/businessOS/employeeService');
    const employeeService = new EmployeeService(prisma);

    testEmployee = await employeeService.addEmployee({
        businessProfileId: businessProfile.id,
        userId: empUser.id,
        role: 'HOUSEKEEPER',
        payrollType: 'HOURLY',
        hourlyRate: 15.00,
        title: 'Head Housekeeper',
        department: 'Housekeeping',
    });

    secondEmployee = await employeeService.addEmployee({
        businessProfileId: businessProfile.id,
        userId: emp2User.id,
        role: 'DRIVER',
        payrollType: 'SALARY',
        salaryAmount: 1200.00,
        title: 'Senior Driver',
        department: 'Transit',
    });

    // Create a hotel room
    testRoom = await prisma.hotelRoom.create({
        data: {
            businessProfileId: businessProfile.id,
            locationId: testLocation.id,
            roomNumber: '101',
            floor: 1,
            roomType: 'DELUXE',
            basePriceUsdc: 150.00,
            capacity: 2,
            amenities: ['WiFi', 'AC', 'Mini Bar'],
            status: 'AVAILABLE',
        },
    });

    // Create a vehicle
    testVehicle = await prisma.transitVehicle.create({
        data: {
            businessProfileId: businessProfile.id,
            licensePlate: `TEST-${Date.now().toString().slice(-4)}`,
            type: 'VAN',
            model: 'Toyota HiAce',
            capacity: 14,
            isActive: true,
            year: 2024,
        },
    });

    // Create a product for restaurant tests
    testProduct = await prisma.businessProduct.create({
        data: {
            businessProfileId: businessProfile.id,
            name: 'Jollof Rice Special',
            priceUsdc: 25.00,
            slug: `jollof-rice-special-${Date.now()}`,
            category: 'FOOD_BEVERAGE',
        },
    });
}

async function teardownFixtures() {
    if (!businessProfile) return;
    try {
    // Clean up in reverse dependency order
    await prisma.employeeFeedback.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.vehicleMaintenance.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.driverAssignment.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.kitchenOrder.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.hotelHousekeepingTask.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.hotelRoom.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.payrollRecord.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.timeOffRequest.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.shiftSwap.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.shift.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.businessLedgerEntry.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.businessEmployee.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.businessProduct.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.transitVehicle.deleteMany({ where: { businessProfileId: businessProfile.id } });
    await prisma.businessLocation.deleteMany({ where: { businessProfileId: businessProfile.id } });
    // Reservation: FK to BusinessProfile — must clean up before deleting profile
    // Also clean up any orphaned customer users created by hotel tests
    const reservations = await prisma.reservation.findMany({
        where: { businessProfileId: businessProfile.id },
        select: { customerId: true },
    });
    const customerIds = [...new Set(reservations.map(r => r.customerId))];
    await prisma.reservation.deleteMany({ where: { businessProfileId: businessProfile.id } });
    // Delete orphaned customer users (not the owner or employees)
    const protectedUserIds = [businessOwner?.id, testEmployee?.userId, secondEmployee?.userId].filter(Boolean);
    const orphanCustomerIds = customerIds.filter(id => !protectedUserIds.includes(id));
    if (orphanCustomerIds.length) {
        await prisma.user.deleteMany({ where: { id: { in: orphanCustomerIds } } });
    }
    // TransactionHistory: created by EWA service — FK to User, clean up by user IDs
    const allUserIds = [businessOwner?.id, testEmployee?.userId, secondEmployee?.userId].filter(Boolean);
    if (allUserIds.length) {
        await prisma.transactionHistory.deleteMany({ where: { userId: { in: allUserIds } } });
    }
    await prisma.businessProfile.delete({ where: { id: businessProfile.id } });
    // Users
    const empUserIds = [testEmployee?.userId, secondEmployee?.userId].filter(Boolean);
    if (empUserIds.length) await prisma.user.deleteMany({ where: { id: { in: empUserIds } } });
    await prisma.user.delete({ where: { id: businessOwner.id } });
    } catch (err) {
        console.error('[teardownFixtures] Error:', err.message);
        // Fallback: try to clean up everything with catch-all
        const bpId = businessProfile?.id;
        if (bpId) {
            await prisma.reservation.deleteMany({ where: { businessProfileId: bpId } }).catch(() => {});
            await prisma.transactionHistory.deleteMany({ where: { } }).catch(() => {});
            await prisma.businessProfile.deleteMany({ where: { id: bpId } }).catch(() => {});
        }
        const empUserIds = [testEmployee?.userId, secondEmployee?.userId].filter(Boolean);
        if (empUserIds.length) await prisma.user.deleteMany({ where: { id: { in: empUserIds } }).catch(() => {});
        if (businessOwner) await prisma.user.deleteMany({ where: { id: businessOwner.id } }).catch(() => {});
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────


if (hasDb) {
    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        await setupFixtures();
    });

    afterAll(async () => {
        await teardownFixtures();
        await prisma.$disconnect();
    });
}

describeIf('Business OS — Employee Management', () => {




    // ── Employee Service ──────────────────────────────────────────────────
    test('should list employees for the business', async () => {
        const { EmployeeService } = require('../services/businessOS/employeeService');
        const svc = new EmployeeService(prisma);

        const employees = await svc.listEmployees(businessProfile.id);
        expect(employees.length).toBeGreaterThanOrEqual(2);
        expect(employees.find(e => e.id === testEmployee.id)).toBeTruthy();
    });

    test('should get a single employee with details', async () => {
        const { EmployeeService } = require('../services/businessOS/employeeService');
        const svc = new EmployeeService(prisma);

        const emp = await svc.getEmployee(testEmployee.id, businessProfile.id);
        expect(emp.role).toBe('HOUSEKEEPER');
        expect(emp.user).toBeTruthy();
        expect(emp.businessProfileId).toBeTruthy();
    });

    test('should update employee status', async () => {
        const { EmployeeService } = require('../services/businessOS/employeeService');
        const svc = new EmployeeService(prisma);

        const updated = await svc.updateEmployee(testEmployee.id, businessProfile.id, { status: 'SUSPENDED' });
        expect(updated.status).toBe('SUSPENDED');

        // Restore
        await svc.updateEmployee(testEmployee.id, businessProfile.id, { status: 'ACTIVE' });
    });

    test('should update employee permissions', async () => {
        const { EmployeeService } = require('../services/businessOS/employeeService');
        const svc = new EmployeeService(prisma);

        const newPerms = ['manage_products', 'view_finance'];
        const updated = await svc.updateEmployee(testEmployee.id, businessProfile.id, { permissions: newPerms });
        expect(updated.permissions).toEqual(expect.arrayContaining(newPerms));
    });

    test('should not add employee from another business', async () => {
        const { EmployeeService } = require('../services/businessOS/employeeService');
        const svc = new EmployeeService(prisma);

        // Create another business
        const otherOwner = await prisma.user.create({
            data: {
                username: `other_owner_${Date.now()}`,
                email: `other_${Date.now()}@test.com`,
                password: await bcrypt.hash('pass', 10),
            },
        });
        const otherBp = await prisma.businessProfile.create({
            data: { userId: otherOwner.id, businessName: 'Other Biz', category: 'RETAIL', bizId: `BIZ-OTHER-${Date.now()}` },
        });

        await expect(
            svc.addEmployee({
                businessProfileId: otherBp.id,
                userId: testEmployee.userId,
                role: 'STAFF',
            })
        ).rejects.toThrow();

        // Cleanup
        await prisma.businessProfile.delete({ where: { id: otherBp.id } });
        await prisma.user.delete({ where: { id: otherOwner.id } });
    });
});

// ── Shift Service ─────────────────────────────────────────────────────────────
describeIf('Business OS — Shift Management', () => {
    let testShift;

    afterAll(async () => {
        if (testShift) await prisma.shift.deleteMany({ where: { id: testShift.id } });
    });

    test('should create a shift for an employee', async () => {
        const { ShiftService } = require('../services/businessOS/shiftService');
        const svc = new ShiftService(prisma);

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const startTime = new Date(tomorrow);
        startTime.setHours(8, 0, 0, 0);
        const endTime = new Date(tomorrow);
        endTime.setHours(16, 0, 0, 0);

        testShift = await svc.createShift({
            businessProfileId: businessProfile.id,
            employeeId: testEmployee.id,
            shiftDate: tomorrow,
            startTime,
            endTime,
            shiftLabel: 'Morning',
        });

        expect(testShift).toBeTruthy();
        expect(testShift.status).toBe('SCHEDULED');
        expect(testShift.shiftLabel).toBe('Morning');
    });

    test('should prevent conflicting shifts', async () => {
        const { ShiftService } = require('../services/businessOS/shiftService');
        const svc = new ShiftService(prisma);

        // Create a shift first, then try an overlapping one for the same employee
        const shiftDate = new Date('2026-12-16T00:00:00.000Z');
        const firstStart = new Date('2026-12-16T08:00:00.000Z');
        const firstEnd = new Date('2026-12-16T16:00:00.000Z');

        const firstShift = await svc.createShift({
            businessProfileId: businessProfile.id,
            employeeId: testEmployee.id,
            shiftDate,
            startTime: firstStart,
            endTime: firstEnd,
            shiftLabel: 'First Shift',
        });

        // Now try an overlapping shift (10:00-12:00 overlaps 8:00-16:00)
        const overlapStart = new Date('2026-12-16T10:00:00.000Z');
        const overlapEnd = new Date('2026-12-16T12:00:00.000Z');

        await expect(
            svc.createShift({
                businessProfileId: businessProfile.id,
                employeeId: testEmployee.id,
                shiftDate,
                startTime: overlapStart,
                endTime: overlapEnd,
            })
        ).rejects.toThrow(/conflicting/i);

        // Cleanup
        await prisma.shift.delete({ where: { id: firstShift.id } });
    });

    test('should clock in and clock out', async () => {
        const { ShiftService } = require('../services/businessOS/shiftService');
        const svc = new ShiftService(prisma);

        const clockedIn = await svc.clockIn(testShift.id);
        expect(clockedIn.status).toMatch(/CLOCKED_IN|LATE/);

        // Manually backdate clockInTime by 2 hours so workedHours > 0
        await prisma.shift.update({
            where: { id: testShift.id },
            data: { clockInTime: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        });

        const clockedOut = await svc.clockOut(testShift.id);
        expect(clockedOut.shift.status).toBe('CLOCKED_OUT');
        expect(clockedOut.workedHours).toBeGreaterThan(0);
        expect(clockedOut.accruedThisShift).toBeGreaterThan(0);
    });

    test('should get team on duty', async () => {
        const { ShiftService } = require('../services/businessOS/shiftService');
        const svc = new ShiftService(prisma);

        // Create and clock into a new shift — start time in the future so
        // clockIn sets status to CLOCKED_IN (not LATE)
        const now = new Date();
        const start = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
        const end = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 8 hours from now

        const shift = await svc.createShift({
            businessProfileId: businessProfile.id,
            employeeId: secondEmployee.id,
            shiftDate: now,
            startTime: start,
            endTime: end,
            shiftLabel: 'Current',
        });
        await svc.clockIn(shift.id);

        const onDuty = await svc.getTeamOnDuty(businessProfile.id);
        expect(onDuty.length).toBeGreaterThanOrEqual(1);
        expect(onDuty.find(s => s.id === shift.id)).toBeTruthy();

        // Cleanup
        await svc.clockOut(shift.id);
    });
});

// ── EWA Service ───────────────────────────────────────────────────────────────
describeIf('Business OS — Earned Wage Access (EWA)', () => {
    test('should check EWA eligibility (0 accrued = not eligible)', async () => {
        const { EwaService } = require('../services/businessOS/ewaService');
        const svc = new EwaService(prisma);

        // Set employee accrued wages to 0
        await prisma.businessEmployee.update({
            where: { id: testEmployee.id },
            data: { accruedWages: 0.0 },
        });

        const eligibility = await svc.checkEligibility(testEmployee.id);
        expect(eligibility.eligible).toBe(false);
        expect(eligibility.accruedWages).toBe(0);
    });

    test('should check EWA eligibility (with accrued wages)', async () => {
        const { EwaService } = require('../services/businessOS/ewaService');
        const svc = new EwaService(prisma);

        // Set employee accrued wages to 1000
        await prisma.businessEmployee.update({
            where: { id: testEmployee.id },
            data: { accruedWages: 1000.0, withdrawnEarly: 0.0 },
        });

        const eligibility = await svc.checkEligibility(testEmployee.id);
        expect(eligibility.eligible).toBe(true);
        expect(eligibility.maxWithdrawable).toBe(300); // 30% of 1000
    });

    test('should process EWA withdrawal', async () => {
        const { EwaService } = require('../services/businessOS/ewaService');
        const svc = new EwaService(prisma);

        // Ensure accrued = 1000, withdrawn = 0
        await prisma.businessEmployee.update({
            where: { id: testEmployee.id },
            data: { accruedWages: 1000.0, withdrawnEarly: 0.0 },
        });

        const result = await svc.requestWithdrawal({
            employeeId: testEmployee.id,
            amount: 100,
        });

        expect(result.success).toBe(true);
        expect(result.grossAmount).toBe(100);
        expect(result.fee).toBe(1); // 1% of 100
        expect(result.netToEmployee).toBe(99);

        // Verify employee record was updated
        const updated = await prisma.businessEmployee.findUnique({ where: { id: testEmployee.id } });
        expect(parseFloat(updated.withdrawnEarly)).toBe(100);
    });

    test('should reject EWA withdrawal exceeding 30% limit', async () => {
        const { EwaService } = require('../services/businessOS/ewaService');
        const svc = new EwaService(prisma);

        // withdrawnEarly is 100 from previous test, max = 300
        await expect(
            svc.requestWithdrawal({ employeeId: testEmployee.id, amount: 250 })
        ).rejects.toThrow(/exceeds/i); // 100 + 250 = 350 > 300
    });
});

// ── Business Ledger Service ───────────────────────────────────────────────────
describeIf('Business OS — Business Ledger', () => {
    test('should create a ledger entry', async () => {
        const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
        const svc = new BusinessLedgerService(prisma);

        const entry = await svc.createEntry({
            businessProfileId: businessProfile.id,
            type: 'INCOME',
            category: 'Room Revenue',
            description: 'Room 101 - 2 nights',
            amount: 300.00,
        });

        expect(entry).toBeTruthy();
        expect(entry.type).toBe('INCOME');
        expect(parseFloat(entry.amount)).toBe(300);
    });

    test('should get P&L summary', async () => {
        const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
        const svc = new BusinessLedgerService(prisma);

        // Add an expense
        await svc.createEntry({
            businessProfileId: businessProfile.id,
            type: 'MAINTENANCE',
            category: 'Room Repair',
            description: 'AC repair room 101',
            amount: -50.00,
        });

        const pl = await svc.getProfitLoss(businessProfile.id);
        expect(pl.totalIncome).toBeGreaterThan(0);
        expect(pl.totalExpenses).toBeGreaterThan(0);
        // EWA test creates a PAYROLL entry (-100) that's also in the ledger
        // totalIncome=300, totalExpenses=50(MAINTENANCE)+100(EWA PAYROLL)=150
        expect(pl.netProfit).toBe(300 - 150);
    });

    test('should get expense breakdown', async () => {
        const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
        const svc = new BusinessLedgerService(prisma);

        const breakdown = await svc.getExpenseBreakdown(businessProfile.id);
        expect(breakdown.totalExpenses).toBeGreaterThan(0);
        expect(breakdown.categories.find(c => c.category === 'Room Repair')).toBeTruthy();
    });
});

// ── Hotel Ops Service ─────────────────────────────────────────────────────────
describeIf('Business OS — Hotel Operations', () => {
    test('should get rooms list', async () => {
        const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
        const svc = new HotelOpsService(prisma);

        const rooms = await svc.getRooms(businessProfile.id);
        expect(rooms.length).toBeGreaterThanOrEqual(1);
        expect(rooms.find(r => r.id === testRoom.id)).toBeTruthy();
    });

    test('should update room status', async () => {
        const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
        const svc = new HotelOpsService(prisma);

        const updated = await svc.updateRoomStatus(testRoom.id, 'MAINTENANCE', 'AC repair needed', businessProfile.id);
        expect(updated.status).toBe('MAINTENANCE');

        // Restore
        await svc.updateRoomStatus(testRoom.id, 'AVAILABLE', null, businessProfile.id);
    });

    test('should generate housekeeping task and assign it', async () => {
        const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
        const svc = new HotelOpsService(prisma);

        // Create a reservation to generate task from
        const customer = await prisma.user.create({
            data: {
                username: `hguest_${Date.now()}`,
                email: `hguest_${Date.now()}@test.com`,
                password: await bcrypt.hash('pass', 10),
            },
        });

        const reservation = await prisma.reservation.create({
            data: {
                businessProfileId: businessProfile.id,
                customerId: customer.id,
                serviceItemId: testRoom.id,
                startDatetime: new Date(Date.now() - 86400000),
                endDatetime: new Date(),
                status: 'CHECKED_OUT',
                amountUsdc: 150.00,
                reservationRef: `RES-${Date.now()}`,
            },
        });

        const task = await svc.generateHousekeepingTask(reservation.id, businessProfile.id);
        expect(task).toBeTruthy();
        expect(task.status).toBe('PENDING');
        expect(task.checklistItems.length).toBeGreaterThan(0);

        // Assign to housekeeper
        const assigned = await svc.assignHousekeepingTask(task.id, testEmployee.id, businessProfile.id);
        expect(assigned.status).toBe('IN_PROGRESS');

        // Update checklist
        const checklistUpdated = await svc.updateChecklist(task.id, 0, true, businessProfile.id);
        const checklistItem = checklistUpdated.checklistItems[0];
        expect(checklistItem.done).toBe(true);

        // Complete task
        const completed = await svc.completeHousekeeping(task.id, { notes: 'All clean' }, businessProfile.id);
        expect(completed.status).toBe('COMPLETED');

        // Verify room is available again
        const room = await prisma.hotelRoom.findUnique({ where: { id: testRoom.id } });
        expect(room.status).toBe('AVAILABLE');

        // Cleanup
        await prisma.reservation.delete({ where: { id: reservation.id } });
        await prisma.user.delete({ where: { id: customer.id } });
    });
});

// ── Restaurant Ops Service ────────────────────────────────────────────────────
describeIf('Business OS — Restaurant Operations (KDS)', () => {
    test('should create a kitchen order', async () => {
        const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
        const svc = new RestaurantOpsService(prisma);

        const order = await svc.createKitchenOrder({
            businessProfileId: businessProfile.id,
            locationId: testLocation.id,
            tableNumber: '5',
            serverName: 'TestWaiter',
            items: [
                { productId: testProduct.id, quantity: 2 },
            ],
            station: 'HOT',
            specialInstructions: 'Extra spicy',
            isRush: true,
        });

        expect(order).toBeTruthy();
        expect(order.ticketNumber).toBeGreaterThanOrEqual(1);
        expect(order.isRush).toBe(true);
        expect(order.items.length).toBe(1);
        expect(order.items[0].name).toBe('Jollof Rice Special');
        expect(order.status).toBe('NEW');
    });

    test('should update order status (KDS bump bar)', async () => {
        const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
        const svc = new RestaurantOpsService(prisma);

        // Create another order
        const order = await svc.createKitchenOrder({
            businessProfileId: businessProfile.id,
            tableNumber: '6',
            items: [{ productId: testProduct.id, quantity: 1 }],
        });

        const preparing = await svc.updateOrderStatus(order.id, 'PREPARING', businessProfile.id);
        expect(preparing.status).toBe('PREPARING');
        expect(preparing.startedAt).toBeTruthy();

        const ready = await svc.updateOrderStatus(order.id, 'READY', businessProfile.id);
        expect(ready.status).toBe('READY');

        const served = await svc.updateOrderStatus(order.id, 'SERVED', businessProfile.id);
        expect(served.status).toBe('SERVED');
    });

    test('should get KDS board', async () => {
        const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
        const svc = new RestaurantOpsService(prisma);

        const board = await svc.getKDSBoard(businessProfile.id);
        expect(board).toBeTruthy();
        expect(board.totalActive).toBeGreaterThanOrEqual(0);
    });

    test('should toggle 86 status on product', async () => {
        const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
        const svc = new RestaurantOpsService(prisma);

        const updated = await svc.toggleItem86({
            businessProfileId: businessProfile.id,
            productId: testProduct.id,
            is86ed: true,
            reason: 'Ran out of rice',
        });

        expect(updated.isAvailable).toBe(false); // 86'd = not available

        // Un-86 it
        const restored = await svc.toggleItem86({
            businessProfileId: businessProfile.id,
            productId: testProduct.id,
            is86ed: false,
        });
        expect(restored.isAvailable).toBe(true); // un-86'd = available again
    });
});

// ── Transit Ops Service ───────────────────────────────────────────────────────
describeIf('Business OS — Transit Operations', () => {
    test('should create a maintenance record', async () => {
        const { TransitOpsService } = require('../services/businessOS/transitOpsService');
        const svc = new TransitOpsService(prisma);

        const record = await svc.createMaintenanceRecord({
            businessProfileId: businessProfile.id,
            vehicleId: testVehicle.id,
            type: 'SCHEDULED',
            scheduledDate: new Date(Date.now() + 7 * 86400000),
            description: 'Routine oil change',
            cost: 150.00,
            odometer: 50000,
            serviceProvider: 'Test Auto Shop',
        });

        expect(record).toBeTruthy();
        expect(record.status).toBe('SCHEDULED');
        expect(record.type).toBe('SCHEDULED');
    });

    test('should update maintenance status', async () => {
        const { TransitOpsService } = require('../services/businessOS/transitOpsService');
        const svc = new TransitOpsService(prisma);

        const records = await svc.getMaintenanceRecords(businessProfile.id, { vehicleId: testVehicle.id });
        const record = records[0];

        const inProgress = await svc.updateMaintenanceStatus(record.id, { status: 'IN_PROGRESS' }, businessProfile.id);
        expect(inProgress.status).toBe('IN_PROGRESS');

        const completed = await svc.updateMaintenanceStatus(record.id, {
            status: 'COMPLETED',
            actualCost: 175.00,
            notes: 'Also replaced filter',
        }, businessProfile.id);
        expect(completed.status).toBe('COMPLETED');
        expect(parseFloat(completed.cost)).toBe(175);
    });

    test('should get fleet overview', async () => {
        const { TransitOpsService } = require('../services/businessOS/transitOpsService');
        const svc = new TransitOpsService(prisma);

        const fleet = await svc.getFleetOverview(businessProfile.id);
        expect(fleet.length).toBeGreaterThanOrEqual(1);
        const vehicle = fleet.find(v => v.id === testVehicle.id);
        expect(vehicle).toBeTruthy();
    });
});

// ── Payroll Service ───────────────────────────────────────────────────────────
describeIf('Business OS — Payroll', () => {
    test('should process payroll for a single employee', async () => {
        const { PayrollService } = require('../services/businessOS/payrollService');
        const svc = new PayrollService(prisma);

        const now = new Date();
        const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        const result = await svc.processEmployeePayroll({
            businessProfileId: businessProfile.id,
            employeeId: secondEmployee.id, // salary employee
            period,
        });

        expect(result).toBeTruthy();
        expect(result.period).toBe(period);
        expect(parseFloat(result.grossAmount)).toBeGreaterThan(0);
        expect(result.status).toBe('PENDING');
    });

    test('should get payroll summary', async () => {
        const { PayrollService } = require('../services/businessOS/payrollService');
        const svc = new PayrollService(prisma);

        const now = new Date();
        const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        const summary = await svc.getPayrollSummary(businessProfile.id, period);
        expect(summary.period).toBe(period);
        expect(summary.totalEmployees).toBeGreaterThanOrEqual(1);
    });
});

// ── Time Off Service ──────────────────────────────────────────────────────────
describeIf('Business OS — Time Off', () => {
    test('should request time off', async () => {
        const { TimeOffService } = require('../services/businessOS/timeOffService');
        const svc = new TimeOffService(prisma);

        const request = await svc.requestTimeOff({
            businessProfileId: businessProfile.id,
            employeeId: testEmployee.id,
            type: 'SICK',
            startDate: new Date(Date.now() + 3 * 86400000),
            endDate: new Date(Date.now() + 4 * 86400000),
            reason: 'Feeling unwell',
        });

        expect(request).toBeTruthy();
        expect(request.status).toBe('PENDING');
        expect(request.type).toBe('SICK');
    });

    test('should approve time off request', async () => {
        const { TimeOffService } = require('../services/businessOS/timeOffService');
        const svc = new TimeOffService(prisma);

        const requests = await svc.getTimeOffRequests(businessProfile.id, { status: 'PENDING' });
        const request = requests[0];

        const approved = await svc.approveTimeOff(request.id, businessOwner.id, 'Approved. Get well soon.');
        expect(approved.status).toBe('APPROVED');
        expect(approved.managerNote).toBe('Approved. Get well soon.');
    });
});

// ── Employee Feedback Service ─────────────────────────────────────────────────
describeIf('Business OS — Employee Feedback', () => {
    test('should create feedback and update employee rating', async () => {
        const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');
        const svc = new EmployeeFeedbackService(prisma);

        const feedback = await svc.createFeedback({
            businessProfileId: businessProfile.id,
            fromEmployeeId: secondEmployee.id,
            toEmployeeId: testEmployee.id,
            rating: 5,
            tags: ['HARD_WORKING', 'RELIABLE'],
            comment: 'Excellent housekeeping work today',
        });

        expect(feedback).toBeTruthy();
        expect(feedback.rating).toBe(5);
        expect(feedback.tags).toContain('HARD_WORKING');

        // Verify employee's rating was updated
        const employee = await prisma.businessEmployee.findUnique({ where: { id: testEmployee.id } });
        expect(parseFloat(employee.rating)).toBe(5.0);
        expect(employee.ratingCount).toBeGreaterThanOrEqual(1);
    });

    test('should not allow self-feedback', async () => {
        const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');
        const svc = new EmployeeFeedbackService(prisma);

        await expect(
            svc.createFeedback({
                businessProfileId: businessProfile.id,
                fromEmployeeId: testEmployee.id,
                toEmployeeId: testEmployee.id,
                rating: 5,
            })
        ).rejects.toThrow(/yourself/i);
    });

    test('should get business feedback summary', async () => {
        const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');
        const svc = new EmployeeFeedbackService(prisma);

        const summary = await svc.getBusinessFeedbackSummary(businessProfile.id);
        expect(summary.totalFeedback).toBeGreaterThanOrEqual(1);
        expect(summary.avgRating).toBeGreaterThan(0);
    });
});
