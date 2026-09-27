// =============================================================================
// r42 HARDENING — LEGACY FIAT ALIAS SHARES ONE ECONOMIC IDENTITY (PostgreSQL)
// =============================================================================
// Audit follow-up (2026-09-27): POST /api/withdraw/fiat (canonical) and
// POST /api/finance/withdraw/fiat (compatibility alias) call the SAME
// withdrawal controller. Route-derived endpoint identity made them two
// INDEPENDENT FinancialOperation claims: the same client key sent to each
// path could execute the same logical withdrawal twice — the alias was a
// bypass of the authority. The alias mount now passes the canonical identity
// explicitly, so both paths share ONE durable claim per (user, key).
//
// Proves, on the REAL middleware + REAL PostgreSQL FinancialOperation table:
//   A1. the alias mount records the CANONICAL endpoint identity on the claim;
//   A2. canonical-then-alias with the same key + body → ONE claim, the second
//       arrival replays/409s, the handler runs exactly once;
//   A3. alias-then-canonical with the same key + body → same convergence;
//   A4. same key via the alias with a MATERIALLY DIFFERENT body → fails
//       closed (IDEMPOTENCY_PAYLOAD_CONFLICT), handler never runs;
//   A5. different keys on the two paths remain independent operations.

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r42 — legacy fiat alias shares the canonical idempotency identity (PostgreSQL)', () => {
    let prisma;

    const CANONICAL_BASE = '/api/withdraw';   // canonical withdrawal mount
    const ALIAS_BASE = '/api/finance';        // legacy finance mount
    const ROUTE_PATH = '/fiat';               // same route pattern on both mounts
    const CANONICAL_IDENTITY = 'POST /api/withdraw/fiat';

    // The REAL mount options, exactly as wired in routes/withdrawalRoutes.js
    // (canonical — no identity override) and routes/financeRoutes.js (alias —
    // explicit canonical identity), including the releaseOn4xx declaration
    // the audit required the doc to describe accurately.
    const canonicalPolicy = { failurePolicy: 'RELEASE', releaseOn4xx: true };
    const aliasPolicy = { failurePolicy: 'RELEASE', releaseOn4xx: true, identity: CANONICAL_IDENTITY };

    let executions = 0;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });

    afterAll(async () => { await prisma?.$disconnect(); });

    const drive = ({ mount, policy, userId, key, body }) => new Promise((resolve, reject) => {
        const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };
        app.set('prisma', prisma);
        const req = {
            method: 'POST',
            originalUrl: `${mount}${ROUTE_PATH}`,
            path: `${mount}${ROUTE_PATH}`,
            url: `${mount}${ROUTE_PATH}`,
            baseUrl: mount,
            route: { path: ROUTE_PATH },
            headers: { 'idempotency-key': key },
            params: {},
            query: {},
            body,
            app,
            get: (k) => app.get(k),
            user: { id: userId },
        };
        const res = {
            app,
            locals: {},
            statusCode: 200,
            headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) {
                if (!this.headersSent) {
                    this.headersSent = true;
                    resolve({ status: this.statusCode, body: b });
                }
                return this;
            },
            setHeader() {},
            end() {
                this.headersSent = true;
                resolve({ status: this.statusCode, body: null });
                return this;
            },
        };
        const { idempotency } = require('../middleware/idempotency');
        idempotency(policy)(req, res, (err) => (err
            ? reject(err)
            : Promise.resolve((executions += 1) && res.status(202).json({ success: true, code: 'EXECUTED' })).catch(reject)));
    });

    beforeEach(async () => {
        executions = 0;
        await prisma.financialOperation.deleteMany({});
    });

    test('A1. the alias mount records the CANONICAL endpoint identity on the claim', async () => {
        const user = await seedUser(prisma, {});
        await drive({
            mount: ALIAS_BASE, policy: aliasPolicy, userId: user.id,
            key: 'alias-identity-1', body: { amount: '50.00', destination: '0244556677' },
        });
        const claim = await prisma.financialOperation.findUnique({
            where: { userId_endpoint_key: { userId: user.id, endpoint: CANONICAL_IDENTITY, key: 'alias-identity-1' } },
        });
        // The claim lives under the canonical identity — NOT under the
        // route-derived alias path.
        expect(claim).not.toBeNull();
        expect(claim.endpoint).toBe(CANONICAL_IDENTITY);
        expect(executions).toBe(1);
    });

    test('A2. canonical then alias, same key + body → ONE claim; the alias arrival replays, handler runs once', async () => {
        const user = await seedUser(prisma, {});
        const body = { amount: '50.00', destination: '0244556677' };

        const first = await drive({ mount: CANONICAL_BASE, policy: canonicalPolicy, userId: user.id, key: 'cross-1', body });
        expect(first.status).toBe(202);
        expect(executions).toBe(1);

        // The SAME logical withdrawal retried through the legacy alias path.
        const second = await drive({ mount: ALIAS_BASE, policy: aliasPolicy, userId: user.id, key: 'cross-1', body });
        // One claim, converged: the alias arrival must NOT execute the
        // handler a second time — it replays the stored response bytes (or
        // 409s while in flight) on the shared claim.
        expect(executions).toBe(1);
        expect([200, 202, 409]).toContain(second.status);
        if (second.status === 202) expect(second.body.code).toBe('EXECUTED');

        const claims = await prisma.financialOperation.findMany({
            where: { userId: user.id, key: 'cross-1' },
        });
        expect(claims.length).toBe(1);
        expect(claims[0].endpoint).toBe(CANONICAL_IDENTITY);
    });

    test('A3. alias then canonical, same key + body → same convergence', async () => {
        const user = await seedUser(prisma, {});
        const body = { amount: '25.00', destination: '0201234567' };

        const aliasFirst = await drive({ mount: ALIAS_BASE, policy: aliasPolicy, userId: user.id, key: 'cross-2', body });
        expect(aliasFirst.status).toBe(202);
        expect(executions).toBe(1);

        const canonicalSecond = await drive({ mount: CANONICAL_BASE, policy: canonicalPolicy, userId: user.id, key: 'cross-2', body });
        expect(executions).toBe(1);
        expect([200, 202, 409]).toContain(canonicalSecond.status);

        const claims = await prisma.financialOperation.findMany({
            where: { userId: user.id, key: 'cross-2' },
        });
        expect(claims.length).toBe(1);
    });

    test('A4. same key via the alias with a materially different body → fails closed, handler never runs', async () => {
        const user = await seedUser(prisma, {});
        await drive({ mount: CANONICAL_BASE, policy: canonicalPolicy, userId: user.id, key: 'cross-3', body: { amount: '50.00', destination: '0244556677' } });
        expect(executions).toBe(1);

        // A different amount under the SAME key via the alias is NOT the same
        // logical withdrawal — the authority must refuse it, not execute it.
        // (r42 fingerprint fail-closed: IDEMPOTENCY_PAYLOAD_CONFLICT.)
        const divergent = await drive({ mount: ALIAS_BASE, policy: aliasPolicy, userId: user.id, key: 'cross-3', body: { amount: '999.00', destination: '0244556677' } });
        expect(executions).toBe(1);
        expect(divergent.status).toBe(409);
        expect(divergent.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
    });

    test('A5. different keys on the two paths remain independent operations', async () => {
        const user = await seedUser(prisma, {});
        const a = await drive({ mount: CANONICAL_BASE, policy: canonicalPolicy, userId: user.id, key: 'k-a', body: { amount: '10.00', destination: '0244556677' } });
        const b = await drive({ mount: ALIAS_BASE, policy: aliasPolicy, userId: user.id, key: 'k-b', body: { amount: '10.00', destination: '0244556677' } });
        expect(a.status).toBe(202);
        expect(b.status).toBe(202);
        expect(executions).toBe(2);
        const claims = await prisma.financialOperation.findMany({ where: { userId: user.id } });
        expect(claims.length).toBe(2);
    });
});
