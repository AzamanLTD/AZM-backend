// __tests__/module01-route-coverage.test.js
// =============================================================================
// r26/P1 — EXECUTABLE ROUTE-COVERAGE INVENTORY (drift guard, phase 2)
//
// The Module 01 catalog drift test proves that every requirePermission('x')
// uses a known key. It proves nothing about routes that LACK a guard. This
// test closes that gap: every route in routes/businessOSRoutes.js must be
// exactly one of:
//
//   1. GUARDED      — carries requirePermission('<known catalog key>').
//   2. SELF-SERVICE — a worker self-service endpoint where the employee's own
//                     identity (req.user.id) is the authorization and the
//                     handler is participant-scoped (my-* / me / swaps /
//                     clock-in / time-off / messaging).
//   3. DOCUMENTED    — an explicitly classified exception below, with the
//                     security reason recorded. Adding a route to the
//                     exception list requires justifying it here in review.
//
// Any new route that is none of these fails this suite — a new privileged
// business route can never silently ship without a permission guard.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { ALL_KEYS } = require('../config/permissionTemplates');

const ROUTES_FILE = path.join(__dirname, '..', 'routes', 'businessOSRoutes.js');

// Worker self-service surface: the employee's own identity is the authority.
// Kept as pattern rules + a path allowlist so additions are review-visible.
const SELF_SERVICE_PATH_PATTERNS = [
    /^\/employees\/me($|\b)/,
    /^\/employees\/my-/,
    /^\/employees\/shifts\/open$/,
    /^\/employees\/shifts\/[^/]+\/clock-(in|out)$/,
    /^\/employees\/shifts\/[^/]+\/request-swap$/,
    /^\/employees\/time-off$/,
    // Worker files an own time-off request; approvals stay guarded behind
    // shifts.approve_timeoff on the approve/reject routes.
    /^\/time-off$/,
    /^\/shifts\/my-schedule$/,
    /^\/time-off\/my-requests$/,
    /^\/transit\/drivers\/my-schedule$/,
    // Shift swap request/claim/list: any active employee may offer, claim,
    // and view OPEN swaps for their business. Approval is authority-bearing
    // and IS guarded (shifts.approve_swap) on the approve/reject routes.
    /^\/shifts\/swaps$/,
    /^\/shifts\/swaps\/[^/]+\/claim$/,
    // Employee-to-employee messaging: handlers are participant-scoped by
    // req.user.id (participantAId/participantBId filters), so any active
    // business member may use their own conversations only.
    /^\/messages(\/|$)/,
];

// Explicitly classified exceptions (privileged-looking but intentionally
// unguarded). Every entry needs a reason that a reviewer can check.
const DOCUMENTED_EXCEPTIONS = {
    'POST /kiosk/pin-auth':
        'Shared-device clock-in kiosk: the per-employee PIN is the authorization capability; the endpoint returns only the employee identity for clock-in/out, not business data.',
    'POST /kiosk/clock-in':
        "Shared-device clock-in kiosk (same capability model as pin-auth): PIN-gated, returns only the employee identity and writes only the employee's own attendance.",
    'POST /kiosk/clock-out':
        "Shared-device clock-out kiosk (same PIN capability model): writes only the employee's own attendance event.",
    'GET /permission-templates':
        'Reads the canonical permission catalog/role templates — vocabulary only, zero business data. Any authenticated business member may read it so non-owner permission managers can render their own delegation ceiling.',
};

function buildInventory() {
    const src = fs.readFileSync(ROUTES_FILE, 'utf8');
    const lines = src.split('\n');
    const routeRe = /router\.(get|post|patch|delete|put)\(\s*'([^']+)'/;
    const inventory = [];
    for (let i = 0; i < lines.length; i += 1) {
        const m = routeRe.exec(lines[i]);
        if (!m) continue;
        // A guard must appear within the route definition (same statement).
        const segment = lines.slice(i, i + 4).join('\n');
        const guardMatch = /requirePermission\('([^']+)'\)/.exec(segment);
        inventory.push({
            method: m[1].toUpperCase(),
            path: m[2],
            permission: guardMatch ? guardMatch[1] : null,
        });
    }
    return inventory;
}

function classify(route) {
    if (route.permission) {
        return ALL_KEYS.includes(route.permission)
            ? { kind: 'GUARDED', valid: true }
            : { kind: 'GUDED-BAD-KEY', valid: false, reason: `unknown catalog key ${route.permission}` };
    }
    if (SELF_SERVICE_PATH_PATTERNS.some((re) => re.test(route.path))) {
        return { kind: 'SELF_SERVICE', valid: true };
    }
    const entry = `${route.method} ${route.path}`;
    if (DOCUMENTED_EXCEPTIONS[entry]) {
        return { kind: 'DOCUMENTED', valid: true };
    }
    return { kind: 'UNCLASSIFIED', valid: false };
}

describe('r26/P1 — route-coverage inventory (businessOSRoutes.js)', () => {
    const inventory = buildInventory();

    test('the inventory actually found routes (guard against a parse regression)', () => {
        expect(inventory.length).toBeGreaterThan(150);
    });

    test('every guarded route uses a known catalog key', () => {
        const bad = inventory.filter((r) => r.permission && !ALL_KEYS.includes(r.permission));
        expect(bad).toEqual([]);
    });

    test('every route is guarded, self-service, or explicitly documented — no silent gaps', () => {
        const violations = inventory.filter((r) => !classify(r).valid);
        expect(violations.map((r) => `${r.method} ${r.path} → ${classify(r).kind}`)).toEqual([]);
    });

    test('the management surface is materially guarded (not a self-serve-only registry)', () => {
        const guarded = inventory.filter((r) => r.permission);
        // Before r26 only ~50 of 213 routes were guarded; the hardening pass
        // guards every management action. If this number drops materially,
        // someone removed guards.
        expect(guarded.length).toBeGreaterThanOrEqual(165);
    });

    test('documented exceptions stay minimal (every one is a review decision)', () => {
        const exceptions = inventory.filter((r) => classify(r).kind === 'DOCUMENTED');
        expect(exceptions.length).toBeLessThanOrEqual(4);
    });
});
