// 📁 routes/businessOSRoutes.js
// routes/businessOSRoutes.js
// =============================================================================
// Business OS Routes — Employee management, shifts, payroll, EWA, ledger,
// hotel ops, restaurant ops, transit ops, and feedback.
//
// All routes are mounted under /api/business-os/ and require business auth.
// =============================================================================

const express = require('express');
const router = express.Router();

// Service classes — instantiated per-request with the shared Prisma client
const { EmployeeService } = require('../services/businessOS/employeeService');
const { ShiftService } = require('../services/businessOS/shiftService');
const { PayrollService } = require('../services/businessOS/payrollService');
const { EwaService } = require('../services/businessOS/ewaService');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
const { TimeOffService } = require('../services/businessOS/timeOffService');
const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
const { TransitOpsService } = require('../services/businessOS/transitOpsService');
const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');

// Auth middleware — the existing backend exports { protect, adminOnly }
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

// Helper: get the shared PrismaClient from the Express app (adapter-backed)
// The existing server.js creates ONE PrismaClient with PrismaPg adapter and
// sets it via app.set('prisma', prisma). Do NOT create a new PrismaClient here.
function getPrisma(req) {
    return req.app.get('prisma');
}

// Helper: get business profile ID from auth user
// Checks req.businessProfileId first — this is set by adminBusinessScope
// middleware when an admin impersonates a business via x-admin-business-id header.
async function getBusinessProfileId(req) {
    if (!req.user?.id) throw new Error('Authentication required.');
    // Admin impersonation: if adminBusinessScope set req.businessProfileId, use it
    if (req.businessProfileId) return req.businessProfileId;
    // Normal flow: look up the user's own business profile
    const prisma = getPrisma(req);
    const bp = await prisma.businessProfile.findUnique({
        where: { userId: req.user.id },
    });
    if (!bp) throw new Error('No business profile found for this user.');
    return bp.id;
}

// Helper: instantiate all services with the request-scoped Prisma client
function getServices(req) {
    const prisma = getPrisma(req);
    return {
        employeeService: new EmployeeService(prisma),
        shiftService: new ShiftService(prisma),
        payrollService: new PayrollService(prisma),
        ewaService: new EwaService(prisma),
        ledgerService: new BusinessLedgerService(prisma),
        timeOffService: new TimeOffService(prisma),
        hotelOpsService: new HotelOpsService(prisma),
        restaurantOpsService: new RestaurantOpsService(prisma),
        transitOpsService: new TransitOpsService(prisma),
        feedbackService: new EmployeeFeedbackService(prisma),
    };
}

// Helper: async error wrapper — uses existing backend response envelope
function wrap(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            console.error('[BusinessOS]', err.message);
            res.status(400).json({ success: false, message: err.message });
        }
    };
}

// Apply auth + ban guard middleware to all routes
router.use(protect, protectActive);

// ═══════════════════════════════════════════════════════════════════════════
// EMPLOYEE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/business-os/employees
router.get('/employees', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { role, status, search } = req.query;
    const employees = await svc.employeeService.listEmployees(bpId, { role, status });
    res.json({ success: true, employees });
}));

// POST /api/business-os/employees
router.post('/employees', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const employee = await svc.employeeService.addEmployee({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, employee });
}));

// GET /api/business-os/employees/:id
router.get('/employees/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const employee = await svc.employeeService.getEmployee(req.params.id, bpId);
    res.json({ success: true, employee });
}));

// PATCH /api/business-os/employees/:id
router.patch('/employees/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const employee = await svc.employeeService.updateEmployee(req.params.id, bpId, req.body);
    res.json({ success: true, employee });
}));

// DELETE /api/business-os/employees/:id
router.delete('/employees/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    await svc.employeeService.removeEmployee(req.params.id, bpId);
    res.status(200).json({ success: true });
}));

// POST /api/business-os/employees/:id/permissions
router.post('/employees/:id/permissions', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const employee = await svc.employeeService.updatePermissions(req.params.id, bpId, req.body.permissions);
    res.json({ success: true, employee });
}));

// ═══════════════════════════════════════════════════════════════════════════
// SHIFTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/business-os/shifts
router.get('/shifts', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const shifts = await svc.shiftService.getShifts(bpId, req.query);
    res.json({ success: true, shifts });
}));

// POST /api/business-os/shifts
router.post('/shifts', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const shift = await svc.shiftService.createShift({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, shift });
}));

// POST /api/business-os/shifts/rotation
router.post('/shifts/rotation', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const shifts = await svc.shiftService.createShiftRotation({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, shifts });
}));

// PATCH /api/business-os/shifts/:id
router.patch('/shifts/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const shift = await svc.shiftService.updateShift(req.params.id, req.body);
    res.json({ success: true, shift });
}));

// DELETE /api/business-os/shifts/:id
router.delete('/shifts/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    await svc.shiftService.deleteShift(req.params.id);
    res.status(200).json({ success: true });
}));

// POST /api/business-os/shifts/:id/clock-in
router.post('/shifts/:id/clock-in', wrap(async (req, res) => {
    const svc = getServices(req);
    const result = await svc.shiftService.clockIn(req.params.id);
    res.json({ success: true, result });
}));

// POST /api/business-os/shifts/:id/clock-out
router.post('/shifts/:id/clock-out', wrap(async (req, res) => {
    const svc = getServices(req);
    const result = await svc.shiftService.clockOut(req.params.id);
    res.json({ success: true, result });
}));

// POST /api/business-os/shifts/:id/no-show
router.post('/shifts/:id/no-show', wrap(async (req, res) => {
    const svc = getServices(req);
    const result = await svc.shiftService.markNoShow(req.params.id);
    res.json({ success: true, result });
}));

// GET /api/business-os/shifts/team/on-duty
router.get('/shifts/team/on-duty', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const team = await svc.shiftService.getTeamOnDuty(bpId);
    res.json({ success: true, team });
}));

// GET /api/business-os/shifts/team/upcoming
router.get('/shifts/team/upcoming', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const team = await svc.shiftService.getUpcomingTeam(bpId);
    res.json({ success: true, team });
}));

// GET /api/business-os/shifts/my-schedule
router.get('/shifts/my-schedule', wrap(async (req, res) => {
    const svc = getServices(req);
    const shifts = await svc.shiftService.getUserSchedule(req.user.id, req.query);
    res.json({ success: true, shifts });
}));

// ── Shift Swaps ──
router.post('/shifts/swaps', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const swap = await svc.shiftService.requestShiftSwap({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, swap });
}));

router.post('/shifts/swaps/:id/claim', wrap(async (req, res) => {
    const svc = getServices(req);
    const swap = await svc.shiftService.claimShiftSwap({ swapId: req.params.id, ...req.body });
    res.json({ success: true, swap });
}));

router.post('/shifts/swaps/:id/approve', wrap(async (req, res) => {
    const svc = getServices(req);
    const swap = await svc.shiftService.approveShiftSwap(req.params.id, req.body.managerNote);
    res.json({ success: true, swap });
}));

router.post('/shifts/swaps/:id/reject', wrap(async (req, res) => {
    const svc = getServices(req);
    const swap = await svc.shiftService.rejectShiftSwap(req.params.id, req.body.managerNote);
    res.json({ success: true, swap });
}));

router.get('/shifts/swaps', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const swaps = await svc.shiftService.getShiftSwaps(bpId, req.query);
    res.json({ success: true, swaps });
}));

// ═══════════════════════════════════════════════════════════════════════════
// TIME OFF
// ═══════════════════════════════════════════════════════════════════════════

router.get('/time-off', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const requests = await svc.timeOffService.getTimeOffRequests(bpId, req.query);
    res.json({ success: true, requests });
}));

router.post('/time-off', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const request = await svc.timeOffService.requestTimeOff({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, request });
}));

router.post('/time-off/:id/approve', wrap(async (req, res) => {
    const svc = getServices(req);
    const request = await svc.timeOffService.approveTimeOff(req.params.id, req.user.id, req.body.managerNote);
    res.json({ success: true, request });
}));

router.post('/time-off/:id/reject', wrap(async (req, res) => {
    const svc = getServices(req);
    const request = await svc.timeOffService.rejectTimeOff(req.params.id, req.user.id, req.body.managerNote);
    res.json({ success: true, request });
}));

router.get('/time-off/my-requests', wrap(async (req, res) => {
    const svc = getServices(req);
    const requests = await svc.timeOffService.getUserTimeOffRequests(req.user.id);
    res.json({ success: true, requests });
}));

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL
// ═══════════════════════════════════════════════════════════════════════════

router.get('/payroll', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const records = await svc.payrollService.getPayrollRecords(bpId, req.query);
    res.json({ success: true, records });
}));

router.post('/payroll/process', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { period, employeeId } = req.body;
    if (employeeId) {
        const result = await svc.payrollService.processEmployeePayroll({ businessProfileId: bpId, employeeId, period });
        res.json({ success: true, result });
    } else {
        const results = await svc.payrollService.processAllPayroll(bpId, period);
        res.json({ success: true, results });
    }
}));

router.post('/payroll/disburse', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { payrollId, period } = req.body;
    if (payrollId) {
        const result = await svc.payrollService.disbursePayroll(payrollId);
        res.json({ success: true, result });
    } else if (period) {
        const results = await svc.payrollService.disburseAllPayroll(bpId, period);
        res.json({ success: true, results });
    } else {
        res.status(400).json({ success: false, message: 'Either payrollId or period is required.' });
    }
}));

router.get('/payroll/summary', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const summary = await svc.payrollService.getPayrollSummary(bpId, req.query.period);
    res.json({ success: true, summary });
}));

// ═══════════════════════════════════════════════════════════════════════════
// EWA (Earned Wage Access)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/ewa/eligibility/:employeeId', wrap(async (req, res) => {
    const svc = getServices(req);
    const eligibility = await svc.ewaService.checkEligibility(req.params.employeeId);
    res.json({ success: true, eligibility });
}));

router.post('/ewa/withdraw', wrap(async (req, res) => {
    const svc = getServices(req);
    const result = await svc.ewaService.requestWithdrawal(req.body);
    res.json({ success: true, result });
}));

router.get('/ewa/history/:employeeId', wrap(async (req, res) => {
    const svc = getServices(req);
    const history = await svc.ewaService.getEwaHistory(req.params.employeeId);
    res.json({ success: true, history });
}));

router.get('/ewa/summary', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const summary = await svc.ewaService.getEwaSummary(bpId);
    res.json({ success: true, summary });
}));

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS LEDGER
// ═══════════════════════════════════════════════════════════════════════════

router.get('/ledger', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const result = await svc.ledgerService.getEntries(bpId, req.query);
    res.json({ success: true, result });
}));

router.post('/ledger', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const entry = await svc.ledgerService.createEntry({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, entry });
}));

router.delete('/ledger/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    await svc.ledgerService.deleteEntry(req.params.id, bpId);
    res.status(200).json({ success: true });
}));

router.get('/ledger/profit-loss', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const pl = await svc.ledgerService.getProfitLoss(bpId, req.query);
    res.json({ success: true, pl });
}));

router.get('/ledger/cash-flow', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const cf = await svc.ledgerService.getCashFlow(bpId, req.query);
    res.json({ success: true, cf });
}));

router.get('/ledger/expenses', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const expenses = await svc.ledgerService.getExpenseBreakdown(bpId, req.query);
    res.json({ success: true, expenses });
}));

router.get('/ledger/dashboard', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const stats = await svc.ledgerService.getDashboardStats(bpId);
    res.json({ success: true, stats });
}));

// ═══════════════════════════════════════════════════════════════════════════
// HOTEL OPS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/hotel/rooms', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const rooms = await svc.hotelOpsService.getRooms(bpId, req.query);
    res.json({ success: true, rooms });
}));

router.post('/hotel/rooms', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const room = await svc.hotelOpsService.createRoom({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, room });
}));

router.patch('/hotel/rooms/:id/status', wrap(async (req, res) => {
    const svc = getServices(req);
    const room = await svc.hotelOpsService.updateRoomStatus(req.params.id, req.body.status, req.body.notes);
    res.json({ success: true, room });
}));

router.get('/hotel/room-rack', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const rack = await svc.hotelOpsService.getRoomRack(bpId, date);
    res.json({ success: true, rack });
}));

// Housekeeping
router.get('/hotel/housekeeping', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const board = await svc.hotelOpsService.getHousekeepingBoard(bpId);
    res.json({ success: true, board });
}));

router.post('/hotel/housekeeping/:id/assign', wrap(async (req, res) => {
    const svc = getServices(req);
    const task = await svc.hotelOpsService.assignHousekeepingTask(req.params.id, req.body.employeeId);
    res.json({ success: true, task });
}));

router.patch('/hotel/housekeeping/:id/checklist', wrap(async (req, res) => {
    const svc = getServices(req);
    const task = await svc.hotelOpsService.updateChecklist(req.params.id, req.body.itemIndex, req.body.done);
    res.json({ success: true, task });
}));

router.post('/hotel/housekeeping/:id/complete', wrap(async (req, res) => {
    const svc = getServices(req);
    const task = await svc.hotelOpsService.completeHousekeeping(req.params.id, req.body);
    res.json({ success: true, task });
}));

router.post('/hotel/housekeeping/:id/inspect', wrap(async (req, res) => {
    const svc = getServices(req);
    const task = await svc.hotelOpsService.inspectHousekeeping(req.params.id, req.body);
    res.json({ success: true, task });
}));

// Front Desk
router.get('/hotel/front-desk', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const overview = await svc.hotelOpsService.getFrontDeskOverview(bpId, req.query.date);
    res.json({ success: true, overview });
}));

// ═══════════════════════════════════════════════════════════════════════════
// RESTAURANT OPS
// ═══════════════════════════════════════════════════════════════════════════

// KDS
router.get('/restaurant/kds', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const board = await svc.restaurantOpsService.getKDSBoard(bpId, req.query);
    res.json({ success: true, board });
}));

router.post('/restaurant/kds', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const order = await svc.restaurantOpsService.createKitchenOrder({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, order });
}));

router.patch('/restaurant/kds/:id/status', wrap(async (req, res) => {
    const svc = getServices(req);
    const order = await svc.restaurantOpsService.updateOrderStatus(req.params.id, req.body.status);
    res.json({ success: true, order });
}));

// Bump (advance to next status): NEW → PREPARING → READY → SERVED
router.post('/restaurant/kds/:id/bump', wrap(async (req, res) => {
    const svc = getServices(req);
    const FLOW = ['NEW', 'PREPARING', 'READY', 'SERVED'];
    const order = await svc.prisma.kitchenOrder.findUnique({ where: { id: req.params.id } });
    if (!order) throw new Error('Kitchen order not found.');
    const currentIdx = FLOW.indexOf(order.status);
    const nextStatus = currentIdx >= 0 && currentIdx < FLOW.length - 1 ? FLOW[currentIdx + 1] : 'SERVED';
    const updated = await svc.restaurantOpsService.updateOrderStatus(req.params.id, nextStatus);
    res.json({ success: true, order: updated });
}));

router.patch('/restaurant/kds/:id/item-status', wrap(async (req, res) => {
    const svc = getServices(req);
    const order = await svc.restaurantOpsService.updateItemStatus(req.params.id, req.body.itemIndex, req.body.status);
    res.json({ success: true, order });
}));

router.post('/restaurant/kds/:id/assign-chef', wrap(async (req, res) => {
    const svc = getServices(req);
    const order = await svc.restaurantOpsService.assignChef(req.params.id, req.body.employeeId);
    res.json({ success: true, order });
}));

router.get('/restaurant/kds/stats', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const stats = await svc.restaurantOpsService.getKDSStats(bpId, req.query);
    res.json({ success: true, stats });
}));

// Tables
router.get('/restaurant/tables', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const tables = await svc.restaurantOpsService.getTableFloor(bpId, req.query);
    res.json({ success: true, tables });
}));

// Menu Engineering (86'd items)
router.get('/restaurant/86ed-items', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const items = await svc.restaurantOpsService.get86edItems(bpId);
    res.json({ success: true, items });
}));

router.post('/restaurant/toggle-86', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const product = await svc.restaurantOpsService.toggleItem86({ ...req.body, businessProfileId: bpId });
    res.json({ success: true, product });
}));

// ═══════════════════════════════════════════════════════════════════════════
// TRANSIT OPS
// ═══════════════════════════════════════════════════════════════════════════

// Driver Rostering
router.get('/transit/drivers', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const roster = await svc.transitOpsService.getDriverRoster(bpId, req.query);
    res.json({ success: true, roster });
}));

router.post('/transit/drivers/assign', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const assignment = await svc.transitOpsService.assignDriver({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, assignment });
}));

router.patch('/transit/drivers/:id/status', wrap(async (req, res) => {
    const svc = getServices(req);
    const assignment = await svc.transitOpsService.updateAssignmentStatus(req.params.id, req.body.status);
    res.json({ success: true, assignment });
}));

router.get('/transit/drivers/my-schedule', wrap(async (req, res) => {
    const svc = getServices(req);
    const schedule = await svc.transitOpsService.getDriverSchedule(req.user.id, req.query);
    res.json({ success: true, schedule });
}));

// Fleet Management
router.get('/transit/fleet', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const fleet = await svc.transitOpsService.getFleetOverview(bpId);
    res.json({ success: true, fleet });
}));

router.post('/transit/fleet', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const vehicle = await svc.transitOpsService.createVehicle({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, vehicle });
}));

router.get('/transit/fleet/maintenance', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const records = await svc.transitOpsService.getMaintenanceRecords(bpId, req.query);
    res.json({ success: true, records });
}));

router.post('/transit/fleet/maintenance', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const record = await svc.transitOpsService.createMaintenanceRecord({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, record });
}));

router.patch('/transit/fleet/maintenance/:id', wrap(async (req, res) => {
    const svc = getServices(req);
    const record = await svc.transitOpsService.updateMaintenanceStatus(req.params.id, req.body);
    res.json({ success: true, record });
}));

// Manifests
router.get('/transit/manifests/:tripId', wrap(async (req, res) => {
    const svc = getServices(req);
    const manifest = await svc.transitOpsService.getTripManifest(req.params.tripId);
    res.json({ success: true, manifest });
}));

router.get('/transit/manifests', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const manifests = await svc.transitOpsService.getDailyManifests(bpId, date);
    res.json({ success: true, manifests });
}));

router.post('/transit/manifests/board', wrap(async (req, res) => {
    const svc = getServices(req);
    const result = await svc.transitOpsService.boardPassenger(req.body.reservationId);
    res.json({ success: true, result });
}));

// ═══════════════════════════════════════════════════════════════════════════
// EMPLOYEE FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════

router.get('/feedback', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const summary = await svc.feedbackService.getBusinessFeedbackSummary(bpId);
    res.json({ success: true, summary });
}));

router.post('/feedback', wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const feedback = await svc.feedbackService.createFeedback({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, feedback });
}));

router.get('/feedback/for/:employeeId', wrap(async (req, res) => {
    const svc = getServices(req);
    const feedback = await svc.feedbackService.getFeedbackForEmployee(req.params.employeeId);
    res.json({ success: true, feedback });
}));

router.get('/feedback/by/:employeeId', wrap(async (req, res) => {
    const svc = getServices(req);
    const feedback = await svc.feedbackService.getFeedbackByEmployee(req.params.employeeId);
    res.json({ success: true, feedback });
}));


// ═══════════════════════════════════════════════════════════════════════════════
// MOOLRE COMPETITION — Transit Cargo & Restaurant Inventory
// ═══════════════════════════════════════════════════════════════════════════════

// ── TRANSIT: CARGO MANAGEMENT ─────────────────────────────────────────────────

// GET /api/business-os/transit/cargo — list cargo for a trip
router.get('/transit/cargo', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { tripId, status } = req.query;
    const where = { businessProfileId: bpId };
    if (tripId) where.transitTripId = tripId;
    if (status) where.status = status;
    const parcels = await prisma.cargoParcel.findMany({
        where,
        include: {
            transitTrip: { select: { origin: true, destination: true, departureAt: true, routeName: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, parcels });
}));

// POST /api/business-os/transit/cargo — create cargo parcel
router.post('/transit/cargo', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const {
        transitTripId, senderName, senderPhone, receiverName, receiverPhone,
        receiverAddress, description, weightKg, priceUsdc, fragile, notes,
    } = req.body;
    const trip = await prisma.transitTrip.findFirst({
        where: { id: transitTripId, businessProfileId: bpId },
    });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    const parcel = await prisma.cargoParcel.create({
        data: {
            transitTripId, businessProfileId: bpId,
            senderName, senderPhone, receiverName, receiverPhone,
            receiverAddress, description,
            weightKg: parseFloat(weightKg), priceUsdc: parseFloat(priceUsdc),
            fragile: fragile === true || fragile === 'true', notes,
        },
    });
    res.json({ success: true, parcel });
}));

// PATCH /api/business-os/transit/cargo/:id/status — update cargo status
router.patch('/transit/cargo/:id/status', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { status } = req.body;
    const validStatuses = ['PENDING', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'LOST'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const updateData = { status };
    if (status === 'LOADED') updateData.loadedAt = new Date();
    if (status === 'DELIVERED') updateData.deliveredAt = new Date();
    const result = await prisma.cargoParcel.updateMany({
        where: { id: req.params.id, businessProfileId: bpId },
        data: updateData,
    });
    if (!result.count) return res.status(404).json({ success: false, message: 'Parcel not found' });
    res.json({ success: true });
}));

// DELETE /api/business-os/transit/cargo/:id — remove cargo parcel
router.delete('/transit/cargo/:id', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const result = await prisma.cargoParcel.deleteMany({
        where: { id: req.params.id, businessProfileId: bpId, status: 'PENDING' },
    });
    if (!result.count) return res.status(404).json({ success: false, message: 'Parcel not found or already loaded' });
    res.json({ success: true });
}));

// POST /api/business-os/transit/irops/reassign — vehicle breakdown reassignment
router.post('/transit/irops/reassign', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { sourceTripId, targetVehicleId, reason } = req.body;
    if (!sourceTripId || !targetVehicleId) {
        return res.status(400).json({ success: false, message: 'sourceTripId and targetVehicleId are required' });
    }
    const sourceTrip = await prisma.transitTrip.findFirst({
        where: { id: sourceTripId, businessProfileId: bpId },
        include: {
            bookings: { where: { status: { in: ['CONFIRMED'] } } },
            cargoParcels: { where: { status: { in: ['PENDING', 'LOADED'] } } },
        },
    });
    if (!sourceTrip) return res.status(404).json({ success: false, message: 'Source trip not found' });
    const targetVehicle = await prisma.transitVehicle.findFirst({
        where: { id: targetVehicleId, businessProfileId: bpId, isActive: true },
    });
    if (!targetVehicle) return res.status(404).json({ success: false, message: 'Target vehicle not found or not active' });

    const result = await prisma.$transaction(async (tx) => {
        const newTrip = await tx.transitTrip.create({
            data: {
                businessProfileId: bpId, vehicleId: targetVehicleId,
                routeName: `${sourceTrip.routeName} [REPLACEMENT]`,
                origin: sourceTrip.origin, destination: sourceTrip.destination,
                departureAt: new Date(), fareUsdc: sourceTrip.fareUsdc,
                availableSeats: targetVehicle.capacity ?? sourceTrip.availableSeats,
                status: 'ACTIVE',
            },
        });
        await tx.transitTrip.update({
            where: { id: sourceTripId },
            data: { status: 'CANCELLED' },
        });
        let passengerCount = 0;
        if (sourceTrip.bookings.length > 0) {
            const moved = await tx.transitBooking.updateMany({
                where: { tripId: sourceTripId, status: { in: ['CONFIRMED'] } },
                data: { tripId: newTrip.id },
            });
            passengerCount = moved.count;
        }
        let cargoCount = 0;
        if (sourceTrip.cargoParcels.length > 0) {
            const movedCargo = await tx.cargoParcel.updateMany({
                where: { transitTripId: sourceTripId, status: { in: ['PENDING', 'LOADED'] } },
                data: { transitTripId: newTrip.id },
            });
            cargoCount = movedCargo.count;
        }
        return { newTrip, passengerCount, cargoCount };
    });

    res.json({
        success: true,
        message: `Reassigned ${result.passengerCount} passengers and ${result.cargoCount} cargo items to replacement vehicle`,
        newTripId: result.newTrip.id,
        passengerCount: result.passengerCount, cargoCount: result.cargoCount,
    });
}));

// ── RESTAURANT: INVENTORY MANAGEMENT ──────────────────────────────────────────

// GET /api/business-os/restaurant/inventory — list inventory items
router.get('/restaurant/inventory', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const items = await prisma.inventoryItem.findMany({
        where: { businessProfileId: bpId, isActive: true },
        include: {
            recipeIngredients: { include: { product: { select: { name: true, id: true } } } },
        },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    const annotated = items.map(item => ({
        ...item,
        isLowStock: item.currentStock <= item.minimumStock,
        isOutOfStock: item.currentStock <= 0,
        totalCostGhs: item.currentStock * item.costPerUnit,
    }));
    res.json({ success: true, items: annotated });
}));

// POST /api/business-os/restaurant/inventory — create inventory item
router.post('/restaurant/inventory', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { name, unit, currentStock, minimumStock, costPerUnit, category, supplier } = req.body;
    try {
        const item = await prisma.inventoryItem.create({
            data: {
                businessProfileId: bpId, name, unit,
                currentStock: parseFloat(currentStock),
                minimumStock: parseFloat(minimumStock || 0),
                costPerUnit: parseFloat(costPerUnit),
                category, supplier,
            },
        });
        res.json({ success: true, item });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, message: 'An ingredient with this name already exists' });
        throw e;
    }
}));

// PATCH /api/business-os/restaurant/inventory/:id — update stock or details
router.patch('/restaurant/inventory/:id', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { currentStock, minimumStock, costPerUnit, category, supplier, adjustment } = req.body;
    const existing = await prisma.inventoryItem.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Item not found' });
    const updateData = {};
    if (currentStock !== undefined) updateData.currentStock = parseFloat(currentStock);
    if (adjustment !== undefined) updateData.currentStock = Math.max(0, existing.currentStock + parseFloat(adjustment));
    if (minimumStock !== undefined) updateData.minimumStock = parseFloat(minimumStock);
    if (costPerUnit !== undefined) updateData.costPerUnit = parseFloat(costPerUnit);
    if (category !== undefined) updateData.category = category;
    if (supplier !== undefined) updateData.supplier = supplier;
    const item = await prisma.inventoryItem.update({
        where: { id: req.params.id }, data: updateData,
    });
    res.json({ success: true, item });
}));

// POST /api/business-os/restaurant/inventory/:id/restock — quick restock
router.post('/restaurant/inventory/:id/restock', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { quantity } = req.body;
    const result = await prisma.inventoryItem.updateMany({
        where: { id: req.params.id, businessProfileId: bpId },
        data: { currentStock: { increment: parseFloat(quantity) } },
    });
    if (!result.count) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true });
}));

// GET /api/business-os/restaurant/recipes — get recipe costs per product
router.get('/restaurant/recipes', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const products = await prisma.businessProduct.findMany({
        where: { businessProfileId: bpId },
        include: { recipeIngredients: { include: { inventoryItem: true } } },
    });
    const withCost = products.map(p => ({
        id: p.id, name: p.name, priceUsdc: p.priceUsdc,
        ingredients: p.recipeIngredients.map(ri => ({
            id: ri.id, inventoryItemId: ri.inventoryItemId,
            inventoryItemName: ri.inventoryItem.name, unit: ri.inventoryItem.unit,
            quantityRequired: ri.quantityRequired,
            costGhs: ri.quantityRequired * ri.inventoryItem.costPerUnit,
        })),
        totalCostGhs: p.recipeIngredients.reduce((sum, ri) => sum + ri.quantityRequired * ri.inventoryItem.costPerUnit, 0),
    }));
    res.json({ success: true, products: withCost });
}));

// POST /api/business-os/restaurant/recipes/:productId/link — link ingredient to product
router.post('/restaurant/recipes/:productId/link', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { inventoryItemId, quantityRequired } = req.body;
    const link = await prisma.recipeIngredient.upsert({
        where: { productId_inventoryItemId: { productId: req.params.productId, inventoryItemId } },
        create: { productId: req.params.productId, inventoryItemId, quantityRequired: parseFloat(quantityRequired) },
        update: { quantityRequired: parseFloat(quantityRequired) },
    });
    res.json({ success: true, link });
}));

// DELETE /api/business-os/restaurant/recipes/:productId/link/:itemId — remove link
router.delete('/restaurant/recipes/:productId/link/:itemId', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    await prisma.recipeIngredient.deleteMany({
        where: { productId: req.params.productId, inventoryItemId: req.params.itemId },
    });
    res.json({ success: true });
}));

// POST /api/business-os/restaurant/inventory/deduct/:orderId — deduct inventory when order completes
router.post('/restaurant/inventory/deduct/:orderId', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const order = await prisma.businessOrder.findFirst({
        where: { id: req.params.orderId, businessProfileId: bpId },
        include: { product: { include: { recipeIngredients: { include: { inventoryItem: true } } } } },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.product?.recipeIngredients?.length) {
        return res.json({ success: true, message: 'No recipe configured — nothing deducted', deductions: [] });
    }
    const qty = order.quantity || 1;
    const deductions = [];
    await prisma.$transaction(async (tx) => {
        for (const ri of order.product.recipeIngredients) {
            const deductQty = ri.quantityRequired * qty;
            await tx.inventoryItem.update({
                where: { id: ri.inventoryItemId },
                data: { currentStock: { decrement: deductQty } },
            });
            deductions.push({ ingredient: ri.inventoryItem.name, deducted: deductQty, unit: ri.inventoryItem.unit });
        }
    });
    res.json({ success: true, message: 'Inventory deducted', deductions });
}));

module.exports = router;
