// config/permissionTemplates.js
// =============================================================================
// AZM Business Portal — Permission Template System
//
// Exhaustive permission key catalog and role templates. Every action in
// modules 01–09 maps to a permission key. Templates define sensible defaults
// per role; owners can fine-tune per employee.
//
// Permission keys follow a dotted convention: `<module>.<action>`
// =============================================================================

// ── Permission Keys (exhaustive) ─────────────────────────────────────────────
// Grouped by module for UI rendering. Each key is a string that gets stored
// in BusinessEmployee.permissions[].
const PERMISSION_KEYS = {
  governance: [
    { key: 'settings.manage',        label: 'Manage business settings',  module: 'Governance' },
    { key: 'locations.manage',        label: 'Manage locations',          module: 'Governance' },
    { key: 'team_access.manage',      label: 'Manage portal access',       module: 'Governance' },
    { key: 'audit.view',              label: 'View activity log',         module: 'Governance' },
  ],
  employees: [
    { key: 'employees.view',          label: 'View employees',            module: 'Workforce' },
    { key: 'employees.create',        label: 'Add employees',             module: 'Workforce' },
    { key: 'employees.update',        label: 'Edit employees',            module: 'Workforce' },
    { key: 'employees.terminate',     label: 'Terminate employees',       module: 'Workforce' },
    { key: 'employees.permissions',   label: 'Change permissions',         module: 'Workforce' },
  ],
  shifts: [
    { key: 'shifts.view',             label: 'View schedules',            module: 'Workforce' },
    { key: 'shifts.create',           label: 'Create shifts',            module: 'Workforce' },
    { key: 'shifts.publish',          label: 'Publish schedules',        module: 'Workforce' },
    { key: 'shifts.update',           label: 'Edit shifts',              module: 'Workforce' },
    { key: 'shifts.delete',           label: 'Delete shifts',            module: 'Workforce' },
    { key: 'shifts.approve_swap',     label: 'Approve shift swaps',       module: 'Workforce' },
    { key: 'shifts.approve_timeoff',  label: 'Approve time-off',          module: 'Workforce' },
  ],
  payroll: [
    { key: 'payroll.view',            label: 'View payroll',             module: 'Workforce' },
    { key: 'payroll.process',         label: 'Process payroll',           module: 'Workforce' },
    { key: 'payroll.disburse',        label: 'Disburse payroll',          module: 'Workforce' },
    { key: 'ewa.manage',              label: 'Manage EWA',               module: 'Workforce' },
    { key: 'ewa.approve',             label: 'Approve EWA requests',      module: 'Workforce' },
  ],
  feedback: [
    { key: 'feedback.give',           label: 'Give feedback',            module: 'Workforce' },
    { key: 'feedback.view',           label: 'View feedback',            module: 'Workforce' },
  ],
  hotels: [
    { key: 'hotel.rooms.view',        label: 'View rooms',               module: 'Hotels' },
    { key: 'hotel.rooms.manage',      label: 'Manage rooms',             module: 'Hotels' },
    { key: 'hotel.rates.manage',      label: 'Manage rate calendar',     module: 'Hotels' },
    { key: 'hotel.front_desk.manage', label: 'Front desk operations',    module: 'Hotels' },
    { key: 'hotel.housekeeping.manage', label: 'Manage housekeeping',   module: 'Hotels' },
    { key: 'hotel.housekeeping.inspect', label: 'Inspect housekeeping',  module: 'Hotels' },
    { key: 'hotel.guests.view',       label: 'View guests',              module: 'Hotels' },
  ],
  restaurants: [
    { key: 'restaurant.menu.view',   label: 'View menu',                module: 'Restaurants' },
    { key: 'restaurant.menu.manage',  label: 'Manage menu',             module: 'Restaurants' },
    { key: 'restaurant.tables.manage', label: 'Manage tables/floor plan', module: 'Restaurants' },
    { key: 'restaurant.kitchen.view', label: 'View KDS',                module: 'Restaurants' },
    { key: 'restaurant.kitchen.manage', label: 'Manage kitchen orders', module: 'Restaurants' },
    { key: 'restaurant.inventory.view', label: 'View inventory',       module: 'Restaurants' },
    { key: 'restaurant.inventory.manage', label: 'Manage inventory',   module: 'Restaurants' },
    { key: 'restaurant.dinein.manage', label: 'Manage dine-in tabs',    module: 'Restaurants' },
  ],
  transit: [
    { key: 'transit.fleet.view',     label: 'View fleet',               module: 'Transit' },
    { key: 'transit.fleet.manage',    label: 'Manage fleet',             module: 'Transit' },
    { key: 'transit.trips.view',     label: 'View trips',               module: 'Transit' },
    { key: 'transit.trips.manage',    label: 'Manage trips',             module: 'Transit' },
    { key: 'transit.drivers.manage',  label: 'Manage drivers',           module: 'Transit' },
    { key: 'transit.manifests.view',  label: 'View manifests',           module: 'Transit' },
    { key: 'transit.manifests.manage', label: 'Manage boarding',        module: 'Transit' },
    { key: 'transit.cargo.view',     label: 'View cargo',               module: 'Transit' },
    { key: 'transit.cargo.manage',   label: 'Manage cargo',             module: 'Transit' },
    { key: 'transit.maintenance.manage', label: 'Manage maintenance',   module: 'Transit' },
  ],
  bookings: [
    { key: 'reservations.view',      label: 'View reservations',        module: 'Bookings' },
    { key: 'reservations.manage',    label: 'Manage reservations',      module: 'Bookings' },
    { key: 'reservations.override_price', label: 'Override prices',     module: 'Bookings' },
    { key: 'orders.view',            label: 'View orders',              module: 'Bookings' },
    { key: 'orders.manage',          label: 'Manage orders',            module: 'Bookings' },
    { key: 'orders.refund',          label: 'Issue refunds',            module: 'Bookings' },
    { key: 'invoices.view',          label: 'View invoices',            module: 'Bookings' },
    { key: 'invoices.manage',        label: 'Manage invoices',          module: 'Bookings' },
    { key: 'invoices.void',          label: 'Void invoices',            module: 'Bookings' },
  ],
  finance: [
    { key: 'finance.view',           label: 'View finance',              module: 'Finance' },
    { key: 'finance.export',         label: 'Export financial reports',  module: 'Finance' },
    { key: 'finance.ledger.manage',  label: 'Manage ledger entries',     module: 'Finance' },
    { key: 'finance.payouts.manage', label: 'Manage payout destinations', module: 'Finance' },
  ],
  marketing: [
    { key: 'marketing.view',         label: 'View marketing',           module: 'Marketing' },
    { key: 'marketing.publish',      label: 'Publish ads/posts',        module: 'Marketing' },
    { key: 'marketing.promotions.manage', label: 'Manage promotions',   module: 'Marketing' },
    { key: 'reviews.view',           label: 'View reviews',             module: 'Marketing' },
    { key: 'reviews.respond',        label: 'Respond to reviews',       module: 'Marketing' },
    { key: 'showcase.manage',        label: 'Manage showcase',           module: 'Marketing' },
    { key: 'followers.broadcast',   label: 'Broadcast to followers',     module: 'Marketing' },
  ],
  notifications: [
    { key: 'notifications.view',     label: 'View notifications',       module: 'System' },
    { key: 'analytics.view',         label: 'View analytics',           module: 'System' },
  ],
};

// Flatten for quick lookups
const ALL_KEYS = Object.values(PERMISSION_KEYS).flat().map(k => k.key);

// ── Role Templates ─────────────────────────────────────────────────────────
// Each template maps to a fixed set of permission keys. The OWNER template
// includes '*' which means "all permissions" in the resolver.
const ROLE_TEMPLATES = {
  OWNER: {
    label: 'Owner',
    description: 'Full access to everything. Cannot be assigned to non-owners.',
    permissions: ['*'],
    system: true,
  },
  GENERAL_MANAGER: {
    label: 'General Manager',
    description: 'Full operational access across all locations, except business deletion and billing changes.',
    permissions: [
      'locations.manage', 'audit.view',
      'employees.view', 'employees.create', 'employees.update', 'employees.terminate',
      'employees.permissions',
      'shifts.view', 'shifts.create', 'shifts.publish', 'shifts.update', 'shifts.delete',
      'shifts.approve_swap', 'shifts.approve_timeoff',
      'payroll.view', 'payroll.process',
      'ewa.manage', 'ewa.approve',
      'feedback.give', 'feedback.view',
      'hotel.rooms.view', 'hotel.rooms.manage', 'hotel.rates.manage',
      'hotel.front_desk.manage', 'hotel.housekeeping.manage', 'hotel.housekeeping.inspect',
      'hotel.guests.view',
      'restaurant.menu.view', 'restaurant.menu.manage', 'restaurant.tables.manage',
      'restaurant.kitchen.view', 'restaurant.kitchen.manage',
      'restaurant.inventory.view', 'restaurant.inventory.manage', 'restaurant.dinein.manage',
      'transit.fleet.view', 'transit.fleet.manage', 'transit.trips.view', 'transit.trips.manage',
      'transit.drivers.manage', 'transit.manifests.view', 'transit.manifests.manage',
      'transit.cargo.view', 'transit.cargo.manage', 'transit.maintenance.manage',
      'reservations.view', 'reservations.manage', 'reservations.override_price',
      'orders.view', 'orders.manage', 'orders.refund',
      'invoices.view', 'invoices.manage', 'invoices.void',
      'finance.view', 'finance.export', 'finance.ledger.manage',
      'marketing.view', 'marketing.publish', 'marketing.promotions.manage',
      'reviews.view', 'reviews.respond', 'showcase.manage', 'followers.broadcast',
      'notifications.view', 'analytics.view',
    ],
    system: true,
  },
  BRANCH_MANAGER: {
    label: 'Branch Manager',
    description: 'Operational management scoped to their assigned location.',
    permissions: [
      'employees.view', 'employees.create', 'employees.update',
      'shifts.view', 'shifts.create', 'shifts.publish', 'shifts.update',
      'shifts.approve_swap', 'shifts.approve_timeoff',
      'payroll.view',
      'feedback.give', 'feedback.view',
      'hotel.rooms.view', 'hotel.rooms.manage',
      'hotel.front_desk.manage', 'hotel.housekeeping.manage',
      'hotel.guests.view',
      'restaurant.menu.view', 'restaurant.tables.manage',
      'restaurant.kitchen.view', 'restaurant.inventory.view',
      'transit.fleet.view', 'transit.trips.view', 'transit.manifests.view',
      'transit.cargo.view',
      'reservations.view', 'reservations.manage',
      'orders.view', 'orders.manage',
      'invoices.view', 'invoices.manage',
      'finance.view',
      'marketing.view', 'reviews.view', 'reviews.respond',
      'notifications.view', 'analytics.view',
    ],
    system: true,
  },
  FRONT_DESK: {
    label: 'Front Desk',
    description: 'Reception staff — check-ins, reservations, guest management.',
    permissions: [
      'shifts.view',
      'reservations.view', 'reservations.manage',
      'hotel.rooms.view',
      'hotel.front_desk.manage',
      'hotel.guests.view',
      'orders.view', 'orders.manage',
      'invoices.view',
      'notifications.view',
    ],
    system: true,
  },
  HOUSEKEEPING_LEAD: {
    label: 'Housekeeping Lead',
    description: 'Manages housekeeping tasks and inspections.',
    permissions: [
      'shifts.view',
      'hotel.rooms.view',
      'hotel.housekeeping.manage', 'hotel.housekeeping.inspect',
      'notifications.view',
    ],
    system: true,
  },
  KITCHEN_LEAD: {
    label: 'Kitchen Lead',
    description: 'Manages kitchen orders and menu items.',
    permissions: [
      'shifts.view',
      'restaurant.menu.view',
      'restaurant.kitchen.view', 'restaurant.kitchen.manage',
      'restaurant.inventory.view',
      'notifications.view',
    ],
    system: true,
  },
  SERVER: {
    label: 'Server',
    description: 'Takes orders, manages dine-in tabs.',
    permissions: [
      'shifts.view',
      'restaurant.menu.view',
      'restaurant.dinein.manage',
      'orders.view',
      'notifications.view',
    ],
    system: true,
  },
  DRIVER: {
    label: 'Driver',
    description: 'Views trip assignments and manages manifests.',
    permissions: [
      'shifts.view',
      'transit.trips.view',
      'transit.manifests.view', 'transit.manifests.manage',
      'transit.cargo.view',
      'notifications.view',
    ],
    system: true,
  },
  ACCOUNTANT: {
    label: 'Accountant',
    description: 'Finance and payroll management. No operational access.',
    permissions: [
      'finance.view', 'finance.export', 'finance.ledger.manage',
      'payroll.view', 'payroll.process',
      'invoices.view', 'invoices.manage',
      'orders.view',
      'notifications.view',
      'audit.view',
    ],
    system: true,
  },
  MARKETER: {
    label: 'Marketer',
    description: 'Marketing, promotions, reviews, and showcase.',
    permissions: [
      'marketing.view', 'marketing.publish', 'marketing.promotions.manage',
      'reviews.view', 'reviews.respond',
      'showcase.manage', 'followers.broadcast',
      'notifications.view',
    ],
    system: true,
  },
};

module.exports = {
  PERMISSION_KEYS,
  ALL_KEYS,
  ROLE_TEMPLATES,
};
