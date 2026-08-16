const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/adminMiddleware');
const rbac = require('../controllers/adminRbacController');

const protect = authMiddleware.protect;

// All routes require admin auth
router.use(protect, isAdmin);

// Roles
router.get('/roles', rbac.getAdminRoles);

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
