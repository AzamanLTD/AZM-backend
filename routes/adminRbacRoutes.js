const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/adminMiddleware');
const rbac = require('../controllers/adminRbacController');
const roleAdmin = require('../controllers/adminRoleAdminController');

const protect = authMiddleware.protect;

// All routes require admin auth
router.use(protect, isAdmin);

// Roles
router.get('/roles', rbac.getAdminRoles);

// Admin role provisioning (r272 follow-up). protect + isAdmin is the
// AUTHENTICATION boundary only — each handler re-resolves the acting
// administrator's effective role from live database state and requires
// effective SUPER_ADMIN. A route-level isAdmin check alone is NOT the
// authorization for these operations.
router.get('/admins',                   roleAdmin.listAdmins);
router.post('/admins/:id/role',        roleAdmin.assignAdminRole);
router.post('/admins/:id/deprovision', roleAdmin.deprovisionAdmin);

// Multi-step approvals
router.post('/approvals',                rbac.createApprovalRequest);
router.get('/approvals',                rbac.listApprovals);
router.post('/approvals/:id/approve',   rbac.approveRequest);
router.post('/approvals/:id/reject',    rbac.rejectRequest);

// Audit log export
router.get('/audit/export', rbac.exportAuditLog);

// Susu health dashboard
router.get('/susu/health', rbac.getSusuHealthDashboard);

module.exports = router;
