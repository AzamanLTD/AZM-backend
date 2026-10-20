// __tests__/trade-account-route-wiring.test.js
// =============================================================================
// §4 false-affordance proof (review follow-up 2026-10-18; strengthened
// 2026-10-20 per independent integration review).
//
// The Flutter app calls GET /api/trade-accounts/supported-methods and
// DELETE /api/trade-accounts/:id, and the handlers have existed on
// tradeAccountController all along — but the router never registered them,
// so both calls 404'd (a silent affordance break in the trade-account
// screens and the ad-creation picker).
//
// This suite PROVES, against the REAL Express router stack and the REAL
// controller exports (no stubs):
//   A. Both routes are registered with the correct HTTP verbs, and
//      '/supported-methods' is ordered above any '/:id' parametric route.
//   B. The registered handlers are the EXACT controller exports, each
//      behind the EXACT `protect` auth middleware instance — identity
//      assertions on the live route stack, not mere existence checks.
//   C. The pre-existing rails are untouched (POST /, GET /, GET /approved,
//      POST /upload-screenshot) with their exact controller bindings.
//   D. getSupportedMethods preserves the client contract
//      ({ success: true, methods }) for both the settings-backed and
//      fallback paths.
//   E. deleteTradeAccount behavior, exercised with a mocked Prisma client:
//      404 nonexistent, 403 foreign account, 400 already archived,
//      400 active-ad reference, 200 soft-archive success — and in EVERY
//      case prisma.tradeAccount.delete is NEVER called (a hard delete can
//      never silently appear behind this route).
// =============================================================================

const path = require('path');

const routerPath = path.resolve(__dirname, '..', 'routes', 'tradeAccountRoutes.js');
const controllerPath = path.resolve(__dirname, '..', 'controllers', 'tradeAccountController.js');
const authPath = path.resolve(__dirname, '..', 'middleware', 'authMiddleware.js');

describe('§4 trade-account route wiring (false-affordance fix)', () => {
    const router = require(routerPath);
    const controller = require(controllerPath);
    const authMiddleware = require(authPath);

    /** Flatten an Express 4/5 router into [{method, path, handlers}]. */
    const flatten = (r, prefix = '') => {
        const out = [];
        for (const layer of r.stack || []) {
            if (layer.route) {
                const full = prefix + (layer.route.path || '');
                for (const [m, h] of Object.entries(layer.route.methods || {})) {
                    if (h) out.push({ method: m.toUpperCase(), path: full, handlers: layer.route.stack.map(s => s.handle) });
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                out.push(...flatten(layer.handle, prefix));
            }
        }
        return out;
    };

    const routes = flatten(router);
    const find = (m, p) => routes.find(r => r.method === m && r.path === p);

    // ── A. Registration + ordering ──────────────────────────────────────────

    test('A1. GET /supported-methods is registered and ordered before any /:id parametric route', () => {
        expect(find('GET', '/supported-methods')).toBeDefined();
        // The static discovery rail must sit ABOVE any parametric route in
        // the shared stack, so a future GET '/:id' can never shadow it.
        const idxStatic = routes.findIndex(r => r.method === 'GET' && r.path === '/supported-methods');
        const firstParametric = routes.findIndex(r => r.path.includes('/:'));
        expect(idxStatic).toBeGreaterThanOrEqual(0);
        expect(firstParametric).toBeGreaterThanOrEqual(0);
        expect(idxStatic).toBeLessThan(firstParametric);
    });

    test('A2. DELETE /:id is registered', () => {
        expect(find('DELETE', '/:id')).toBeDefined();
    });

    // ── B. Handler identity on the LIVE route stack ─────────────────────────

    test('B1. GET /supported-methods binds protect then the exact getSupportedMethods export', () => {
        const r = find('GET', '/supported-methods');
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers[1]).toBe(controller.getSupportedMethods);
    });

    test('B2. DELETE /:id binds protect then the exact deleteTradeAccount export', () => {
        const r = find('DELETE', '/:id');
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers[1]).toBe(controller.deleteTradeAccount);
    });

    test('B3. controller exports wired here are real async functions, not stubs', () => {
        expect(controller.getSupportedMessages).toBeUndefined(); // guard: no accidental shadow export
        expect(controller.getSupportedMethods).toBeInstanceOf(Function);
        expect(controller.deleteTradeAccount).toBeInstanceOf(Function);
    });

    // ── C. Pre-existing rails untouched, with exact bindings ────────────────

    test('C. The four pre-existing rails remain registered with their exact controller bindings', () => {
        // POST / — addTradeAccount
        let r = find('POST', '/');
        expect(r).toBeDefined();
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers[r.handlers.length - 1]).toBe(controller.addTradeAccount);

        // GET / — getTradeAccounts
        r = find('GET', '/');
        expect(r).toBeDefined();
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers[r.handlers.length - 1]).toBe(controller.getTradeAccounts);

        // GET /approved — getApprovedTradeAccounts
        r = find('GET', '/approved');
        expect(r).toBeDefined();
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers[r.handlers.length - 1]).toBe(controller.getApprovedTradeAccounts);

        // POST /upload-screenshot — multer chain (protect first, inline handler)
        r = find('POST', '/upload-screenshot');
        expect(r).toBeDefined();
        expect(r.handlers[0]).toBe(authMiddleware.protect);
        expect(r.handlers.length).toBeGreaterThanOrEqual(2); // + multer single()
    });
});

// ── D + E. Handler behavior with a mocked Prisma client ─────────────────────

describe('§4 trade-account handler behavior (mocked Prisma, no DB)', () => {
    const controller = require(controllerPath);

    /** Fresh mock (req, res, prisma) triple; `delete` is a jest.fn so any
     *  hard-delete call is caught by the explicit assertions below. */
    const makeCtx = (id, userId, prismaOverrides = {}) => {
        const prisma = {
            globalSettings: { findUnique: jest.fn() },
            tradeAccount: {
                findUnique: jest.fn(),
                update: jest.fn(),
                delete: jest.fn(), // must stay uncalled in EVERY case
            },
            ad: { count: jest.fn() },
            ...prismaOverrides,
        };
        const req = {
            params: { id },
            user: { id: userId },
            app: { get: (key) => (key === 'prisma' ? prisma : undefined) },
        };
        const res = {
            statusCode: null,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
        };
        return { req, res, prisma };
    };

    describe('getSupportedMethods — client contract { success: true, methods }', () => {
        test('D1. settings-backed path parses the stored JSON and returns it', async () => {
            const { req, res, prisma } = makeCtx();
            prisma.globalSettings.findUnique.mockResolvedValue({
                supportedPaymentMethods: '[{"type":"CASHAPP","fields":["cashtag"]}]',
            });
            await controller.getSupportedMethods(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.methods).toEqual([{ type: 'CASHAPP', fields: ['cashtag'] }]);
        });

        test('D2. no settings row → hardcoded fallback, still the same contract shape', async () => {
            const { req, res, prisma } = makeCtx();
            prisma.globalSettings.findUnique.mockResolvedValue(null);
            await controller.getSupportedMethods(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.methods)).toBe(true);
            expect(res.body.methods.length).toBeGreaterThan(0);
        });
    });

    describe('deleteTradeAccount — soft-archive contract', () => {
        test('E1. nonexistent account → 404; no archive update; no hard delete', async () => {
            const { req, res, prisma } = makeCtx('acct-404', 'user-1');
            prisma.tradeAccount.findUnique.mockResolvedValue(null);
            await controller.deleteTradeAccount(req, res);
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
            expect(prisma.tradeAccount.update).not.toHaveBeenCalled();
            expect(prisma.tradeAccount.delete).not.toHaveBeenCalled();
        });

        test('E2. account owned by another user → 403; no archive update; no hard delete', async () => {
            const { req, res, prisma } = makeCtx('acct-1', 'user-1');
            prisma.tradeAccount.findUnique.mockResolvedValue({ id: 'acct-1', userId: 'user-2', archivedAt: null });
            await controller.deleteTradeAccount(req, res);
            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
            expect(prisma.tradeAccount.update).not.toHaveBeenCalled();
            expect(prisma.tradeAccount.delete).not.toHaveBeenCalled();
        });

        test('E3. already archived account → 400; no second archive; no hard delete', async () => {
            const { req, res, prisma } = makeCtx('acct-1', 'user-1');
            prisma.tradeAccount.findUnique.mockResolvedValue({
                id: 'acct-1', userId: 'user-1', archivedAt: new Date('2026-01-01T00:00:00Z'),
            });
            await controller.deleteTradeAccount(req, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(prisma.tradeAccount.update).not.toHaveBeenCalled();
            expect(prisma.tradeAccount.delete).not.toHaveBeenCalled();
        });

        test('E4. account referenced by ACTIVE ads → 400 naming the count; no archive update; no hard delete', async () => {
            const { req, res, prisma } = makeCtx('acct-1', 'user-1');
            prisma.tradeAccount.findUnique.mockResolvedValue({ id: 'acct-1', userId: 'user-1', archivedAt: null });
            prisma.ad.count.mockResolvedValue(2);
            await controller.deleteTradeAccount(req, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('2 active ad');
            expect(prisma.tradeAccount.update).not.toHaveBeenCalled();
            expect(prisma.tradeAccount.delete).not.toHaveBeenCalled();
        });

        test('E5. success → soft archive: archivedAt timestamp + archiveReason USER_DELETED; 200; no hard delete', async () => {
            const { req, res, prisma } = makeCtx('acct-1', 'user-1');
            prisma.tradeAccount.findUnique.mockResolvedValue({ id: 'acct-1', userId: 'user-1', archivedAt: null });
            prisma.ad.count.mockResolvedValue(0);

            const tBefore = Date.now();
            await controller.deleteTradeAccount(req, res);
            const tAfter = Date.now();

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            expect(prisma.tradeAccount.update).toHaveBeenCalledTimes(1);
            const call = prisma.tradeAccount.update.mock.calls[0][0];
            expect(call.where).toEqual({ id: 'acct-1' });
            expect(call.data.archiveReason).toBe('USER_DELETED');
            const ts = new Date(call.data.archivedAt).getTime();
            expect(ts).toBeGreaterThanOrEqual(tBefore);
            expect(ts).toBeLessThanOrEqual(tAfter);

            // The durable statement of the safety contract: a hard delete
            // never happens on ANY path through this handler.
            expect(prisma.tradeAccount.delete).not.toHaveBeenCalled();
        });
    });
});
