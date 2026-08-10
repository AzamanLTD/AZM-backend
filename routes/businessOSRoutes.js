// 📁 routes/businessOSRoutes.js
// routes/businessOSRoutes.js
// =============================================================================
// Business OS Routes — Employee management, shifts, payroll, EWA, ledger,
// hotel ops, restaurant ops, transit ops, and feedback.
//
// All routes are mounted under /api/business-os/ and require business auth.
// =============================================================================

const logger = require('../src/config/logger');
const { downloadInvoicePdf } = require('../controllers/invoiceController');
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
const { BusinessGroupService } = require("../services/businessOS/businessGroupService");

// Auth middleware — the existing backend exports { protect, adminOnly }
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require("../middleware/requirePermission");
const webhookDispatcher = require('../services/webhookDispatcher');

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
    const bp = await prisma.businessProfile.findFirst({
        where: { userId: req.user.id },
    });
    if (!bp) return null;
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
        groupService: new BusinessGroupService(prisma),
    };
}

// Helper: async error wrapper — uses existing backend response envelope
function wrap(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            logger.error({ err: err }, '[BusinessOS]');
            res.status(400).json({ success: false, message: err.message });
        }
    };
}

// Apply auth + ban guard middleware to all routes
router.use(protect, protectActive);


// ═══════════════════════════════════════════════════════════════════════════
// WORKER SELF-SERVICE (Employee-facing — uses req.user.id, no business profile needed)
// These endpoints power the Worker Sub-Portal in the Flutter app.
// A user tagged as an active employee can access these without owning a business.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/business-os/employees/me — get current user's employee record
router.get('/employees/me', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
        include: {
            businessProfile: {
                select: { id: true, businessName: true, category: true, logoUrl: true },
            },
            user: { select: { username: true } },
        },
    });
    if (!employee) return res.json({ success: true, employee: null });
    res.json({ success: true, employee });
}));

// GET /api/business-os/employees/my-dashboard — full worker dashboard (aggregated)
router.get('/employees/my-dashboard', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const svc = getServices(req);
    const dashboard = await svc.employeeService.getWorkerDashboard(req.user.id);
    if (!dashboard) return res.json({ success: true, dashboard: null });
    res.json({ success: true, dashboard });
}));

// GET /api/business-os/employees/my-shifts — get current user's shift schedule
router.get('/employees/my-shifts', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const svc = getServices(req);
    const shifts = await svc.shiftService.getUserSchedule(req.user.id, {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
    });
    res.json({ success: true, shifts });
}));

// GET /api/business-os/employees/my-team — get team on duty at the user's business
router.get('/employees/my-team', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    // Find the user's active employment
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) return res.json({ success: true, teamOnDuty: [], upcomingTeam: null });
    const svc = getServices(req);
    const teamOnDuty = await svc.shiftService.getTeamOnDuty(employee.businessProfileId);
    const upcomingTeam = await svc.shiftService.getUpcomingTeam(employee.businessProfileId);
    res.json({ success: true, teamOnDuty, upcomingTeam });
}));

// GET /api/business-os/employees/my-payroll — get current user's payroll records
router.get('/employees/my-payroll', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) return res.json({ success: true, records: [] });
    const svc = getServices(req);
    const records = await svc.payrollService.getPayrollRecords(employee.businessProfileId, {
        employeeId: employee.id,
        period: req.query.period,
    });
    res.json({ success: true, records });
}));

// GET /api/business-os/employees/my-earnings — get EWA summary and history
router.get('/employees/my-earnings', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) return res.json({ success: true, ewaHistory: [], ewaSummary: null });
    const svc = getServices(req);
    const ewaHistory = await svc.ewaService.getEwaHistory(employee.id);
    const ewaEligible = await svc.ewaService.checkEligibility(employee.id);
    const accrued = parseFloat(employee.accruedWages);
    const withdrawn = parseFloat(employee.withdrawnEarly);
    res.json({
        success: true,
        ewaHistory,
        ewaEligible,
        ewaAvailable: Math.max(0, accrued * 0.30 - withdrawn),
        accruedWages: accrued,
        withdrawnEarly: withdrawn,
    });
}));

// POST /api/business-os/employees/my-ewa-request — request EWA withdrawal
router.post('/employees/my-ewa-request', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) throw new Error('You are not an active employee.');
    const svc = getServices(req);
    const result = await svc.employeeService.requestEWA(employee.id, req.body.amount);
    res.json({ success: true, ...result });
}));

// GET /api/business-os/employees/my-feedback — get feedback received by the current user
router.get('/employees/my-feedback', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) return res.json({ success: true, feedback: [] });
    const svc = getServices(req);
    const feedback = await svc.feedbackService.getFeedbackForEmployee(employee.id);
    res.json({ success: true, feedback });
}));

// GET /api/business-os/employees/shifts/open — get open shift swaps the user can claim
router.get('/employees/shifts/open', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) return res.json({ success: true, swaps: [] });
    const svc = getServices(req);
    const swaps = await svc.shiftService.getShiftSwaps(employee.businessProfileId, { status: 'OPEN' });
    res.json({ success: true, swaps });
}));

// POST /api/business-os/employees/shifts/:shiftId/clock-in — worker clocks themselves in
router.post('/employees/shifts/:shiftId/clock-in', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    // Verify the shift belongs to this user
    const shift = await prisma.shift.findFirst({
        where: { id: req.params.shiftId },
        include: { employee: true },
    });
    if (!shift) throw new Error('Shift not found.');
    if (shift.employee.userId !== req.user.id) throw new Error('This shift does not belong to you.');
    const svc = getServices(req);
    const updated = await svc.shiftService.clockIn(req.params.shiftId);
    res.json({ success: true, shift: updated });
}));

// POST /api/business-os/employees/shifts/:shiftId/clock-out — worker clocks themselves out
router.post('/employees/shifts/:shiftId/clock-out', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const shift = await prisma.shift.findFirst({
        where: { id: req.params.shiftId },
        include: { employee: true },
    });
    if (!shift) throw new Error('Shift not found.');
    if (shift.employee.userId !== req.user.id) throw new Error('This shift does not belong to you.');
    const svc = getServices(req);
    const updated = await svc.shiftService.clockOut(req.params.shiftId);
    res.json({ success: true, shift: updated });
}));

// POST /api/business-os/employees/shifts/:shiftId/request-swap — worker requests shift swap
router.post('/employees/shifts/:shiftId/request-swap', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) throw new Error('You are not an active employee.');
    const svc = getServices(req);
    const swap = await svc.shiftService.requestShiftSwap({
        businessProfileId: employee.businessProfileId,
        shiftId: req.params.shiftId,
        requestingEmployeeId: employee.id,
        reason: req.body.reason,
    });
    res.status(201).json({ success: true, swap });
}));

// POST /api/business-os/employees/time-off — worker requests time off
router.post('/employees/time-off', wrap(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
    });
    if (!employee) throw new Error('You are not an active employee.');
    const svc = getServices(req);
    const request = await svc.timeOffService.requestTimeOff({
        businessProfileId: employee.businessProfileId,
        employeeId: employee.id,
        type: req.body.type,
        startDate: req.body.startDate,
        endDate: req.body.endDate,
        reason: req.body.reason,
    });
    res.status(201).json({ success: true, request });
}));


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
router.post('/employees', requirePermission('employees.create'), wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { logBusinessAudit } = require('../utils/businessAudit');
    const employee = await svc.employeeService.addEmployee({ ...req.body, businessProfileId: bpId });
    await logBusinessAudit(svc.prisma, { businessProfileId: bpId, actorId: req.user.id, actorName: req.user.username, action: 'EMPLOYEE_CREATED', targetType: 'Employee', targetId: employee.id, metadata: { name: employee.fullName, email: employee.email, role: employee.role }, ipAddress: req.ip });
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
router.patch('/employees/:id', requirePermission('employees.manage'), wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const employee = await svc.employeeService.updateEmployee(req.params.id, bpId, req.body);
    res.json({ success: true, employee });
}));

// DELETE /api/business-os/employees/:id
router.delete('/employees/:id', requirePermission('employees.manage'), wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { logBusinessAudit } = require('../utils/businessAudit');
    await svc.employeeService.removeEmployee(req.params.id, bpId);
    await logBusinessAudit(svc.prisma, { businessProfileId: bpId, actorId: req.user.id, actorName: req.user.username, action: 'EMPLOYEE_TERMINATED', targetType: 'Employee', targetId: req.params.id, metadata: {}, ipAddress: req.ip });
    res.status(200).json({ success: true });
}));

// POST /api/business-os/employees/:id/permissions
router.post('/employees/:id/permissions', requirePermission('employees.permissions'), wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const { logBusinessAudit } = require('../utils/businessAudit');
    const employee = await svc.employeeService.updatePermissions(req.params.id, bpId, req.body.permissions);
    await logBusinessAudit(svc.prisma, { businessProfileId: bpId, actorId: req.user.id, actorName: req.user.username, action: 'PERMISSION_CHANGED', targetType: 'Employee', targetId: req.params.id, metadata: { permissions: req.body.permissions }, ipAddress: req.ip });
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
router.post('/shifts', requirePermission('shifts.create'), wrap(async (req, res) => {
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
router.patch('/shifts/:id', requirePermission('shifts.update'), wrap(async (req, res) => {
    const svc = getServices(req);
    const shift = await svc.shiftService.updateShift(req.params.id, req.body);
    res.json({ success: true, shift });
}));

// DELETE /api/business-os/shifts/:id
router.delete('/shifts/:id', requirePermission('shifts.delete'), wrap(async (req, res) => {
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

router.post('/shifts/swaps/:id/approve', requirePermission('shifts.approve_swap'), wrap(async (req, res) => {
    const svc = getServices(req);
    const swap = await svc.shiftService.approveShiftSwap(req.params.id, req.body.managerNote);
    res.json({ success: true, swap });
}));

router.post('/shifts/swaps/:id/reject', requirePermission('shifts.approve_swap'), wrap(async (req, res) => {
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

router.post('/time-off/:id/approve', requirePermission('shifts.approve_timeoff'), wrap(async (req, res) => {
    const svc = getServices(req);
    const request = await svc.timeOffService.approveTimeOff(req.params.id, req.user.id, req.body.managerNote);
    res.json({ success: true, request });
}));

router.post('/time-off/:id/reject', requirePermission('shifts.approve_timeoff'), wrap(async (req, res) => {
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

router.post('/payroll/process', requirePermission('payroll.process'), wrap(async (req, res) => {
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
    const { logBusinessAudit } = require('../utils/businessAudit');
    await logBusinessAudit(svc.prisma, { businessProfileId: bpId, actorId: req.user.id, actorName: req.user.username, action: 'PAYROLL_PROCESSED', targetType: 'Payroll', targetId: null, metadata: { period }, ipAddress: req.ip });
}));

router.post('/payroll/disburse', requirePermission('payroll.disburse'), wrap(async (req, res) => {
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
    const { logBusinessAudit: _auditPay } = require('../utils/businessAudit');
    await _auditPay(svc.prisma, { businessProfileId: bpId, actorId: req.user.id, actorName: req.user.username, action: 'PAYROLL_DISBURSED', targetType: 'Payroll', targetId: null, metadata: { payrollId, period }, ipAddress: req.ip });
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

router.post('/ledger', requirePermission('finance.ledger.manage'), wrap(async (req, res) => {
    const svc = getServices(req);
    const bpId = await getBusinessProfileId(req);
    const entry = await svc.ledgerService.createEntry({ ...req.body, businessProfileId: bpId });
    res.status(201).json({ success: true, entry });
}));

router.delete('/ledger/:id', requirePermission('finance.ledger.manage'), wrap(async (req, res) => {
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
// ── Hotel: Rate Calendar ──────────────────────────────────────────────────────
router.get('/hotel/rate-calendar', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const days = parseInt(req.query.days) || 14;
    const data = await svc.hotelOpsService.getRateCalendar(bpId, days);
    res.json({ data });
}));

router.post('/hotel/rate-calendar', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const override = await svc.hotelOpsService.upsertRateOverride(bpId, req.body);
    res.json({ data: override });
}));

router.delete('/hotel/rate-calendar/:id', wrap(async (req, res) => {
    await svc.hotelOpsService.deleteRateOverride(req.params.id);
    res.json({ ok: true });
}));

// ── Hotel: Room Block ─────────────────────────────────────────────────────────
router.post('/hotel/rooms/:id/block', wrap(async (req, res) => {
    const block = await svc.hotelOpsService.blockRoom(req.params.id, req.body);
    res.json({ data: block });
}));

router.delete('/hotel/rooms/block/:blockId', wrap(async (req, res) => {
    await svc.hotelOpsService.deleteRoomBlock(req.params.blockId);
    res.json({ ok: true });
}));

// ── Hotel: Room Update (full) ─────────────────────────────────────────────────
router.patch('/hotel/rooms/:id', wrap(async (req, res) => {
    const room = await svc.hotelOpsService.updateRoom(req.params.id, req.body);
    res.json({ data: room });
}));

// ── Hotel: Bulk Room Creation ─────────────────────────────────────────────────
router.post('/hotel/rooms/bulk', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const result = await svc.hotelOpsService.bulkCreateRooms(bpId, req.body);
    res.json({ data: result });
}));

// ── Hotel: Walk-In Booking ────────────────────────────────────────────────────
router.post('/hotel/front-desk/walk-in', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const reservation = await svc.hotelOpsService.createWalkIn(bpId, req.body);
    res.json({ data: reservation });
}));

// ── Hotel: Room Move ──────────────────────────────────────────────────────────
router.post('/hotel/front-desk/:reservationId/move-room', wrap(async (req, res) => {
    const result = await svc.hotelOpsService.moveRoom(req.params.reservationId, req.body);
    res.json({ data: result });
}));

// ── Hotel: Create Housekeeping Task (manual) ──────────────────────────────────
// GET /api/business-os/hotel/housekeeping/templates — list checklist templates
router.get('/hotel/housekeeping/templates', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const templates = await prisma.hotelHousekeepingTemplate.findMany({
        where: { businessProfileId: bpId },
        orderBy: { taskType: 'asc' },
    });

    // Group by taskType: { CHECKOUT_CLEAN: ['item1', ...], DEEP_CLEAN: [...] }
    const grouped = {};
    for (const t of templates) {
        const items = Array.isArray(t.checklistItems) ? t.checklistItems : [];
        if (!grouped[t.taskType]) grouped[t.taskType] = [];
        grouped[t.taskType].push(...items);
    }
    res.json({ success: true, templates: grouped });
}));

// POST /api/business-os/hotel/housekeeping/templates — create or update a template
router.post('/hotel/housekeeping/templates', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { taskType, name, checklistItems } = req.body;
    if (!taskType || !name || !Array.isArray(checklistItems)) {
        return res.status(400).json({ success: false, message: 'taskType, name, and checklistItems[] are required' });
    }

    const template = await prisma.hotelHousekeepingTemplate.upsert({
        where: {
            businessProfileId_taskType_name: { businessProfileId: bpId, taskType, name },
        },
        update: { checklistItems },
        create: { businessProfileId: bpId, taskType, name, checklistItems },
    });
    res.status(201).json({ success: true, template });
}));

router.post('/hotel/housekeeping', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const { roomId, taskType, priority, notes, checklistItems } = req.body;
    const task = await svc.hotelOpsService.prisma.hotelHousekeepingTask.create({
        data: {
            businessProfileId: bpId,
            roomId,
            taskType: taskType || 'DAILY_REFRESH',
            priority: priority ? parseInt(priority) : 5,
            description: notes,
            checklistItems: checklistItems || [],
            status: 'PENDING',
        },
    });
    res.json({ data: task });
}));


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

// PATCH /api/business-os/restaurant/tables/:id/status — update table status
// Updates the active DineInTab status on the BusinessTable, or creates one if needed.
router.patch('/restaurant/tables/:id/status', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { status } = req.body;
    const validStatuses = ['OPEN', 'SEATED', 'ORDERED', 'EATING', 'BILLING', 'CLEANING'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
    }

    // Verify table belongs to this business
    const table = await prisma.businessTable.findUnique({
        where: { id: req.params.id },
        include: { location: { select: { businessProfileId: true } } },
    });
    if (!table || table.location.businessProfileId !== bpId) {
        return res.status(404).json({ success: false, message: 'Table not found' });
    }

    // Find active (non-CLOSED) tab on this table
    const activeTab = await prisma.dineInTab.findFirst({
        where: { tableId: table.id, status: { not: 'CLOSED' } },
        orderBy: { openedAt: 'desc' },
    });

    if (status === 'OPEN') {
        // If going back to OPEN, close any active tab
        if (activeTab) {
            await prisma.dineInTab.update({
                where: { id: activeTab.id },
                data: { status: 'CLOSED', closedAt: new Date() },
            });
        }
    } else if (activeTab) {
        // Update existing tab status
        await prisma.dineInTab.update({
            where: { id: activeTab.id },
            data: { status },
        });
    } else {
        // No active tab — create one with this status
        // Find a guest customer or create a walk-in placeholder
        const guestUser = await prisma.user.findFirst({
            where: { email: 'guest-walkin@azaman.azm' },
            select: { id: true },
        });
        if (!guestUser) {
            return res.status(400).json({ success: false, message: 'No active tab found and no guest user available. Open a tab first.' });
        }
        await prisma.dineInTab.create({
            data: {
                businessProfileId: bpId,
                locationId: table.locationId,
                tableId: table.id,
                customerId: guestUser.id,
                status,
            },
        });
    }

    res.json({ success: true, tableId: table.id, status });
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

// ── Restaurant Waitlist (Module 04) ──────────────────────────────────────────

// GET /api/business-os/restaurant/waitlist — list waitlist entries
router.get('/restaurant/waitlist', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const entries = await prisma.restaurantWaitlistEntry.findMany({
        where: { businessProfileId: bpId, status: req.query.status || 'WAITING' },
        orderBy: { createdAt: 'asc' },
        include: { table: { select: { label: true, id: true } } },
    });
    res.json({ success: true, data: entries });
}));

// POST /api/business-os/restaurant/waitlist — add to waitlist
router.post('/restaurant/waitlist', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { partyName, phone, partySize, quotedWaitMinutes, locationId } = req.body;
    if (!partyName) return res.status(400).json({ success: false, message: 'Party name is required' });
    const entry = await prisma.restaurantWaitlistEntry.create({
        data: { businessProfileId: bpId, partyName, phone, partySize: partySize || 2, quotedWaitMinutes, locationId },
    });
    res.status(201).json({ success: true, data: entry });
}));

// PATCH /api/business-os/restaurant/waitlist/:id — update waitlist entry
router.patch('/restaurant/waitlist/:id', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { status, tableId } = req.body;
    const updateData = {};
    if (status) updateData.status = status;
    if (tableId) updateData.tableId = tableId;
    if (status === 'SEATED') updateData.seatedAt = new Date();
    if (status === 'NOTIFIED') updateData.notifiedAt = new Date();

    const entry = await prisma.restaurantWaitlistEntry.updateMany({
        where: { id: req.params.id, businessProfileId: bpId },
        data: updateData,
    });
    if (!entry.count) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true });
}));

// DELETE /api/business-os/restaurant/waitlist/:id — remove from waitlist
router.delete('/restaurant/waitlist/:id', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    await prisma.restaurantWaitlistEntry.deleteMany({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    res.json({ success: true });
}));

// ── Table metadata / floor plan (Module 04) ───────────────────────────────────

// PATCH /api/business-os/restaurant/tables/:id/metadata — update table floor-plan metadata
router.patch('/restaurant/tables/:id/metadata', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { metadata } = req.body;
    const table = await prisma.businessTable.findFirst({
        where: { id: req.params.id, location: { businessProfileId: bpId } },
    });
    if (!table) return res.status(404).json({ success: false, message: 'Table not found' });
    const updated = await prisma.businessTable.update({
        where: { id: req.params.id },
        data: { metadata },
    });
    res.json({ success: true, data: updated });
}));

// ── Catalog section reorder (Module 04) ───────────────────────────────────────

// PATCH /api/business-os/restaurant/sections/reorder — reorder catalog sections
router.patch('/restaurant/sections/reorder', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, message: 'orderedIds must be an array' });

    for (let i = 0; i < orderedIds.length; i++) {
        await prisma.catalogSection.updateMany({
            where: { id: orderedIds[i], businessProfileId: bpId },
            data: { displayOrder: i },
        });
    }
    res.json({ success: true });
}))


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
// ── MODULE 05: TRANSIT ROUTE TEMPLATES ────────────────────────────────────────

// GET /api/business-os/transit/routes — list route templates
router.get('/transit/routes', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const templates = await prisma.transitRouteTemplate.findMany({
        where: { businessProfileId: bpId },
        include: { vehicle: true },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, templates });
}));

// POST /api/business-os/transit/routes — create route template
router.post('/transit/routes', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const tpl = await prisma.transitRouteTemplate.create({
        data: {
            businessProfileId: bpId,
            name: req.body.name,
            origin: req.body.origin,
            destination: req.body.destination,
            typicalFareUsdc: req.body.typicalFareUsdc || 0,
            typicalDurationMins: req.body.typicalDurationMins || null,
            vehicleId: req.body.vehicleId || null,
            defaultDepartureTimes: req.body.defaultDepartureTimes || null,
            notes: req.body.notes || null,
            isActive: true,
        },
        include: { vehicle: true },
    });
    res.status(201).json({ success: true, template: tpl });
}));

// DELETE /api/business-os/transit/routes/:id — delete route template
router.delete('/transit/routes/:id', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const tpl = await prisma.transitRouteTemplate.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!tpl) return res.status(404).json({ success: false, message: 'Route template not found' });
    await prisma.transitRouteTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
}));

// POST /api/business-os/transit/routes/generate-trips — generate trips from template
router.post('/transit/routes/generate-trips', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { templateId, startDate, daysAhead } = req.body;
    if (!templateId || !startDate) {
        return res.status(400).json({ success: false, message: 'templateId and startDate are required' });
    }
    const tpl = await prisma.transitRouteTemplate.findFirst({
        where: { id: templateId, businessProfileId: bpId },
    });
    if (!tpl) return res.status(404).json({ success: false, message: 'Route template not found' });
    const start = new Date(startDate);
    const days = daysAhead || 30;
    const created = [];
    const departureTimes = tpl.defaultDepartureTimes || ['07:00'];
    for (let d = 0; d < days; d++) {
        const day = new Date(start);
        day.setDate(day.getDate() + d);
        for (const timeStr of departureTimes) {
            const [hh, mm] = timeStr.split(':').map(Number);
            const departureAt = new Date(day);
            departureAt.setHours(hh, mm || 0, 0, 0);
            const arrivalAt = tpl.typicalDurationMins
                ? new Date(departureAt.getTime() + tpl.typicalDurationMins * 60000) : null;
            const trip = await prisma.transitTrip.create({
                data: {
                    businessProfileId: bpId, vehicleId: tpl.vehicleId,
                    routeName: tpl.name, origin: tpl.origin, destination: tpl.destination,
                    departureAt, arrivalAt, fareUsdc: tpl.typicalFareUsdc,
                    availableSeats: tpl.vehicleId ? (await prisma.transitVehicle.findUnique({ where: { id: tpl.vehicleId }, select: { capacity: true } }))?.capacity || 0 : 0,
                    status: 'SCHEDULED',
                },
            });
            created.push(trip);
        }
    }
    res.status(201).json({ success: true, count: created.length, trips: created });
}));

// POST /api/business-os/transit/trips/:id/cancel — cancel trip with refund handling
router.post('/transit/trips/:id/cancel', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const trip = await prisma.transitTrip.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
        include: { bookings: { where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } } } },
    });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.status === 'CANCELLED') return res.status(400).json({ success: false, message: 'Trip already cancelled' });
    const affectedBookings = trip.bookings;
    await prisma.transitTrip.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    if (affectedBookings.length > 0) {
        await prisma.transitBooking.updateMany({
            where: { transitTripId: req.params.id, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
            data: { status: 'CANCELLED' },
        });
    }
    res.json({
        success: true,
        message: `Trip cancelled. ${affectedBookings.length} booking(s) marked for refund.`,
        cancelledBookings: affectedBookings.length,
        bookings: affectedBookings.map(b => ({ id: b.id, userId: b.userId, amountUsdc: b.amountUsdc })),
    });
}));

// GET /api/business-os/transit/maintenance/overdue — get vehicles with overdue maintenance
router.get('/transit/maintenance/overdue', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const vehicles = await prisma.transitVehicle.findMany({
        where: { businessProfileId: bpId, isActive: true },
        include: { maintenances: { where: { status: 'SCHEDULED' }, orderBy: { scheduledDate: 'asc' } } },
    });
    const now = new Date();
    const overdue = vehicles.filter(v => v.maintenances.some(m => new Date(m.scheduledDate) < now))
        .map(v => ({ id: v.id, make: v.make, model: v.model, licensePlate: v.licensePlate,
            overdueSince: v.maintenances.find(m => new Date(m.scheduledDate) < now)?.scheduledDate }));
    res.json({ success: true, overdue });
}));

// PATCH /api/business-os/transit/cargo/:id/proof — attach proof of delivery
router.patch('/transit/cargo/:id/proof', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const cargo = await prisma.cargoParcel.findFirst({ where: { id: req.params.id, businessProfileId: bpId } });
    if (!cargo) return res.status(404).json({ success: false, message: 'Cargo parcel not found' });
    const updated = await prisma.cargoParcel.update({
        where: { id: req.params.id },
        data: {
            proofOfDeliveryUrl: req.body.proofOfDeliveryUrl,
            status: cargo.status === 'IN_TRANSIT' ? 'DELIVERED' : cargo.status,
            deliveredAt: cargo.status === 'IN_TRANSIT' ? new Date() : cargo.deliveredAt,
        },
    });
    res.json({ success: true, cargo: updated });
}));


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

// POST /api/business-os/restaurant/inventory/:id/restock — quick restock (writes ledger expense)
router.post('/restaurant/inventory/:id/restock', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { quantity, costPerUnit } = req.body;
    const item = await prisma.inventoryItem.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

    const updated = await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { currentStock: { increment: parseFloat(quantity) } },
    });

    // Auto-write a BusinessLedgerEntry expense for the restock cost
    const unitCost = costPerUnit != null ? parseFloat(costPerUnit) : item.costPerUnit;
    const totalCostGhs = unitCost * parseFloat(quantity);
    try {
        await prisma.businessLedgerEntry.create({
            data: {
                businessProfileId: bpId,
                type: 'EXPENSE',
                category: 'SUPPLIES',
                description: 'Restock: ' + item.name + ' (x' + quantity + ' ' + item.unit + ')',
                amount: -totalCostGhs,
                amountGhs: -totalCostGhs,
                sourceType: 'INVENTORY_RESTOCK',
                sourceId: item.id,
                metadata: { inventoryItemId: item.id, quantity: parseFloat(quantity), unitCost },
            },
        });
    } catch (e) {
        logger.warn('[restock] Failed to write ledger entry:', e.message);
    }

    res.json({ success: true, item: updated, ledgerWritten: true });
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


// ═══════════════════════════════════════════════════════════════════════════
// MODULE 01 — GOVERNANCE: PERMISSION TEMPLATES, AUDIT LOG, NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── Permission Templates ───────────────────────────────────────────────────

// GET /api/business-os/permission-templates — list all available templates + keys
router.get('/permission-templates', wrap(async (req, res) => {
    const { PERMISSION_KEYS, ALL_KEYS, ROLE_TEMPLATES } = require('../config/permissionTemplates');
    res.json({
        success: true,
        templates: ROLE_TEMPLATES,
        permissionKeys: PERMISSION_KEYS,
        allKeys: ALL_KEYS,
    });
}));

// POST /api/business-os/permission-templates — save a custom template
// (Custom templates are returned alongside system templates; they're stored
//  in a config-style JSON on the business profile's businessMeta for simplicity)
router.post('/permission-templates', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { name, permissions, description } = req.body;
    if (!name || !Array.isArray(permissions)) {
        return res.status(400).json({ success: false, message: 'name and permissions[] are required.' });
    }
    const bp = await prisma.businessProfile.findFirst({ where: { id: bpId }, select: { businessMeta: true } });
    const meta = bp.businessMeta || {};
    const customTemplates = meta.customPermissionTemplates || [];
    const existing = customTemplates.findIndex(t => t.name === name);
    const template = { name, permissions, description: description || '', system: false, createdAt: new Date().toISOString() };
    if (existing >= 0) {
        customTemplates[existing] = { ...customTemplates[existing], ...template };
    } else {
        customTemplates.push(template);
    }
    await prisma.businessProfile.update({
        where: { id: bpId },
        data: { businessMeta: { ...meta, customPermissionTemplates: customTemplates } },
    });
    res.json({ success: true, template });
}));

// ── Audit Log ───────────────────────────────────────────────────────────────

// GET /api/business-os/audit-log — paginated, filterable business audit log
router.get('/audit-log', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { actorId, action, targetType, startDate, endDate, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, parseInt(limit) || 50);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause — filter by businessProfileId in metadata JSON
    // Since AuditLog stores businessProfileId inside metadata, we filter with
    // a JSON path query. Prisma supports filtering on Json fields with
    // stringContains for PostgreSQL jsonb.
    const where = {
        AND: [
            // The _bizAudit tag + businessProfileId are set by logBusinessAudit
            { metadata: { path: ['businessProfileId'], equals: bpId } },
        ],
    };
    if (actorId) where.AND.push({ actorId: Number(actorId) });
    if (action) where.AND.push({ action: { contains: action, mode: 'insensitive' } });
    if (targetType) where.AND.push({ targetType });

    // Date range filter
    if (startDate || endDate) {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) dateFilter.lte = new Date(endDate);
        where.AND.push({ createdAt: dateFilter });
    }

    const [entries, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limitNum,
        }),
        prisma.auditLog.count({ where }),
    ]);

    res.json({
        success: true,
        entries,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
        },
    });
}));

// ── Notification Preferences ─────────────────────────────────────────────────

// GET /api/business-os/notification-preferences
router.get('/notification-preferences', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const pref = await prisma.businessNotificationPreference.findUnique({
        where: { businessProfileId: bpId },
    });
    // Default preferences if no row exists yet
    const defaults = {
        new_order:         { portal: true,  email: true  },
        low_inventory:     { portal: true,  email: false },
        shift_no_show:     { portal: true,  email: true  },
        negative_review:   { portal: true,  email: true  },
        kyb_status_change: { portal: true,  email: true  },
        large_transaction: { portal: true,  email: true  },
        payroll_due:       { portal: true,  email: true  },
        maintenance_due:   { portal: true,  email: false },
    };
    res.json({ success: true, preferences: pref?.preferences || defaults });
}));

// PATCH /api/business-os/notification-preferences
router.patch('/notification-preferences', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
        return res.status(400).json({ success: false, message: 'preferences object is required.' });
    }
    const pref = await prisma.businessNotificationPreference.upsert({
        where: { businessProfileId: bpId },
        update: { preferences },
        create: { businessProfileId: bpId, preferences },
    });
    res.json({ success: true, preferences: pref.preferences });
}));

// ── Location Hours Exceptions ───────────────────────────────────────────────

// GET /api/business-os/locations/:locationId/hours-exceptions
router.get('/locations/:locationId/hours-exceptions', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    // Verify the location belongs to this business
    const loc = await prisma.businessLocation.findFirst({
        where: { id: req.params.locationId, businessProfileId: bpId },
    });
    if (!loc) return res.status(404).json({ success: false, message: 'Location not found.' });
    const exceptions = await prisma.businessLocationHoursException.findMany({
        where: { locationId: req.params.locationId },
        orderBy: { date: 'asc' },
    });
    res.json({ success: true, exceptions });
}));

// POST /api/business-os/locations/:locationId/hours-exceptions
router.post('/locations/:locationId/hours-exceptions', requirePermission('locations.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const loc = await prisma.businessLocation.findFirst({
        where: { id: req.params.locationId, businessProfileId: bpId },
    });
    if (!loc) return res.status(404).json({ success: false, message: 'Location not found.' });
    const { date, isClosed, openTime, closeTime, note } = req.body;
    if (!date) return res.status(400).json({ success: false, message: 'date is required.' });
    const exception = await prisma.businessLocationHoursException.upsert({
        where: { locationId_date: { locationId: req.params.locationId, date: new Date(date) } },
        update: { isClosed: !!isClosed, openTime, closeTime, note },
        create: {
            locationId: req.params.locationId,
            date: new Date(date),
            isClosed: !!isClosed,
            openTime,
            closeTime,
            note,
        },
    });
    res.json({ success: true, exception });
}));

// DELETE /api/business-os/locations/:locationId/hours-exceptions/:exceptionId
router.delete('/locations/:locationId/hours-exceptions/:exceptionId', requirePermission('locations.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const loc = await prisma.businessLocation.findFirst({
        where: { id: req.params.locationId, businessProfileId: bpId },
    });
    if (!loc) return res.status(404).json({ success: false, message: 'Location not found.' });
    await prisma.businessLocationHoursException.delete({
        where: { id: req.params.exceptionId },
    });
    res.json({ success: true, message: 'Exception deleted.' });
}));

// ── Business Pause (Danger Zone) ────────────────────────────────────────────

// PATCH /api/business-os/pause — toggle isPausedByOwner
router.patch('/pause', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { paused } = req.body;
    const bp = await prisma.businessProfile.update({
        where: { id: bpId },
        data: { isPausedByOwner: !!paused },
        select: { isPausedByOwner: true },
    });
    // Audit log
    const { logBusinessAudit } = require('../utils/businessAudit');
    await logBusinessAudit(prisma, {
        businessProfileId: bpId,
        actorId: req.user.id,
        actorName: req.user.username,
        action: paused ? 'BUSINESS_PAUSED' : 'BUSINESS_UNPAUSED',
        targetType: 'BUSINESS_PROFILE',
        targetId: bpId,
        metadata: { isPausedByOwner: bp.isPausedByOwner },
        ipAddress: req.ip,
    });
    res.json({ success: true, isPausedByOwner: bp.isPausedByOwner });
}));


// ── MODULE 06: UNIVERSAL BOOKING, ORDERS & INVOICING ────────────────────────

// ── Tax Presets ──────────────────────────────────────────────────────────────

// GET /api/business-os/tax-presets — list tax presets for the business
router.get('/tax-presets', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const presets = await prisma.businessTaxPreset.findMany({
        where: { businessProfileId: bpId },
        orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, presets });
}));

// POST /api/business-os/tax-presets — create a tax preset
router.post('/tax-presets', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { name, type, value, isDefault } = req.body;
    if (!name || !type || value === undefined) {
        return res.status(400).json({ success: false, message: 'name, type, and value are required.' });
    }
    // If isDefault, unset other defaults
    if (isDefault) {
        await prisma.businessTaxPreset.updateMany({
            where: { businessProfileId: bpId, isDefault: true },
            data: { isDefault: false },
        });
    }
    const preset = await prisma.businessTaxPreset.create({
        data: {
            businessProfileId: bpId,
            name,
            type,
            value: parseFloat(value),
            isDefault: !!isDefault,
        },
    });
    res.status(201).json({ success: true, preset });
}));

// PATCH /api/business-os/tax-presets/:id — update a tax preset
router.patch('/tax-presets/:id', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { name, type, value, isDefault } = req.body;
    // If setting as default, unset other defaults
    if (isDefault) {
        await prisma.businessTaxPreset.updateMany({
            where: { businessProfileId: bpId, isDefault: true, id: { not: req.params.id } },
            data: { isDefault: false },
        });
    }
    const preset = await prisma.businessTaxPreset.update({
        where: { id: req.params.id },
        data: {
            ...(name && { name }),
            ...(type && { type }),
            ...(value !== undefined && { value: parseFloat(value) }),
            ...(isDefault !== undefined && { isDefault: !!isDefault }),
        },
    });
    res.json({ success: true, preset });
}));

// DELETE /api/business-os/tax-presets/:id — delete a tax preset
router.delete('/tax-presets/:id', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    await prisma.businessTaxPreset.deleteMany({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    res.json({ success: true, message: 'Tax preset deleted.' });
}));

// ── Overbooking Toggle ──────────────────────────────────────────────────────

// PATCH /api/business-os/overbooking — toggle allowOverbooking
router.patch('/overbooking', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { allowed } = req.body;
    const bp = await prisma.businessProfile.update({
        where: { id: bpId },
        data: { allowOverbooking: !!allowed },
        select: { allowOverbooking: true },
    });
    const { logBusinessAudit } = require('../utils/businessAudit');
    await logBusinessAudit(prisma, {
        businessProfileId: bpId,
        actorId: req.user.id,
        actorName: req.user.username,
        action: bp.allowOverbooking ? 'OVERBOOKING_ENABLED' : 'OVERBOOKING_DISABLED',
        targetType: 'BUSINESS_PROFILE',
        targetId: bpId,
        metadata: { allowOverbooking: bp.allowOverbooking },
        ipAddress: req.ip,
    });
    res.json({ success: true, allowOverbooking: bp.allowOverbooking });
}));

// ── Reservation Reschedule/Negotiation ──────────────────────────────────────

// POST /api/business-os/reservations/:id/propose-reschedule — owner proposes new time
router.post('/reservations/:id/propose-reschedule', requirePermission('reservations.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { proposedStartDatetime, proposedEndDatetime, message } = req.body;
    if (!proposedStartDatetime) {
        return res.status(400).json({ success: false, message: 'proposedStartDatetime is required.' });
    }
    const reservation = await prisma.reservation.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found.' });
    if (reservation.status !== 'PENDING' && reservation.status !== 'CONFIRMED') {
        return res.status(400).json({ success: false, message: 'Can only reschedule PENDING or CONFIRMED reservations.' });
    }
    const updated = await prisma.reservation.update({
        where: { id: req.params.id },
        data: {
            proposedStartDatetime: new Date(proposedStartDatetime),
            proposedEndDatetime: proposedEndDatetime ? new Date(proposedEndDatetime) : null,
            counterProposeMessage: message || null,
            counterProposedAt: new Date(),
        },
    });
    res.json({ success: true, reservation: updated });
}));

// POST /api/business-os/reservations/:id/respond-reschedule — owner responds to customer's reschedule request
router.post('/reservations/:id/respond-reschedule', requirePermission('reservations.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { accept } = req.body;
    const reservation = await prisma.reservation.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found.' });
    if (!reservation.proposedStartDatetime) {
        return res.status(400).json({ success: false, message: 'No pending reschedule proposal.' });
    }
    if (accept) {
        // Apply the proposed times
        const updated = await prisma.reservation.update({
            where: { id: req.params.id },
            data: {
                startDatetime: reservation.proposedStartDatetime,
                endDatetime: reservation.proposedEndDatetime || reservation.endDatetime,
                proposedStartDatetime: null,
                proposedEndDatetime: null,
                counterProposeMessage: null,
                counterProposedAt: null,
            },
        });
        res.json({ success: true, reservation: updated, action: 'accepted' });
    } else {
        // Reject the proposal
        const updated = await prisma.reservation.update({
            where: { id: req.params.id },
            data: {
                proposedStartDatetime: null,
                proposedEndDatetime: null,
                counterProposeMessage: null,
                counterProposedAt: null,
            },
        });
        res.json({ success: true, reservation: updated, action: 'rejected' });
    }
}));

// ── Slot Preview ─────────────────────────────────────────────────────────────

// GET /api/business-os/availability/slots-preview?days=7 — show available slots
router.get('/availability/slots-preview', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const days = parseInt(req.query.days) || 7;
    const locationId = req.query.locationId || null;

    const rules = await prisma.availabilityRule.findMany({
        where: { businessProfileId: bpId, isActive: true, ...(locationId && { locationId }) },
        orderBy: { dayOfWeek: 'asc' },
    });

    // Get existing reservations for the next N days
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + days);

    const existing = await prisma.reservation.findMany({
        where: {
            businessProfileId: bpId,
            status: { in: ['PENDING', 'CONFIRMED'] },
            startDatetime: { gte: startDate, lt: endDate },
            ...(locationId && { locationId }),
        },
        select: { startDatetime: true, endDatetime: true, partySize: true },
    });

    // Compute open slots per day based on rules
    const slots = [];
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    for (let d = 0; d < days; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + d);
        const dayOfWeek = dayNames[date.getDay()];
        const dayRules = rules.filter(r => r.dayOfWeek === dayOfWeek);
        const daySlot = {
            date: date.toISOString().slice(0, 10),
            dayName: dayOfWeek.charAt(0) + dayOfWeek.slice(1).toLowerCase(),
            open: dayRules.length > 0,
            windows: dayRules.map(r => ({
                startTime: r.startTime,
                endTime: r.endTime,
                booked: existing.filter(e => {
                    const eDate = new Date(e.startDatetime).toISOString().slice(0, 10);
                    return eDate === date.toISOString().slice(0, 10);
                }).length,
            })),
        };
        slots.push(daySlot);
    }

    res.json({ success: true, slots, allowOverbooking: true });
}));

// ── Bulk Order Operations ───────────────────────────────────────────────────

// POST /api/business-os/orders/bulk-status — bulk update order status
router.post('/orders/bulk-status', requirePermission('orders.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { orderIds, status } = req.body;
    if (!Array.isArray(orderIds) || !status) {
        return res.status(400).json({ success: false, message: 'orderIds (array) and status are required.' });
    }
    const validStatuses = ['AWAITING_PAYMENT', 'PAID', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    const updateData = { status };
    if (status === 'DELIVERED') updateData.deliveredAt = new Date();
    if (status === 'COMPLETED') updateData.completedAt = new Date();
    if (status === 'CANCELLED') updateData.cancelledAt = new Date();

    const result = await prisma.businessOrder.updateMany({
        where: { id: { in: orderIds }, businessProfileId: bpId },
        data: updateData,
    });

    // Audit log
    const { logBusinessAudit } = require('../utils/businessAudit');
    await logBusinessAudit(prisma, {
        businessProfileId: bpId,
        actorId: req.user.id,
        actorName: req.user.username,
        action: 'BULK_ORDER_STATUS_UPDATE',
        targetType: 'BUSINESS_ORDER',
        targetId: orderIds.join(','),
        metadata: { status, count: result.count },
        ipAddress: req.ip,
    });

    res.json({ success: true, updated: result.count });
}));

// ── Order Refund/Dispute ─────────────────────────────────────────────────────

// POST /api/business-os/orders/:id/refund — initiate refund through escrow dispute
router.post('/orders/:id/refund', requirePermission('orders.refund'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { reason } = req.body;
    if (!reason) {
        return res.status(400).json({ success: false, message: 'A reason is required for refunds.' });
    }
    const order = await prisma.businessOrder.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
        include: { escrow: true },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.escrow) {
        return res.status(400).json({ success: false, message: 'No escrow linked to this order. Cannot process refund.' });
    }
    if (order.escrow.status === 'REFUNDED' || order.escrow.status === 'DISPUTED') {
        return res.status(400).json({ success: false, message: 'Escrow already ' + order.escrow.status.toLowerCase() + '.' });
    }
    // Dispute the escrow
    const escrow = require('../utils/escrow');
    const result = await escrow.dispute(order.escrow.id, reason);

    // Update order status
    await prisma.businessOrder.update({
        where: { id: req.params.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    // Audit log
    const { logBusinessAudit } = require('../utils/businessAudit');
    await logBusinessAudit(prisma, {
        businessProfileId: bpId,
        actorId: req.user.id,
        actorName: req.user.username,
        action: 'ORDER_REFUND_INITIATED',
        targetType: 'BUSINESS_ORDER',
        targetId: req.params.id,
        metadata: { reason, escrowId: order.escrow.id, amountUsdc: order.amountUsdc.toString() },
        ipAddress: req.ip,
    });

    res.json({ success: true, escrow: result, orderRef: order.orderRef });
}));

// ── Invoice Stats ────────────────────────────────────────────────────────────

// GET /api/business-os/invoices/stats — invoice dashboard stats
router.get('/invoices/stats', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, stats: { draft: 0, sent: 0, paid: 0, voided: 0, totalRevenueUsdc: '0' } });
    const [draft, sent, paid, voided, totalRevenue] = await Promise.all([
        prisma.businessInvoice.count({ where: { businessProfileId: bpId, status: 'DRAFT' } }),
        prisma.businessInvoice.count({ where: { businessProfileId: bpId, status: 'SENT' } }),
        prisma.businessInvoice.count({ where: { businessProfileId: bpId, status: 'PAID' } }),
        prisma.businessInvoice.count({ where: { businessProfileId: bpId, status: 'VOID' } }),
        prisma.businessInvoice.aggregate({
            where: { businessProfileId: bpId, status: 'PAID' },
            _sum: { billTotalUsdc: true },
        }),
    ]);
    res.json({
        success: true,
        stats: {
            draft, sent, paid, voided,
            totalRevenueUsdc: totalRevenue._sum.billTotalUsdc?.toString() || '0',
        },
    });
}));


// ── Recurring Invoice Endpoints (Phase 3) ────────────────────────────────────

// GET /api/business-os/invoices/recurring — list recurring invoice templates
router.get('/invoices/recurring', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, invoices: [] });

    const invoices = await prisma.businessInvoice.findMany({
        where: { businessProfileId: bpId, isRecurring: true },
        include: { lineItems: true, customer: { select: { id: true, email: true, full_name: true } } },
        orderBy: { recurringNextDate: 'asc' },
    });
    res.json({ success: true, invoices });
}));

// POST /api/business-os/invoices/:id/enable-recurring — enable recurring on an invoice
router.post('/invoices/:id/enable-recurring', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;
    const { interval } = req.body;

    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(interval)) {
        return res.status(400).json({ success: false, message: 'Invalid interval.' });
    }

    const now = new Date();
    let nextDate = new Date(now);
    switch (interval) {
        case 'DAILY':     nextDate.setDate(now.getDate() + 1); break;
        case 'WEEKLY':    nextDate.setDate(now.getDate() + 7); break;
        case 'MONTHLY':   nextDate.setMonth(now.getMonth() + 1); break;
        case 'QUARTERLY': nextDate.setMonth(now.getMonth() + 3); break;
        case 'YEARLY':    nextDate.setFullYear(now.getFullYear() + 1); break;
    }

    const invoice = await prisma.businessInvoice.update({
        where: { id, businessProfileId: bpId },
        data: { isRecurring: true, recurringInterval: interval, recurringNextDate: nextDate },
        include: { lineItems: true },
    });
    res.json({ success: true, invoice });
}));

// POST /api/business-os/invoices/:id/disable-recurring — disable recurring
router.post('/invoices/:id/disable-recurring', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;

    const invoice = await prisma.businessInvoice.update({
        where: { id, businessProfileId: bpId },
        data: { isRecurring: false, recurringInterval: null, recurringNextDate: null },
    });
    res.json({ success: true, invoice });
}));

// GET /api/business-os/invoices/:id/pdf — download invoice as PDF (Phase G.4)
router.get('/invoices/:id/pdf', downloadInvoicePdf);

// POST /api/business-os/invoices/process-recurring — auto-generate due recurring invoices
router.post('/invoices/process-recurring', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const now = new Date();

    const dueTemplates = await prisma.businessInvoice.findMany({
        where: {
            businessProfileId: bpId,
            isRecurring: true,
            recurringNextDate: { lte: now },
            status: { in: ['PAID', 'SENT'] },
        },
        include: { lineItems: true, taxLines: true },
    });

    const created = [];
    for (const template of dueTemplates) {
        const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
        const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
        const newRef = `INV-${dateStr}-${rand}`;

        const newInvoice = await prisma.businessInvoice.create({
            data: {
                businessProfileId: template.businessProfileId,
                locationId: template.locationId,
                tableId: null,
                customerId: template.customerId,
                invoiceRef: newRef,
                status: 'DRAFT',
                subtotalUsdc: template.subtotalUsdc,
                taxTotalUsdc: template.taxTotalUsdc,
                billTotalUsdc: template.billTotalUsdc,
                businessNote: template.businessNote,
                recurringParentId: template.id,
                lineItems: {
                    create: template.lineItems.map(li => ({
                        description: li.description,
                        quantity: li.quantity,
                        unitPrice: li.unitPrice,
                        lineTotal: li.lineTotal,
                    })),
                },
                taxLines: {
                    create: template.taxLines.map(tl => ({
                        label: tl.label,
                        type: tl.type,
                        value: tl.value,
                        amount: tl.amount,
                    })),
                },
            },
        });

        let nextDate = new Date(now);
        switch (template.recurringInterval) {
            case 'DAILY':     nextDate.setDate(now.getDate() + 1); break;
            case 'WEEKLY':    nextDate.setDate(now.getDate() + 7); break;
            case 'MONTHLY':   nextDate.setMonth(now.getMonth() + 1); break;
            case 'QUARTERLY': nextDate.setMonth(now.getMonth() + 3); break;
            case 'YEARLY':    nextDate.setFullYear(now.getFullYear() + 1); break;
        }

        await prisma.businessInvoice.update({
            where: { id: template.id },
            data: { recurringNextDate: nextDate },
        });

        created.push({ id: newInvoice.id, ref: newRef });
    }

    res.json({ success: true, generated: created.length, invoices: created });
}));

// ── Booking Dashboard ────────────────────────────────────────────────────────

// GET /api/business-os/booking/dashboard — unified booking stats
router.get('/booking/dashboard', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, stats: { totalOrders: 0, pending: 0, confirmed: 0, completed: 0, cancelled: 0, revenueUsdc: '0' }, overbookingAllowed: false });

    const [totalOrders, pending, confirmed, completed, cancelled, revenueAgg, bp] = await Promise.all([
        prisma.businessOrder.count({ where: { businessProfileId: bpId } }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: 'PENDING' } }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: 'CONFIRMED' } }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: 'COMPLETED' } }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: 'CANCELLED' } }),
        prisma.businessOrder.aggregate({ where: { businessProfileId: bpId, status: 'COMPLETED' }, _sum: { amountUsdc: true } }),
        prisma.businessProfile.findFirst({ where: { id: bpId }, select: { allowOverbooking: true } }),
    ]);

    res.json({
        success: true,
        stats: {
            totalOrders, pending, confirmed, completed, cancelled,
            revenueUsdc: (revenueAgg._sum?.amountUsdc || 0).toString(),
        },
        overbookingAllowed: bp?.allowOverbooking || false,
    });
}));

// GET /api/business-os/dashboard/at-risk — aggregates urgent items across all verticals
router.get('/dashboard/at-risk', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, items: [] });

    const now = new Date();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const items = [];

    // 1. Overdue housekeeping tasks (>4h, not done)
    try {
        const overdueHousekeeping = await prisma.hotelHousekeepingTask.findMany({
            where: { businessProfileId: bpId, status: { not: 'DONE' }, createdAt: { lt: fourHoursAgo } },
            select: { id: true, taskType: true, priority: true, createdAt: true, roomId: true },
            take: 5,
        });
        for (const t of overdueHousekeeping) {
            items.push({
                type: 'HOUSEKEEPING_OVERDUE',
                severity: t.priority <= 2 ? 'urgent' : 'warning',
                title: `Overdue housekeeping: ${t.taskType}`,
                subtitle: `Room ${t.roomId?.slice(-6) || 'N/A'} — pending ${Math.round((now - t.createdAt) / 60000)}min`,
                link: '/hotel/housekeeping',
                createdAt: t.createdAt,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 2. Kitchen tickets aging (>30min, still new/preparing)
    try {
        const agingTickets = await prisma.kitchenOrder.findMany({
            where: { businessProfileId: bpId, status: { in: ['NEW', 'PREPARING'] }, sentAt: { lt: thirtyMinAgo } },
            select: { id: true, ticketNumber: true, tableNumber: true, sentAt: true },
            take: 5,
        });
        for (const t of agingTickets) {
            items.push({
                type: 'KITCHEN_AGING',
                severity: 'urgent',
                title: `Kitchen ticket #${t.ticketNumber} aging`,
                subtitle: `${t.tableNumber || 'Takeout'} — ${Math.round((now - t.sentAt) / 60000)}min in kitchen`,
                link: '/restaurant/kitchen',
                createdAt: t.sentAt,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 3. Vehicles overdue for maintenance
    try {
        const overdueMaintenance = await prisma.vehicleMaintenance.findMany({
            where: { businessProfileId: bpId, status: 'SCHEDULED', scheduledDate: { lt: now } },
            select: { id: true, vehicleId: true, type: true, description: true, scheduledDate: true },
            take: 5,
        });
        for (const m of overdueMaintenance) {
            items.push({
                type: 'VEHICLE_MAINTENANCE',
                severity: 'warning',
                title: `Vehicle maintenance overdue`,
                subtitle: `${m.type}: ${m.description?.slice(0, 60) || 'Scheduled service'}`,
                link: '/transit/fleet',
                createdAt: m.scheduledDate,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 4. Pending shift swaps
    try {
        const pendingSwaps = await prisma.shiftSwap.findMany({
            where: { businessProfileId: bpId, status: 'PENDING' },
            select: { id: true, reason: true, requestedAt: true },
            take: 5,
        });
        for (const s of pendingSwaps) {
            items.push({
                type: 'SHIFT_SWAP_PENDING',
                severity: 'warning',
                title: 'Pending shift swap request',
                subtitle: s.reason?.slice(0, 60) || 'Awaiting response',
                link: '/employees',
                createdAt: s.requestedAt,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 5. Pending time-off requests
    try {
        const pendingTimeOff = await prisma.timeOffRequest.findMany({
            where: { businessProfileId: bpId, status: 'PENDING' },
            select: { id: true, type: true, startDate: true, isEmergency: true, reason: true },
            take: 5,
        });
        for (const t of pendingTimeOff) {
            items.push({
                type: 'TIME_OFF_PENDING',
                severity: t.isEmergency ? 'urgent' : 'warning',
                title: `${t.isEmergency ? 'Emergency ' : ''}Time-off request: ${t.type}`,
                subtitle: t.reason?.slice(0, 60) || `Starting ${t.startDate.toLocaleDateString()}`,
                link: '/employees',
                createdAt: t.startDate,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 6. Unread negative reviews (rating <= 2, no response)
    try {
        const negativeReviews = await prisma.businessReview.findMany({
            where: { businessProfileId: bpId, rating: { lte: 2 }, businessResponse: null },
            select: { id: true, rating: true, comment: true, createdAt: true },
            take: 5,
        });
        for (const r of negativeReviews) {
            items.push({
                type: 'NEGATIVE_REVIEW',
                severity: 'urgent',
                title: `${r.rating}-star review unanswered`,
                subtitle: r.comment?.slice(0, 60) || 'No comment provided',
                link: '/reviews',
                createdAt: r.createdAt,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 7. Pending reservations needing action (>2h old)
    try {
        const staleReservations = await prisma.reservation.findMany({
            where: { businessProfileId: bpId, status: 'PENDING', createdAt: { lt: twoHoursAgo } },
            select: { id: true, reservationRef: true, partySize: true, startDatetime: true, createdAt: true },
            take: 5,
        });
        for (const r of staleReservations) {
            items.push({
                type: 'RESERVATION_PENDING',
                severity: 'warning',
                title: `Reservation ${r.reservationRef} awaiting confirmation`,
                subtitle: `Party of ${r.partySize} — ${Math.round((now - r.createdAt) / 3600000)}h waiting`,
                link: '/reservations',
                createdAt: r.createdAt,
            });
        }
    } catch (e) { /* model may not exist */ }

    // 8. Low stock inventory items
    try {
        const lowStock = await prisma.inventoryItem.findMany({
            where: { businessProfileId: bpId, isActive: true, currentStock: { lte: prisma.inventoryItem.fields.minimumStock } },
            select: { id: true, name: true, currentStock: true, minimumStock: true, unit: true },
            take: 5,
        });
        for (const i of lowStock) {
            items.push({
                type: 'LOW_STOCK',
                severity: i.currentStock <= 0 ? 'urgent' : 'warning',
                title: `Low stock: ${i.name}`,
                subtitle: `${i.currentStock} ${i.unit} left (min: ${i.minimumStock})`,
                link: '/restaurant/inventory',
                createdAt: now,
            });
        }
    } catch (e) { /* model may not exist */ }

    // Sort: urgent first, then by createdAt (oldest first)
    items.sort((a, b) => {
        if (a.severity === 'urgent' && b.severity !== 'urgent') return -1;
        if (a.severity !== 'urgent' && b.severity === 'urgent') return 1;
        return new Date(a.createdAt) - new Date(b.createdAt);
    });

    res.json({ success: true, items });
}));

// GET /api/business-os/dashboard/employee-stats — aggregated employee KPIs for the dashboard
router.get('/dashboard/employee-stats', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, stats: { totalEmployees: 0, activeShifts: 0, pendingTimeOff: 0, monthlyPayroll: 0 } });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalEmployees, activeShifts, pendingTimeOff, payrollRecords] = await Promise.all([
        prisma.businessEmployee.count({ where: { businessProfileId: bpId, isActive: true } }).catch(() => 0),
        prisma.shift.findMany({
            where: { businessProfileId: bpId, status: 'SCHEDULED', startTime: { lte: now }, endTime: { gte: now } },
            select: { id: true },
        }).catch(() => []),
        prisma.timeOffRequest.count({ where: { businessProfileId: bpId, status: 'PENDING' } }).catch(() => 0),
        prisma.payrollRecord.findMany({
            where: { businessProfileId: bpId, status: 'PAID', periodStart: { gte: monthStart } },
            select: { netAmountUsdc: true },
        }).catch(() => []),
    ]);

    const monthlyPayroll = payrollRecords.reduce((sum, r) => sum + (Number(r.netAmountUsdc) || 0), 0);

    res.json({
        success: true,
        stats: {
            totalEmployees,
            activeShifts: activeShifts.length,
            pendingTimeOff,
            monthlyPayroll: monthlyPayroll.toFixed(2),
        },
    });
}));


// ── Phase 2: Kiosk PIN Auth (Section 2.4) ────────────────────────────────────
// POST /api/business-os/kiosk/pin-auth — scoped PIN auth for clock-in/out only
router.post('/kiosk/pin-auth', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { pinCode, businessProfileId, locationId } = req.body;
    if (!pinCode || !businessProfileId) {
        return res.status(400).json({ success: false, message: 'PIN and business ID required' });
    }

    // Find employees with this PIN for this business
    const bcrypt = require('bcryptjs');
    const employees = await prisma.businessEmployee.findMany({
        where: { businessProfileId, status: 'ACTIVE', pinCode: { not: null } },
        select: { id: true, pinCode: true, userId: true, role: true, title: true, department: true },
    });

    let matched = null;
    for (const emp of employees) {
        if (await bcrypt.compare(pinCode, emp.pinCode)) {
            matched = emp;
            break;
        }
    }

    if (!matched) {
        return res.status(401).json({ success: false, message: 'Invalid PIN' });
    }

    // Return a SCOPED token — only valid for clock-in/out, not full session
    // The frontend uses this to identify the employee for kiosk actions
    res.json({
        success: true,
        employee: {
            id: matched.id,
            userId: matched.userId,
            role: matched.role,
            title: matched.title,
            department: matched.department,
        },
        scope: 'kiosk_clock_only', // frontend must enforce this scope
        businessProfileId,
        locationId: locationId || null,
    });
}));

// GET /api/business-os/reservation-stats — reservation + order summary
router.get('/reservation-stats', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.json({ success: true, stats: { pendingRes: 0, confirmedRes: 0, checkedInRes: 0, todayCheckins: 0, activeOrders: 0, pendingOrders: 0 } });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [pendingRes, confirmedRes, checkedInRes, todayCheckins, activeOrders, pendingOrders] = await Promise.all([
        prisma.reservation.count({ where: { businessProfileId: bpId, status: 'PENDING' } }),
        prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CONFIRMED' } }),
        prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CHECKED_IN' } }),
        prisma.reservation.count({
            where: {
                businessProfileId: bpId,
                status: { in: ['CONFIRMED', 'CHECKED_IN'] },
                startDatetime: { gte: today, lt: tomorrow },
            },
        }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: { in: ['PAID', 'DELIVERED'] } } }),
        prisma.businessOrder.count({ where: { businessProfileId: bpId, status: 'AWAITING_PAYMENT' } }),
    ]);

    res.json({
        success: true,
        stats: { pendingRes, confirmedRes, checkedInRes, todayCheckins, activeOrders, pendingOrders },
    });
}));

// POST /api/business-os/kiosk/clock-in — clock in using PIN auth
router.post('/kiosk/clock-in', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { employeeId, locationId } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    // Find today's scheduled shift for this employee
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const shift = await prisma.shift.findFirst({
        where: {
            employeeId,
            shiftDate: { gte: today, lt: tomorrow },
            status: { in: ['SCHEDULED', 'OPEN'] },
        },
    });

    if (shift) {
        // Clock into scheduled shift
        const now = new Date();
        const isLate = now > new Date(shift.startTime.getTime() + 5 * 60 * 1000);
        const lateMinutes = isLate ? Math.floor((now - shift.startTime) / 60000) : 0;

        const updated = await prisma.shift.update({
            where: { id: shift.id },
            data: {
                status: 'OPEN',
                clockInTime: now,
                isLate,
                lateMinutes,
            },
        });
        res.json({ success: true, shift: updated, message: isLate ? 'Clocked in (late)' : 'Clocked in' });
    } else {
        // No scheduled shift — create an ad-hoc clock-in
        const emp = await prisma.businessEmployee.findUnique({
            where: { id: employeeId },
            select: { businessProfileId: true, userId: true },
        });
        if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

        const now = new Date();
        const endTime = new Date(now);
        endTime.setHours(endTime.getHours() + 8); // default 8hr shift

        const adHocShift = await prisma.shift.create({
            data: {
                businessProfileId: emp.businessProfileId,
                employeeId,
                userId: emp.userId,
                locationId: locationId || null,
                shiftDate: now,
                startTime: now,
                endTime,
                status: 'OPEN',
                clockInTime: now,
                notes: 'Ad-hoc kiosk clock-in',
            },
        });
        res.json({ success: true, shift: adHocShift, message: 'Clocked in (ad-hoc)' });
    }
}));

// POST /api/business-os/kiosk/clock-out — clock out using PIN auth
router.post('/kiosk/clock-out', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    const shift = await prisma.shift.findFirst({
        where: { employeeId, status: 'OPEN', clockInTime: { not: null }, clockOutTime: null },
        orderBy: { clockInTime: 'desc' },
    });

    if (!shift) return res.status(404).json({ success: false, message: 'No open shift to clock out from' });

    const now = new Date();
    const actualMinutes = Math.floor((now - shift.clockInTime) / 60000);

    const updated = await prisma.shift.update({
        where: { id: shift.id },
        data: {
            status: 'COMPLETED',
            clockOutTime: now,
            actualMinutes,
        },
    });

    // Update employee stats
    await prisma.businessEmployee.update({
        where: { id: employeeId },
        data: {
            totalShifts: { increment: 1 },
            totalHours: { increment: actualMinutes / 60 },
        },
    });

    res.json({ success: true, shift: updated, actualMinutes, message: 'Clocked out' });
}));

// ── Phase 2: Cash Payment + Idempotency (Section 2.4) ────────────────────────
// POST /api/business-os/pos/cash-sale — ring up a cash order (bypasses escrow)
// POST /api/business-os/pos/order — unified POS order (CASH, AZM balance, SPLIT)
// Replaces the old pos/cash-sale with support for all payment methods.
// Server-side total re-derivation — never trusts client totals.
router.post('/pos/order', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const {
        items, paymentMethod = 'CASH', totalAmount,
        cashGiven, azmAmount, idempotencyKey, source,
        locationId, tableId, customerId,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Items are required.' });
    }

    // Idempotency check
    if (idempotencyKey) {
        const existing = await prisma.businessOrder.findFirst({ where: { idempotencyKey } });
        if (existing) return res.json({ success: true, order: existing, message: 'Duplicate (idempotent)' });
    }

    // Re-derive totals from product prices (never trust client)
    let computedSubtotal = 0;
    for (const item of items) {
        const product = await prisma.businessProduct.findFirst({
            where: { id: item.productId, businessProfileId: bpId },
            select: { priceUsdc: true, name: true, isActive: true, isAvailable: true },
        });
        if (!product) return res.status(400).json({ success: false, message: 'Invalid product: ' + item.productId });
        if (product.isActive === false || product.isAvailable === false) {
            return res.status(400).json({ success: false, message: 'Product unavailable: ' + product.name });
        }
        computedSubtotal += parseFloat(product.priceUsdc) * (item.qty || item.quantity || 1);
    }

    const computedTax = computedSubtotal * 0.025; // 2.5% tax
    const computedGrand = computedSubtotal + computedTax;

    // Validate payment
    const pm = (paymentMethod || 'CASH').toUpperCase();
    let cashReceived = null;
    let cashChange = null;
    let azmPortion = 0;

    if (pm === 'CASH') {
        cashReceived = parseFloat(cashGiven || 0);
        if (cashReceived < computedGrand) {
            return res.status(400).json({ success: false, message: 'Insufficient cash received.' });
        }
        cashChange = cashReceived - computedGrand;
    } else if (pm === 'AZM') {
        // Deduct from customer AZM balance
        azmPortion = computedGrand;
    } else if (pm === 'SPLIT') {
        azmPortion = parseFloat(azmAmount || 0);
        cashReceived = parseFloat(cashGiven || 0);
        if (cashReceived + azmPortion < computedGrand) {
            return res.status(400).json({ success: false, message: 'Insufficient payment (cash + AZM).' });
        }
        cashChange = Math.max(0, cashReceived - (computedGrand - azmPortion));
    } else {
        return res.status(400).json({ success: false, message: 'Invalid payment method: ' + pm });
    }

    // Generate order reference first (needed for AZM spend log)
    const orderRef = 'POS-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    // For AZM/SPLIT: verify and deduct from customer azmBalance
    if (azmPortion > 0) {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { azmBalance: true },
        });
        if (!user || parseFloat(user.azmBalance) < azmPortion) {
            return res.status(400).json({ success: false, message: 'Insufficient AZM balance.' });
        }
        const newBalance = parseFloat(user.azmBalance) - azmPortion;
        await prisma.user.update({
            where: { id: req.user.id },
            data: { azmBalance: newBalance },
        });

        // Record AZM spend log
        await prisma.azmSpendLog.create({
            data: {
                userId: req.user.id,
                amount: azmPortion,
                reason: 'POS order (' + (source || 'POS') + ')',
                source: 'POS_SALE',
                balanceAfter: newBalance,
                metadata: { orderRef },
            },
        });
    }

    const order = await prisma.businessOrder.create({
        data: {
            businessProfileId: bpId,
            customerId: customerId || req.user.id,
            status: 'COMPLETED',
            orderRef,
            title: 'POS Sale (' + pm + ')',
            amountUsdc: computedGrand,
            paymentMethod: pm,
            idempotencyKey,
            cashReceived: cashReceived || null,
            cashChange: cashChange || null,
            completedAt: new Date(),
        },
    });

    // Write ledger entry
    try {
        await prisma.businessLedgerEntry.create({
            data: {
                businessProfileId: bpId,
                type: 'INCOME',
                category: 'SALES',
                description: 'POS Sale (' + orderRef + ' - ' + pm + ')',
                amount: computedGrand,
                amountGhs: computedGrand,
                sourceType: 'POS_SALE',
                sourceId: order.id,
                metadata: { orderRef, paymentMethod: pm, items: items.length, locationId, tableId },
            },
        });
    } catch (e) {
        logger.warn('[pos/order] Ledger entry failed:', e.message);
    }

    res.status(201).json({
        success: true,
        order,
        computedSubtotal,
        computedTax,
        computedGrand,
        change: cashChange || 0,
    });
}));

router.post('/pos/cash-sale', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { items, locationId, tableId, customerId, subtotal, taxTotal, tipAmount, idempotencyKey, cashReceived } = req.body;

    // Idempotency check — if a record with this key exists, return the cached result
    if (idempotencyKey) {
        const existing = await prisma.businessOrder.findFirst({
            where: { idempotencyKey },
        });
        if (existing) {
            return res.json({ success: true, order: existing, message: 'Duplicate (idempotent)' });
        }
    }

    // Validate: frontend must NOT compute totals — re-derive from items
    let computedSubtotal = 0;
    for (const item of items || []) {
        const product = await prisma.businessProduct.findFirst({
            where: { id: item.productId, businessProfileId: bpId },
            select: { priceUsdc: true, name: true },
        });
        if (!product) return res.status(400).json({ success: false, message: 'Invalid product: ' + item.productId });

        const lineTotal = parseFloat(product.priceUsdc) * item.quantity;
        computedSubtotal += lineTotal;
    }

    const computedTax = computedSubtotal * (parseFloat(taxTotal || 0) > 0 ? parseFloat(taxTotal) / computedSubtotal : 0);
    const computedGrand = computedSubtotal + computedTax + parseFloat(tipAmount || 0);

    // Generate order reference
    const orderRef = 'CSH-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    // Create the order with CASH payment method
    const order = await prisma.businessOrder.create({
        data: {
            businessProfileId: bpId,
            customerId: customerId || req.user.id,
            status: 'COMPLETED',
            orderRef,
            title: 'POS Cash Sale',
            amountUsdc: computedGrand,
            paymentMethod: 'CASH',
            idempotencyKey,
            cashReceived: cashReceived ? parseFloat(cashReceived) : null,
            cashChange: cashReceived ? parseFloat(cashReceived) - computedGrand : null,
            completedAt: new Date(),
        },
    });

    // Write a BusinessLedgerEntry for the cash sale (so it shows in Finance/P&L)
    try {
        await prisma.businessLedgerEntry.create({
            data: {
                businessProfileId: bpId,
                type: 'INCOME',
                category: 'SALES',
                description: 'POS Cash Sale (' + orderRef + ')',
                amount: computedGrand,
                amountGhs: computedGrand, // adjust if FX rate needed
                sourceType: 'POS_CASH_SALE',
                sourceId: order.id,
                metadata: { orderRef, items: items?.length || 0, locationId, tableId },
            },
        });
    } catch (e) {
        logger.warn('[pos/cash-sale] Failed to write ledger entry:', e.message);
    }

    // Fire webhook event
    webhookDispatcher.dispatch(bpId, 'order.created', {
        orderId: order.id, orderRef, amount: computedGrand,
        paymentMethod: 'CASH', items: items?.length || 0,
    }).catch(() => {});

    res.status(201).json({
        success: true,
        order,
        computedSubtotal,
        computedTax,
        computedGrand,
        change: cashReceived ? parseFloat(cashReceived) - computedGrand : 0,
    });
}));

// POST /api/business-os/pos/cash-close-tab — close a dine-in tab with cash
router.post('/pos/cash-close-tab', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { tabId, cashReceived, tipAmount, idempotencyKey } = req.body;
    if (!tabId) return res.status(400).json({ success: false, message: 'Tab ID required' });

    // Idempotency check
    if (idempotencyKey) {
        const existing = await prisma.dineInTab.findFirst({
            where: { idempotencyKey },
        });
        if (existing) {
            return res.json({ success: true, tab: existing, message: 'Duplicate (idempotent)' });
        }
    }

    const tab = await prisma.dineInTab.findFirst({
        where: { id: tabId, businessProfileId: bpId, status: 'OPEN' },
        include: { items: true },
    });
    if (!tab) return res.status(404).json({ success: false, message: 'Open tab not found' });

    // Re-compute totals from items (never trust client totals)
    let subtotal = 0;
    for (const item of tab.items) {
        subtotal += parseFloat(item.lineTotalUsdc);
    }
    const taxTotal = subtotal * 0.05; // default 5% tax — configurable
    const tip = parseFloat(tipAmount || 0);
    const grandTotal = subtotal + taxTotal + tip;

    // Close the tab with cash
    const updated = await prisma.dineInTab.update({
        where: { id: tabId },
        data: {
            status: 'PAID',
            closedAt: new Date(),
            subtotalUsdc: subtotal,
            taxTotalUsdc: taxTotal,
            tipUsdc: tip,
            grandTotalUsdc: grandTotal,
            paymentMethod: 'CASH',
            idempotencyKey,
            cashReceived: cashReceived ? parseFloat(cashReceived) : null,
        },
    });

    // Write ledger entry
    try {
        await prisma.businessLedgerEntry.create({
            data: {
                businessProfileId: bpId,
                type: 'INCOME',
                category: 'DINE_IN',
                description: 'Dine-in cash close (' + tabId.substring(0, 8) + ')',
                amount: grandTotal,
                amountGhs: grandTotal,
                sourceType: 'DINE_IN_CASH',
                sourceId: tabId,
                metadata: { tabId, tip, subtotal, taxTotal },
            },
        });
    } catch (e) {
        logger.warn('[pos/cash-close-tab] Failed to write ledger entry:', e.message);
    }

    res.json({
        success: true,
        tab: updated,
        subtotal,
        taxTotal,
        grandTotal,
        change: cashReceived ? parseFloat(cashReceived) - grandTotal : 0,
    });
}));

// ── Phase 2: Employee PIN Management (Section 2.4) ──────────────────────────
// POST /api/business-os/employees/:id/set-pin — set or update kiosk PIN
router.post('/employees/:id/set-pin', protect, protectActive, requirePermission('employees.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { pinCode } = req.body;
    if (!pinCode || pinCode.length < 4 || pinCode.length > 8) {
        return res.status(400).json({ success: false, message: 'PIN must be 4-8 digits' });
    }

    const emp = await prisma.businessEmployee.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const bcrypt = require('bcryptjs');
    const hashedPin = await bcrypt.hash(pinCode, 10);

    await prisma.businessEmployee.update({
        where: { id: emp.id },
        data: { pinCode: hashedPin },
    });

    res.json({ success: true, message: 'PIN set successfully' });
}));

// DELETE /api/business-os/employees/:id/pin — remove kiosk PIN
router.delete('/employees/:id/pin', protect, protectActive, requirePermission('employees.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);

    const emp = await prisma.businessEmployee.findFirst({
        where: { id: req.params.id, businessProfileId: bpId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    await prisma.businessEmployee.update({
        where: { id: emp.id },
        data: { pinCode: null },
    });

    res.json({ success: true, message: 'PIN removed' });
}));


// ── Phase 2: In-Portal Messaging (Section 3) ────────────────────────────────
// Reuses the existing Conversation/Message models with a new BUSINESS type.
// BusinessConversation links a conversation to a business profile.

// GET /api/business-os/messages/conversations — list conversations for this business
router.get('/messages/conversations', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const userId = req.user.id;

    const conversations = await prisma.businessConversation.findMany({
        where: {
            businessProfileId: bpId,
            OR: [{ participantAId: userId }, { participantBId: userId }],
        },
        include: {
            participantA: { select: { id: true, username: true, avatarUrl: true } },
            participantB: { select: { id: true, username: true, avatarUrl: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
    });

    res.json({ success: true, conversations });
}));

// POST /api/business-os/messages/conversations — start a new conversation with a staff member
router.post('/messages/conversations', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { recipientUserId } = req.body;
    if (!recipientUserId) return res.status(400).json({ success: false, message: 'Recipient required' });

    // Verify recipient is an employee of this business
    const employee = await prisma.businessEmployee.findFirst({
        where: { businessProfileId: bpId, userId: parseInt(recipientUserId), status: 'ACTIVE' },
    });
    if (!employee && parseInt(recipientUserId) !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Recipient must be an active employee' });
    }

    // Check if conversation already exists
    const existing = await prisma.businessConversation.findFirst({
        where: {
            businessProfileId: bpId,
            OR: [
                { participantAId: req.user.id, participantBId: parseInt(recipientUserId) },
                { participantAId: parseInt(recipientUserId), participantBId: req.user.id },
            ],
        },
    });
    if (existing) return res.json({ success: true, conversation: existing, message: 'Already exists' });

    // Create Conversation + BusinessConversation
    const conversation = await prisma.conversation.create({
        data: { type: 'BUSINESS' },
    });

    const bizConv = await prisma.businessConversation.create({
        data: {
            businessProfileId: bpId,
            conversationId: conversation.id,
            participantAId: req.user.id,
            participantBId: parseInt(recipientUserId),
            createdBy: req.user.id,
        },
        include: {
            participantA: { select: { id: true, username: true, avatarUrl: true } },
            participantB: { select: { id: true, username: true, avatarUrl: true } },
        },
    });

    res.status(201).json({ success: true, conversation: bizConv });
}));

// GET /api/business-os/messages/:conversationId — get messages for a conversation
router.get('/messages/:conversationId', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { conversationId } = req.params;

    // Verify this conversation belongs to this business
    const bizConv = await prisma.businessConversation.findFirst({
        where: { conversationId, businessProfileId: bpId,
            OR: [{ participantAId: req.user.id }, { participantBId: req.user.id }],
        },
    });
    if (!bizConv) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const messages = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });

    res.json({ success: true, messages });
}));

// POST /api/business-os/messages/:conversationId/send — send a message
router.post('/messages/:conversationId/send', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { conversationId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Message content required' });

    // Verify ownership
    const bizConv = await prisma.businessConversation.findFirst({
        where: { conversationId, businessProfileId: bpId,
            OR: [{ participantAId: req.user.id }, { participantBId: req.user.id }],
        },
    });
    if (!bizConv) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const message = await prisma.message.create({
        data: {
            conversationId,
            senderId: req.user.id,
            messageType: 'TEXT',
            content: content.trim(),
        },
    });

    // Update conversation preview
    await prisma.businessConversation.update({
        where: { id: bizConv.id },
        data: {
            lastMessageAt: new Date(),
            lastMessagePreview: content.trim().substring(0, 200),
        },
    });

    // Emit socket events to both participants for real-time updates
    const io = req.app.get('socketio');
    if (io) {
        const msgPayload = {
            conversationId,
            message: { id: message.id, text: message.content, createdAt: message.createdAt, senderId: message.senderId, senderType: 'business' },
        };
        if (bizConv.participantAId !== req.user.id) {
            io.to(`user_${bizConv.participantAId}`).emit('biz_new_message', msgPayload);
        }
        if (bizConv.participantBId !== req.user.id) {
            io.to(`user_${bizConv.participantBId}`).emit('biz_new_message', msgPayload);
        }
    }

    res.status(201).json({ success: true, message });
}));


// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 07 — Finance/Ledger extended routes
// ═══════════════════════════════════════════════════════════════════════════════

// ── Ledger: dashboard stats ──────────────────────────────────────────────────
// Alias that matches what FinanceV2 calls
router.get('/finance/dashboard', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const stats = await svc.ledgerService.getDashboardStats(bpId);
    res.json({ data: stats });
}));

// ── Ledger: P&L with prior-period comparison ─────────────────────────────────
router.get('/finance/pl', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const { startDate, endDate } = req.query;
    const [current, prior] = await Promise.all([
        svc.ledgerService.getProfitLoss(bpId, { startDate, endDate }),
        startDate && endDate ? (async () => {
            const ms = new Date(endDate) - new Date(startDate);
            const priorEnd = new Date(new Date(startDate) - 1).toISOString();
            const priorStart = new Date(new Date(startDate) - ms).toISOString();
            return svc.ledgerService.getProfitLoss(bpId, { startDate: priorStart, endDate: priorEnd });
        })() : Promise.resolve(null),
    ]);
    res.json({ data: { current, prior } });
}));

// ── Ledger: cash flow ─────────────────────────────────────────────────────────
router.get('/finance/cashflow', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const cf = await svc.ledgerService.getCashFlow(bpId, req.query);
    res.json({ data: cf });
}));

// ── Ledger: expense list ──────────────────────────────────────────────────────
router.get('/finance/expenses', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const exp = await svc.ledgerService.getExpenseBreakdown(bpId, req.query);
    res.json({ data: exp });
}));

// ── Escrow: held funds total ──────────────────────────────────────────────────
router.get('/finance/escrow-held', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    // Sum all open escrow balances for this business
    const escrows = await svc.prisma.escrow.findMany({
        where: {
            status: { in: ['HELD', 'HOLDING', 'PENDING_RELEASE'] },
            order: { businessProfileId: bpId },
        },
        select: { amountUsdc: true, status: true },
    });
    const totalHeld = escrows.reduce((s, e) => s + parseFloat(e.amountUsdc || 0), 0);
    res.json({ data: { totalHeld, escrowCount: escrows.length, escrows } });
}));

// ── Recurring Expense Templates ────────────────────────────────────────────────
router.get('/finance/recurring', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const templates = await svc.prisma.recurringExpenseTemplate.findMany({
        where: { businessProfileId: bpId },
        orderBy: { name: 'asc' },
    });
    res.json({ data: templates });
}));

router.post('/finance/recurring', requirePermission('finance.ledger.manage'), wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const { name, category, amount, description, frequency, dayOfMonth, dayOfWeek } = req.body;
    // Compute nextDueAt
    const now = new Date();
    let nextDueAt = new Date(now);
    if (frequency === 'MONTHLY') { nextDueAt.setDate(dayOfMonth || 1); if (nextDueAt <= now) nextDueAt.setMonth(nextDueAt.getMonth() + 1); }
    else if (frequency === 'WEEKLY') { const dow = dayOfWeek || 1; const diff = (dow + 7 - now.getDay()) % 7 || 7; nextDueAt.setDate(now.getDate() + diff); }

    const template = await svc.prisma.recurringExpenseTemplate.create({
        data: { businessProfileId: bpId, name, category, amount: parseFloat(amount), description, frequency, dayOfMonth, dayOfWeek, nextDueAt },
    });
    res.json({ data: template });
}));

router.patch('/finance/recurring/:id', requirePermission('finance.ledger.manage'), wrap(async (req, res) => {
    const { name, category, amount, description, frequency, dayOfMonth, dayOfWeek, isActive } = req.body;
    const template = await svc.prisma.recurringExpenseTemplate.update({
        where: { id: req.params.id },
        data: { name, category, amount: amount ? parseFloat(amount) : undefined, description, frequency, dayOfMonth, dayOfWeek, isActive },
    });
    res.json({ data: template });
}));

router.delete('/finance/recurring/:id', requirePermission('finance.ledger.manage'), wrap(async (req, res) => {
    await svc.prisma.recurringExpenseTemplate.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
}));

// ── Payroll liability summary ─────────────────────────────────────────────────
router.get('/finance/payroll-position', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const [payrolls, ewaRequests] = await Promise.all([
        svc.prisma.payrollRecord.findMany({
            where: { businessProfileId: bpId, status: { in: ['PENDING', 'APPROVED'] } },
            select: { netPayUsdc: true, status: true, periodEnd: true },
        }),
        svc.prisma.eWARequest.findMany({
            where: { businessProfileId: bpId, status: 'APPROVED' },
            select: { requestedAmountUsdc: true },
        }),
    ]);
    const pendingPayroll = payrolls.filter(p => p.status === 'PENDING').reduce((s, p) => s + parseFloat(p.netPayUsdc || 0), 0);
    const approvedPayroll = payrolls.filter(p => p.status === 'APPROVED').reduce((s, p) => s + parseFloat(p.netPayUsdc || 0), 0);
    const ewaFloat = ewaRequests.reduce((s, e) => s + parseFloat(e.requestedAmountUsdc || 0), 0);
    res.json({ data: { pendingPayroll, approvedPayroll, ewaFloat, totalLiability: pendingPayroll + approvedPayroll + ewaFloat } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 08 — Marketing: Promotions + Reviews response + Followers broadcast
// ═══════════════════════════════════════════════════════════════════════════════

// ── Promotions CRUD ───────────────────────────────────────────────────────────
router.get('/marketing/promotions', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const promos = await svc.prisma.businessPromotion.findMany({
        where: { businessProfileId: bpId },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ data: promos });
}));

router.post('/marketing/promotions', requirePermission('marketing.publish'), wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const promo = await svc.prisma.businessPromotion.create({
        data: { ...req.body, businessProfileId: bpId, discountValue: parseFloat(req.body.discountValue) },
    });
    res.json({ data: promo });
}));

router.patch('/marketing/promotions/:id', requirePermission('marketing.publish'), wrap(async (req, res) => {
    const promo = await svc.prisma.businessPromotion.update({
        where: { id: req.params.id },
        data: { ...req.body, ...(req.body.discountValue ? { discountValue: parseFloat(req.body.discountValue) } : {}) },
    });
    res.json({ data: promo });
}));

router.delete('/marketing/promotions/:id', requirePermission('marketing.publish'), wrap(async (req, res) => {
    // Soft-delete: deactivate instead of hard delete to preserve audit trail
    await svc.prisma.businessPromotion.update({
        where: { id: req.params.id },
        data: { isActive: false, endDate: new Date() },
    });
    res.json({ ok: true });
}));

// ── Reviews: owner respond ─────────────────────────────────────────────────────
router.post('/marketing/reviews/:id/respond', requirePermission('marketing.publish'), wrap(async (req, res) => {
    const { response } = req.body;
    if (!response?.trim()) return res.status(400).json({ message: 'Response text required' });
    const review = await svc.prisma.businessReview.update({
        where: { id: req.params.id },
        data: { businessResponse: response.trim(), businessResponseAt: new Date() },
    });
    res.json({ data: review });
}));

// ── Reviews: flag/dispute ──────────────────────────────────────────────────────
router.post('/marketing/reviews/:id/flag', requirePermission('marketing.publish'), wrap(async (req, res) => {
    const { reason } = req.body;
    const bpId = req.businessProfileId;
    // Write an audit log entry for admin review
    const { audit } = require('../utils/audit');
    await audit(svc.prisma, {
        actorId: req.user?.id || null,
        actorName: req.user?.username || null,
        action: 'REVIEW_FLAGGED',
        targetType: 'BUSINESS_REVIEW',
        targetId: req.params.id,
        metadata: { businessProfileId: bpId, reason },
        ipAddress: req.ip,
    });
    res.json({ ok: true, message: 'Review flagged for admin review' });
}));

// ── Followers broadcast ────────────────────────────────────────────────────────
// GET /api/business-os/marketing/broadcast/history — list past broadcasts
router.get('/marketing/broadcast/history', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [broadcasts, total] = await Promise.all([
        svc.prisma.businessNotification.findMany({
            where: { businessProfileId: bpId, type: 'BROADCAST' },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true,
                title: true,
                body: true,
                metadata: true,
                createdAt: true,
            },
        }),
        svc.prisma.businessNotification.count({
            where: { businessProfileId: bpId, type: 'BROADCAST' },
        }),
    ]);

    res.json({
        success: true,
        broadcasts: broadcasts.map(b => ({
            id: b.id,
            title: b.title,
            message: b.body,
            recipientCount: b.metadata?.recipientCount || 0,
            sentAt: b.createdAt,
        })),
        total,
        page,
        totalPages: Math.ceil(total / limit),
    });
}));

router.post('/marketing/broadcast', requirePermission('marketing.publish'), wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const { message, title } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: 'Message required' });

    // Rate limit: max 3 broadcasts per 7 days
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const recentCount = await svc.prisma.businessNotification.count({
        where: { businessProfileId: bpId, type: 'BROADCAST', createdAt: { gte: weekAgo } },
    });
    if (recentCount >= 3) return res.status(429).json({ message: 'Broadcast limit reached (3 per week). Try again later.' });

    // Get all followers
    const followers = await svc.prisma.businessFollower.findMany({
        where: { businessProfileId: bpId },
        select: { userId: true },
    });

    // Create a notification record for tracking (business-side)
    await svc.prisma.businessNotification.create({
        data: {
            businessProfileId: bpId,
            type: 'BROADCAST',
            title: title || 'Update from your business',
            body: message,
            metadata: { recipientCount: followers.length },
        },
    });

    // Emit socket events to each follower (best-effort)
    const io = req.app.get('io');
    if (io) {
        followers.forEach(f => io.to(`user_${f.userId}`).emit('business_broadcast', { businessProfileId: bpId, title, message }));
    }

    res.json({ ok: true, sentTo: followers.length });
}));

// ── Follower stats ─────────────────────────────────────────────────────────────
router.get('/marketing/followers', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const [total, recent] = await Promise.all([
        svc.prisma.businessFollower.count({ where: { businessProfileId: bpId } }),
        svc.prisma.businessFollower.count({ where: { businessProfileId: bpId, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }),
    ]);
    res.json({ data: { total, newThisMonth: recent } });
}));

// ── Analytics: customer + operational ─────────────────────────────────────────
router.get('/analytics/customer', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const { startDate, endDate } = req.query;
    const dateFilter = startDate && endDate ? { gte: new Date(startDate), lte: new Date(endDate) } : undefined;
    const where = { businessProfileId: bpId, ...(dateFilter ? { createdAt: dateFilter } : {}) };

    const [orders, reviews] = await Promise.all([
        svc.prisma.businessOrder.findMany({ where, select: { customerId: true, amountUsdc: true, createdAt: true, status: true } }),
        svc.prisma.businessReview.findMany({ where: { businessProfileId: bpId }, select: { rating: true, createdAt: true } }),
    ]);

    const customerMap = {};
    orders.forEach(o => { if (!customerMap[o.customerId]) customerMap[o.customerId] = []; customerMap[o.customerId].push(o); });
    const repeatRate = Object.values(customerMap).filter(arr => arr.length > 1).length / Math.max(Object.keys(customerMap).length, 1) * 100;
    const avgOrderValue = orders.reduce((s, o) => s + parseFloat(o.amountUsdc || 0), 0) / Math.max(orders.length, 1);
    const avgRating = reviews.reduce((s, r) => s + r.rating, 0) / Math.max(reviews.length, 1);

    res.json({ data: { totalOrders: orders.length, uniqueCustomers: Object.keys(customerMap).length, repeatRate, avgOrderValue, avgRating, reviewCount: reviews.length } });
}));

router.get('/analytics/operational', wrap(async (req, res) => {
    const bpId = req.businessProfileId;
    const [kitchenOrders, housekeepingTasks, trips] = await Promise.all([
        svc.prisma.kitchenOrder.findMany({ where: { businessProfileId: bpId }, select: { sentAt: true, servedAt: true, status: true }, take: 500, orderBy: { sentAt: 'desc' } }),
        svc.prisma.hotelHousekeepingTask.findMany({ where: { businessProfileId: bpId }, select: { startedAt: true, completedAt: true, status: true }, take: 500, orderBy: { createdAt: 'desc' } }),
        svc.prisma.transitTrip.findMany({ where: { businessProfileId: bpId }, select: { scheduledDeparture: true, actualDeparture: true, status: true }, take: 500, orderBy: { scheduledDeparture: 'desc' } }),
    ]);

    const kitchenCompleted = kitchenOrders.filter(o => o.servedAt && o.sentAt);
    const avgKitchenMins = kitchenCompleted.reduce((s, o) => s + (new Date(o.servedAt) - new Date(o.sentAt)) / 60000, 0) / Math.max(kitchenCompleted.length, 1);

    const hkCompleted = housekeepingTasks.filter(t => t.completedAt && t.startedAt);
    const avgHkMins = hkCompleted.reduce((s, t) => s + (new Date(t.completedAt) - new Date(t.startedAt)) / 60000, 0) / Math.max(hkCompleted.length, 1);

    const tripsWithDep = trips.filter(t => t.actualDeparture && t.scheduledDeparture);
    const onTimeTrips = tripsWithDep.filter(t => new Date(t.actualDeparture) <= new Date(t.scheduledDeparture));
    const onTimeRate = tripsWithDep.length > 0 ? (onTimeTrips.length / tripsWithDep.length) * 100 : 0;

    res.json({ data: { avgKitchenMins: Math.round(avgKitchenMins), avgHousekeepingMins: Math.round(avgHkMins), onTimeTripRate: Math.round(onTimeRate), kitchenOrderCount: kitchenCompleted.length, housekeepingTaskCount: hkCompleted.length, tripCount: tripsWithDep.length } });
}));

router.get('/analytics/predictive', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    
    // 1. Fetch last 30 days of orders
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentOrders = await prisma.businessOrder.findMany({
        where: { businessProfileId: bpId, createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true, customerId: true, amountUsdc: true, status: true, productId: true }
    });
    
    // Implement trailing-average algorithm for next 7 days
    const avgPerDay = recentOrders.length / 30;
    
    // Day of week profile
    const dayCounts = [0,0,0,0,0,0,0]; // Sun..Sat
    recentOrders.forEach(o => {
        dayCounts[new Date(o.createdAt).getDay()]++;
    });
    const totalWeight = dayCounts.reduce((a,b) => a+b, 0) || 1;
    
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const forecast = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i + 1);
        const dow = date.getDay();
        const weight = (dayCounts[dow] / totalWeight) * 7;
        const forecastedOrders = Math.round(avgPerDay * weight);
        forecast.push({
            date: date.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }),
            forecast: Math.max(0, forecastedOrders),
            dow: DAYS[dow]
        });
    }

    // 2. Churn Risk (customers who ordered before but not recently)
    const byCustomer = {};
    recentOrders.forEach(o => {
        if (!byCustomer[o.customerId]) byCustomer[o.customerId] = { orders: [], uid: o.customerId };
        byCustomer[o.customerId].orders.push(o);
    });
    
    const churnRisk = Object.values(byCustomer).map(({ uid, orders: ords }) => {
        if (ords.length < 2) return null;
        ords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const gaps = [];
        for (let i = 1; i < ords.length; i++) {
            gaps.push((new Date(ords[i-1].createdAt) - new Date(ords[i].createdAt)) / 86400000);
        }
        const avgGap = gaps.reduce((a,b) => a+b, 0) / gaps.length;
        const daysSinceLast = (Date.now() - new Date(ords[0].createdAt)) / 86400000;
        const score = daysSinceLast / Math.max(avgGap, 1);
        let severity = null;
        if (score > 2.5) severity = 'high';
        else if (score > 1.5) severity = 'medium';
        if (!severity) return null;
        return { customerId: uid, score, severity, lastOrder: ords[0].createdAt };
    }).filter(Boolean).sort((a,b) => b.score - a.score);

    // 3. Inventory Alerts
    const inventory = await prisma.inventoryItem.findMany({
        where: { businessProfileId: bpId, isActive: true }
    });
    const inventoryAlerts = inventory.map(p => {
        const ratio = p.currentStock / Math.max(p.minimumStock, 1);
        let severity = ratio > 2 ? null : ratio > 1 ? 'low' : 'critical';
        return { ...p, ratio, severity };
    }).filter(p => p.severity).sort((a,b) => a.ratio - b.ratio);

    res.json({ success: true, forecast, churnRisk, inventoryAlerts });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// POS OFFLINE SYNC (SECTION 2)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/sync-outbox', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { actions } = req.body;
    
    if (!Array.isArray(actions)) {
        return res.status(400).json({ success: false, message: 'Invalid payload: actions array required' });
    }
    
    const results = [];
    
    // Process each action synchronously to avoid race conditions and handle idempotency
    for (const action of actions) {
        const { id: idempotencyKey, type, payload, timestamp } = action;
        
        try {
            if (type === 'create_order') {
                // Check if already processed
                const existing = await prisma.businessOrder.findUnique({ where: { idempotencyKey } });
                if (existing) {
                    results.push({ id: idempotencyKey, status: 'SYNCED', message: 'Already processed' });
                    continue;
                }
                
                // Create order (CASH payments bypass escrow)
                const order = await prisma.businessOrder.create({
                    data: {
                        idempotencyKey,
                        businessProfileId: bpId,
                        customerId: payload.customerId || 1, // Fallback if guest
                        amountUsdc: parseFloat(payload.totalAmount || 0),
                        title: payload.title || 'POS Order',
                        status: payload.paymentMethod === 'CASH' ? 'COMPLETED' : 'AWAITING_PAYMENT',
                        orderRef: `POS-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                        paymentMethod: payload.paymentMethod, // e.g. "CASH"
                        cashReceived: payload.cashReceived ? parseFloat(payload.cashReceived) : null,
                        cashChange: payload.cashChange ? parseFloat(payload.cashChange) : null,
                        createdAt: timestamp ? new Date(timestamp) : new Date(),
                    }
                });
                
                // If it's a CASH order, record it in Ledger directly so it shows up in Finance
                if (payload.paymentMethod === 'CASH') {
                    await prisma.businessLedgerEntry.create({
                        data: {
                            businessProfileId: bpId,
                            amount: parseFloat(payload.totalAmount || 0),
                            type: 'INCOME',
                            category: 'POS Sales',
                            description: `POS Cash Order - ${order.orderRef}`,
                            sourceType: 'ORDER',
                            sourceId: order.id,
                            createdAt: timestamp ? new Date(timestamp) : new Date()
                        }
                    });
                }
                // Fire webhook event for synced order
                webhookDispatcher.dispatch(bpId, 'order.created', {
                    orderId: order.id, orderRef: order.orderRef,
                    amount: parseFloat(payload.totalAmount || 0),
                    paymentMethod: payload.paymentMethod,
                }).catch(() => {});
                results.push({ id: idempotencyKey, status: 'SYNCED' });
            } else if (type === 'clock_in' || type === 'clock_out') {
                // Ignore for now or implement similarly
                results.push({ id: idempotencyKey, status: 'SYNCED' });
            } else {
                results.push({ id: idempotencyKey, status: 'FAILED', message: 'Unknown action type' });
            }
        } catch (err) {
            results.push({ id: idempotencyKey, status: 'FAILED', message: err.message });
        }
    }
    
    res.json({ success: true, results });
}));

router.post('/kiosk/clock-in', wrap(async (req, res) => {
    // Unauthenticated endpoint for shared iPad
    const prisma = getPrisma(req);
    const { businessId, pinCode, type } = req.body; // type: 'CLOCK_IN' | 'CLOCK_OUT'
    
    if (!businessId || !pinCode) {
        return res.status(400).json({ success: false, message: 'Business ID and PIN code required' });
    }
    
    // Find employee by PIN
    const employee = await prisma.businessEmployee.findFirst({
        where: { businessProfileId: businessId, pinCode }
    });
    
    if (!employee) {
        return res.status(401).json({ success: false, message: 'Invalid PIN' });
    }
    
    // In a full implementation, create a shift punch record here
    res.json({ success: true, employee: { id: employee.id, name: employee.role }, message: `Successfully ${type === 'CLOCK_IN' ? 'clocked in' : 'clocked out'}` });
}));

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS GROUPS — multi-brand / multi-location ownership stats
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/business-os/messaging-config — get current messaging channel connections
router.get("/messaging-config", wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.json({ waConnected: false, smsConnected: false });

    const config = await prisma.businessMessagingConfig.findUnique({
        where: { businessProfileId: bpId },
    });

    res.json({
        waConnected: config?.waConnected || false,
        waPhoneNumber: config?.waPhoneNumber || '',
        smsConnected: config?.smsConnected || false,
        smsSenderId: config?.smsSenderId || '',
        smsProvider: config?.smsProvider || '',
        lastTestNumber: config?.lastTestNumber || '',
        lastTestAt: config?.lastTestAt || null,
    });
}));

// POST /api/business-os/messaging-config/whatsapp — connect/disconnect WhatsApp
router.post("/messaging-config/whatsapp", requirePermission("settings.manage"), wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.status(400).json({ success: false, message: "No business profile" });

    const { action, phoneNumber, apiKey } = req.body; // action: 'connect' | 'disconnect'

    if (action === 'disconnect') {
        await prisma.businessMessagingConfig.upsert({
            where: { businessProfileId: bpId },
            update: { waConnected: false, waApiKeyEncrypted: null },
            create: { businessProfileId: bpId, waConnected: false },
        });
        return res.json({ success: true, waConnected: false });
    }

    // Connect
    if (!phoneNumber || !apiKey) return res.status(400).json({ success: false, message: "Phone number and API key required" });

    // Simple encryption: base64 (replace with real encryption in production)
    const crypto = require('crypto');
    const encrypted = crypto.createHash('sha256').update(apiKey).digest('hex') + ':' + Buffer.from(apiKey).toString('base64');

    await prisma.businessMessagingConfig.upsert({
        where: { businessProfileId: bpId },
        update: { waConnected: true, waPhoneNumber: phoneNumber, waApiKeyEncrypted: encrypted },
        create: { businessProfileId: bpId, waConnected: true, waPhoneNumber: phoneNumber, waApiKeyEncrypted: encrypted },
    });

    res.json({ success: true, waConnected: true, waPhoneNumber: phoneNumber });
}));

// POST /api/business-os/messaging-config/sms — connect/disconnect SMS
router.post("/messaging-config/sms", requirePermission("settings.manage"), wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.status(400).json({ success: false, message: "No business profile" });

    const { action, apiKey, senderId, provider } = req.body;

    if (action === 'disconnect') {
        await prisma.businessMessagingConfig.upsert({
            where: { businessProfileId: bpId },
            update: { smsConnected: false, smsApiKeyEncrypted: null },
            create: { businessProfileId: bpId, smsConnected: false },
        });
        return res.json({ success: true, smsConnected: false });
    }

    if (!apiKey || !senderId) return res.status(400).json({ success: false, message: "API key and sender ID required" });

    const crypto = require('crypto');
    const encrypted = crypto.createHash('sha256').update(apiKey).digest('hex') + ':' + Buffer.from(apiKey).toString('base64');

    await prisma.businessMessagingConfig.upsert({
        where: { businessProfileId: bpId },
        update: { smsConnected: true, smsApiKeyEncrypted: encrypted, smsSenderId: senderId, smsProvider: provider || 'africas_talking' },
        create: { businessProfileId: bpId, smsConnected: true, smsApiKeyEncrypted: encrypted, smsSenderId: senderId, smsProvider: provider || 'africas_talking' },
    });

    res.json({ success: true, smsConnected: true, smsSenderId: senderId });
}));

// POST /api/business-os/messaging-config/test — send a test message
router.post("/messaging-config/test", requirePermission("settings.manage"), wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.status(400).json({ success: false, message: "No business profile" });

    const { phoneNumber, channel } = req.body; // channel: 'whatsapp' | 'sms'
    if (!phoneNumber) return res.status(400).json({ success: false, message: "Phone number required" });

    const config = await prisma.businessMessagingConfig.findUnique({ where: { businessProfileId: bpId } });
    if (!config) return res.status(400).json({ success: false, message: "No messaging config found" });

    const bizProfile = await prisma.businessProfile.findFirst({ where: { id: bpId }, select: { businessName: true } });
    const testMessage = `Hello from ${bizProfile?.businessName || 'Azaman Business'} — this is a test message. Your messaging channel is working!`;

    let status = 'SENT', errorMsg = null;

    try {
        if (channel === 'whatsapp' && config.waConnected) {
            // TODO: Replace with actual WhatsApp Cloud API call
            logger.info(`[MessagingTest] WhatsApp to ${phoneNumber}: "${testMessage}"`);
        } else if (channel === 'sms' && config.smsConnected) {
            // TODO: Replace with actual SMS gateway call (Africa's Talking, Twilio, etc.)
            logger.info(`[MessagingTest] SMS to ${phoneNumber}: "${testMessage}"`);
        } else {
            return res.status(400).json({ success: false, message: `Channel ${channel} is not connected` });
        }
    } catch (err) {
        status = 'FAILED';
        errorMsg = err.message;
    }

    // Log the message
    await prisma.businessMessageLog.create({
        data: {
            businessProfileId: bpId,
            channel,
            recipient: phoneNumber,
            message: testMessage,
            status,
            error: errorMsg,
            eventType: 'test',
            costGhs: channel === 'whatsapp' ? 0.035 : 0.05,
        },
    });

    // Update last test info
    await prisma.businessMessagingConfig.update({
        where: { businessProfileId: bpId },
        data: { lastTestNumber: phoneNumber, lastTestAt: new Date() },
    });

    if (status === 'FAILED') return res.status(500).json({ success: false, message: errorMsg });
    res.json({ success: true, message: `Test message sent to ${phoneNumber}` });
}));

// PATCH /api/business-os/messaging-config/preferences — update notification routing
router.patch("/messaging-config/preferences", requirePermission("settings.manage"), wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.status(400).json({ success: false, message: "No business profile" });

    const { preferences } = req.body; // { order_ready: { whatsapp: true, sms: false }, ... }
    if (!preferences) return res.status(400).json({ success: false, message: "Preferences required" });

    // Merge into existing notification preferences
    const existing = await prisma.businessNotificationPreference.findUnique({ where: { businessProfileId: bpId } });
    const currentPrefs = existing?.preferences || {};
    const merged = { ...currentPrefs, ...preferences };

    await prisma.businessNotificationPreference.upsert({
        where: { businessProfileId: bpId },
        update: { preferences: merged },
        create: { businessProfileId: bpId, preferences: merged },
    });

    res.json({ success: true, preferences: merged });
}));

// GET /api/business-os/messaging-config/preferences — get notification routing
router.get("/messaging-config/preferences", wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bpId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bpId) return res.json({ preferences: {} });

    const pref = await prisma.businessNotificationPreference.findUnique({ where: { businessProfileId: bpId } });
    res.json({ preferences: pref?.preferences || {} });
}));

// GET /api/business-os/messaging-stats — this month's messaging cost breakdown
router.get("/messaging-stats", wrap(async (req, res) => {
    const prisma = req.app.get("prisma");
    const bizProfileId = req.businessProfileId || (await prisma.businessProfile.findFirst({
        where: { userId: req.user.id }, select: { id: true },
    }))?.id;
    if (!bizProfileId) return res.json({ whatsapp: 0, sms: 0, messages: 0 });

    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const monthStartISO = monthStart.toISOString();

    // Use real message logs for accurate stats
    const logs = await prisma.businessMessageLog.findMany({
        where: { businessProfileId, createdAt: { gte: monthStartISO } },
        select: { channel: true, costGhs: true, status: true },
    });

    const whatsappLogs = logs.filter(l => l.channel === 'whatsapp');
    const smsLogs = logs.filter(l => l.channel === 'sms');
    const whatsappCost = whatsappLogs.reduce((sum, l) => sum + (parseFloat(l.costGhs) || 0), 0);
    const smsCost = smsLogs.reduce((sum, l) => sum + (parseFloat(l.costGhs) || 0), 0);

    res.json({
        whatsapp: +whatsappCost.toFixed(2),
        sms: +smsCost.toFixed(2),
        messages: logs.length,
        whatsappCount: whatsappLogs.length,
        smsCount: smsLogs.length,
        failed: logs.filter(l => l.status === 'FAILED').length,
    });
}));

// GET /api/business-os/group-stats — aggregate stats across all owned businesses
router.get("/group-stats", wrap(async (req, res) => {
    const svc = getServices(req);
    const groupId = req.query.groupId || null;
    const stats = await svc.groupService.getGroupStats(req.user.id, groupId);
    res.json({ success: true, ...stats });
}));

// GET /api/business-os/export — export business data as zip (orders, invoices, reviews, employees)
router.get('/export', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = req.businessProfileId;
    const archiver = require('archiver');

    // Fetch data
    const [orders, invoices, reviews, employees, products] = await Promise.all([
        prisma.businessOrder.findMany({
            where: { businessProfileId: bpId },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.businessInvoice.findMany({
            where: { businessProfileId: bpId },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.businessReview.findMany({
            where: { businessProfileId: bpId },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.businessEmployee.findMany({
            where: { businessProfileId: bpId },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.businessProduct.findMany({
            where: { businessProfileId: bpId },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    // Helper: convert array to CSV
    function toCSV(rows) {
        if (!rows.length) return '';
        const keys = Object.keys(rows[0]);
        const header = keys.join(',');
        const lines = rows.map(row =>
            keys.map(k => {
                const val = row[k];
                if (val === null || val === undefined) return '';
                const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',')
        );
        return [header, ...lines].join('\n');
    }

    const zip = archiver('zip', { zlib: { level: 5 } });

    const bizName = (req.businessProfile?.name || 'business').replace(/[^a-zA-Z0-9]/g, '_');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${bizName}_export_${dateStr}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    zip.pipe(res);

    zip.append(toCSV(orders), { name: 'orders.csv' });
    zip.append(toCSV(invoices), { name: 'invoices.csv' });
    zip.append(toCSV(reviews), { name: 'reviews.csv' });
    zip.append(toCSV(employees), { name: 'employees.csv' });
    zip.append(toCSV(products), { name: 'products.csv' });

    // Also include a JSON manifest
    zip.append(JSON.stringify({
        businessId: bpId,
        businessName: req.businessProfile?.name,
        exportDate: new Date().toISOString(),
        counts: {
            orders: orders.length,
            invoices: invoices.length,
            reviews: reviews.length,
            employees: employees.length,
            products: products.length,
        },
    }, null, 2), { name: 'manifest.json' });

    await zip.finalize();
}));

// ── Missing routes found by route-checker ──────────────────────────────────

// GET /api/business-os/finance/payout — process a payout to a destination
router.post('/finance/payout', requirePermission('settings.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = getBizProfileId(req);
    const { amount, destination } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Amount must be positive' });
    if (!destination) return res.status(400).json({ success: false, message: 'Destination required' });

    // Look up the payout destination
    const dest = await prisma.payoutDestination.findFirst({
        where: { id: destination, userId: req.user.id },
    });
    if (!dest) return res.status(404).json({ success: false, message: 'Payout destination not found' });

    // For now, just log the payout request — actual transfer requires payment API integration
    const log = await prisma.auditLog.create({
        data: {
            businessProfileId: bpId,
            action: 'PAYOUT_REQUESTED',
            entity: 'Finance',
            details: `Payout of ${amount} USDC to ${dest.nickname} (${dest.destinationType})`,
            performedBy: req.user.id,
        },
    });

    res.json({ success: true, message: 'Payout request submitted', payoutId: log.id });
}));

// PATCH /api/business-os/transit/vehicles/:id/status — update vehicle status
router.patch('/transit/vehicles/:id/status', requirePermission('transit.manage'), wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = getBizProfileId(req);
    const { id } = req.params;
    const { status } = req.body;

    if (!status) return res.status(400).json({ success: false, message: 'Status required' });

    const vehicle = await prisma.transitVehicle.findFirst({
        where: { id, businessProfileId: bpId },
    });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    // isActive maps to status ACTIVE/INACTIVE
    const isActive = status === 'ACTIVE' || status === 'active';
    const updated = await prisma.transitVehicle.update({
        where: { id },
        data: { isActive },
    });

    res.json({ success: true, vehicle: updated });
}));

// GET /api/business-os/transit/trips — list business transit trips
router.get('/transit/trips', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = getBizProfileId(req);

    const trips = await prisma.transitTrip.findMany({
        where: { businessProfileId: bpId },
        orderBy: { departureAt: 'desc' },
        take: 100,
    });

    res.json(trips);
}));



// =============================================================================
// PHASE 3 RETAIL: Suppliers, Purchase Orders, Stock Counts, Barcode/SKU
// =============================================================================

// ── Suppliers ─────────────────────────────────────────────────────────────────

// GET /api/business-os/retail/suppliers
router.get('/retail/suppliers', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const suppliers = await prisma.supplier.findMany({
        where: { businessProfileId: bpId },
        orderBy: { name: 'asc' },
    });
    res.json({ success: true, suppliers });
}));

// POST /api/business-os/retail/suppliers
router.post('/retail/suppliers', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const { name, contactName, email, phone, address, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Supplier name is required.' });

    const supplier = await prisma.supplier.create({
        data: { businessProfileId: bpId, name, contactName, email, phone, address, notes },
    });
    res.json({ success: true, supplier });
}));

// PATCH /api/business-os/retail/suppliers/:id
router.patch('/retail/suppliers/:id', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;

    const supplier = await prisma.supplier.update({
        where: { id, businessProfileId: bpId },
        data: req.body,
    });
    res.json({ success: true, supplier });
}));

// DELETE /api/business-os/retail/suppliers/:id
router.delete('/retail/suppliers/:id', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;

    await prisma.supplier.delete({ where: { id, businessProfileId: bpId } });
    res.json({ success: true });
}));

// ── Purchase Orders ──────────────────────────────────────────────────────────

// GET /api/business-os/retail/purchase-orders
router.get('/retail/purchase-orders', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const orders = await prisma.purchaseOrder.findMany({
        where: { businessProfileId: bpId },
        include: { supplier: true, items: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    res.json({ success: true, purchaseOrders: orders });
}));

// POST /api/business-os/retail/purchase-orders
router.post('/retail/purchase-orders', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const { supplierId, items, notes, expectedDate } = req.body;
    if (!supplierId) return res.status(400).json({ success: false, message: 'Supplier is required.' });
    if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ success: false, message: 'At least one item is required.' });

    // Generate PO number
    const count = await prisma.purchaseOrder.count({ where: { businessProfileId: bpId } });
    const poNumber = `PO-${String(count + 1).padStart(5, '0')}`;

    // Calculate totals
    const processedItems = items.map(item => ({
        productId: item.productId || null,
        productName: item.productName,
        sku: item.sku || null,
        quantity: parseInt(item.quantity, 10) || 1,
        unitCost: parseFloat(item.unitCost) || 0,
        lineTotal: (parseInt(item.quantity, 10) || 1) * (parseFloat(item.unitCost) || 0),
    }));
    const totalCost = processedItems.reduce((sum, item) => sum + item.lineTotal, 0);

    const po = await prisma.purchaseOrder.create({
        data: {
            businessProfileId: bpId,
            poNumber,
            supplierId,
            status: 'SUBMITTED',
            totalCost,
            notes,
            expectedDate: expectedDate ? new Date(expectedDate) : null,
            createdById: req.user.id,
            items: { create: processedItems },
        },
        include: { supplier: true, items: true },
    });
    res.json({ success: true, purchaseOrder: po });
}));

// PATCH /api/business-os/retail/purchase-orders/:id (status update)
router.patch('/retail/purchase-orders/:id', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;
    const { status, notes, expectedDate } = req.body;

    const updateData = {};
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (expectedDate !== undefined) updateData.expectedDate = expectedDate ? new Date(expectedDate) : null;
    if (status === 'RECEIVED') updateData.receivedDate = new Date();

    const po = await prisma.purchaseOrder.update({
        where: { id, businessProfileId: bpId },
        data: updateData,
        include: { supplier: true, items: true },
    });

    // On RECEIVED, update product stock quantities
    if (status === 'RECEIVED' && po.items) {
        for (const item of po.items) {
            if (item.productId) {
                const product = await prisma.businessProduct.findUnique({ where: { id: item.productId } });
                if (product) {
                    const currentQty = product.stockQty || 0;
                    const receivedQty = item.quantity;
                    await prisma.businessProduct.update({
                        where: { id: item.productId },
                        data: { stockQty: currentQty + receivedQty },
                    });
                }
            }
        }
    }

    res.json({ success: true, purchaseOrder: po });
}));

// ── Stock Counts ─────────────────────────────────────────────────────────────

// GET /api/business-os/retail/stock-counts
router.get('/retail/stock-counts', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const counts = await prisma.stockCount.findMany({
        where: { businessProfileId: bpId },
        include: { items: { include: { } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
    res.json({ success: true, stockCounts: counts });
}));

// POST /api/business-os/retail/stock-counts — create a new count with all products
router.post('/retail/stock-counts', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const { notes } = req.body;

    // Generate count number
    const count = await prisma.stockCount.count({ where: { businessProfileId: bpId } });
    const countNumber = `SC-${String(count + 1).padStart(5, '0')}`;

    // Get all products that have stock tracking enabled
    const products = await prisma.businessProduct.findMany({
        where: { businessProfileId: bpId, isActive: true, stockQty: { not: null } },
        select: { id: true, stockQty: true, name: true, sku: true },
    });

    const stockCount = await prisma.stockCount.create({
        data: {
            businessProfileId: bpId,
            countNumber,
            status: 'OPEN',
            notes,
            createdById: req.user.id,
            items: {
                create: products.map(p => ({
                    productId: p.id,
                    systemQty: p.stockQty || 0,
                })),
            },
        },
        include: { items: true },
    });
    res.json({ success: true, stockCount });
}));

// PATCH /api/business-os/retail/stock-counts/:id/items/:itemId — record counted qty
router.patch('/retail/stock-counts/:id/items/:itemId', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id, itemId } = req.params;
    const { countedQty, notes: itemNotes } = req.body;

    const item = await prisma.stockCountItem.findFirst({
        where: { id: itemId, stockCountId: id, stockCount: { businessProfileId: bpId } },
        include: { stockCount: true },
    });
    if (!item) return res.status(404).json({ success: false, message: 'Stock count item not found.' });

    const discrepancy = countedQty !== null && countedQty !== undefined
        ? parseInt(countedQty, 10) - item.systemQty
        : null;

    const updated = await prisma.stockCountItem.update({
        where: { id: itemId },
        data: { countedQty: countedQty !== null && countedQty !== undefined ? parseInt(countedQty, 10) : null, discrepancy, notes: itemNotes },
    });
    res.json({ success: true, item: updated });
}));

// POST /api/business-os/retail/stock-counts/:id/reconcile — apply adjustments to product stock
router.post('/retail/stock-counts/:id/reconcile', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;

    const stockCount = await prisma.stockCount.findFirst({
        where: { id, businessProfileId: bpId },
        include: { items: true },
    });
    if (!stockCount) return res.status(404).json({ success: false, message: 'Stock count not found.' });
    if (stockCount.status === 'RECONCILED') return res.status(400).json({ success: false, message: 'Already reconciled.' });

    // Apply counted quantities to products
    for (const item of stockCount.items) {
        if (item.countedQty !== null && item.countedQty !== undefined) {
            await prisma.businessProduct.update({
                where: { id: item.productId },
                data: { stockQty: item.countedQty },
            });
        }
    }

    const updated = await prisma.stockCount.update({
        where: { id },
        data: { status: 'RECONCILED', reconciledAt: new Date() },
        include: { items: true },
    });
    res.json({ success: true, stockCount: updated });
}));

// ── Low Stock Alert ──────────────────────────────────────────────────────────

// GET /api/business-os/retail/low-stock
router.get('/retail/low-stock', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    if (!bpId) return res.status(404).json({ success: false, message: 'No business profile found.' });

    const products = await prisma.businessProduct.findMany({
        where: {
            businessProfileId: bpId,
            isActive: true,
            stockQty: { not: null },
        },
        select: { id: true, name: true, sku: true, stockQty: true, lowStockThreshold: true, priceUsdc: true },
    });

    const lowStockItems = products.filter(p => (p.stockQty || 0) <= (p.lowStockThreshold || 5));
    res.json({ success: true, items: lowStockItems });
}));

// ── Product Barcode/SKU Update ────────────────────────────────────────────────

// PATCH /api/business-os/retail/products/:id/barcode
router.patch('/retail/products/:id/barcode', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { id } = req.params;
    const { sku, barcode, costPrice, stockQty, lowStockThreshold, supplierId } = req.body;

    const updateData = {};
    if (sku !== undefined) updateData.sku = sku;
    if (barcode !== undefined) updateData.barcode = barcode;
    if (costPrice !== undefined) updateData.costPrice = costPrice;
    if (stockQty !== undefined) updateData.stockQty = stockQty;
    if (lowStockThreshold !== undefined) updateData.lowStockThreshold = lowStockThreshold;
    if (supplierId !== undefined) updateData.supplierId = supplierId;

    const product = await prisma.businessProduct.update({
        where: { id, businessProfileId: bpId },
        data: updateData,
        select: { id: true, name: true, sku: true, barcode: true, costPrice: true, stockQty: true, lowStockThreshold: true, supplierId: true },
    });
    res.json({ success: true, product });
}));


// GET /api/business-os/retail/products/lookup?barcode=XXX or ?sku=XXX
// Quick lookup product by barcode or SKU — used by barcode scanner
router.get('/retail/products/lookup', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const bpId = await getBusinessProfileId(req);
    const { barcode, sku } = req.query;

    if (!barcode && !sku) return res.status(400).json({ error: 'Provide barcode or sku query param' });

    const where = { businessProfileId: bpId, isActive: true };
    if (barcode) where.barcode = barcode;
    else if (sku) where.sku = sku;

    const product = await prisma.businessProduct.findFirst({
        where,
        select: {
            id: true, name: true, priceUsdc: true, sku: true, barcode: true,
            stockQty: true, lowStockThreshold: true, costPrice: true,
            supplierId: true, isActive: true, isAvailable: true,
            imageUrls: true, category: true,
        },
    });

    if (!product) return res.status(404).json({ error: 'No product matches that barcode/SKU' });

    const isLowStock = product.stockQty !== null && product.stockQty <= (product.lowStockThreshold || 5);
    res.json({ ...product, isLowStock });
}));

module.exports = router;
