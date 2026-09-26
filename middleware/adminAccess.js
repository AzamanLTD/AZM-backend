// Centralized admin access helpers.
// Keeps legacy ADMIN access working while allowing the existing specialized
// RBAC role definitions to become enforceable as the control plane evolves.

const ADMIN_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'SUPPORT_ADMIN',
  'COMPLIANCE_ADMIN',
  'READ_ONLY_ADMIN',
]);

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toUpperCase() : '';
}

function isAdminRole(role) {
  return ADMIN_ROLES.has(normalizeRole(role));
}

function isAdminUser(user) {
  return Boolean(user && isAdminRole(user.role));
}

module.exports = {
  ADMIN_ROLES,
  normalizeRole,
  isAdminRole,
  isAdminUser,
};
