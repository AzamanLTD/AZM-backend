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
    const employees = await svc.employeeService.getEmployees(bpId, { role, status, search });
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
    const rack = await svc.hotelOpsService.getRoomRack(bpId, req.query.date);
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
    const manifests = await svc.transitOpsService.getDailyManifests(bpId, req.query.date);
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

module.exports = router;
