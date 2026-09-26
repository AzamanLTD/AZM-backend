// __tests__/idempotency.test.js
// Unit tests for the r42 idempotency middleware — the shared financial
// idempotency authority. Pure mocked-prisma logic tests — no database
// required (the real-PostgreSQL proofs live in
// r42-shared-idempotency-authority.pg.test.js).
//
// These assert the CONTRACT, which r42 deliberately inverted from the old
// response-cache design:
//   - fail-CLOSED (503, handler never invoked) when the authority is
//     unavailable — a financial endpoint must refuse rather than execute
//     unprotected;
//   - permanent claims (no TTL, no expiry re-arming);
//   - claim-before-execute via a unique INSERT (not a find-then-create race);
//   - deterministic 409s for in-flight duplicates and payload conflicts;
//   - RETAIN on 5xx (default) and RELEASE on 5xx where configured.

const { idempotency, fingerprintOf } = require('../middleware/idempotency');

function mockReqRes(headers = {}, user = { id: 1 }, body = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/trades/initiate',
        path: '/api/trades/initiate',
        url: '/api/trades/initiate',
        baseUrl: '',
        route: { path: '/api/trades/initiate' },
        params: {},
        query: {},
        headers,
        body,
        user,
    };
    const res = {
        statusCode: 200,
        _json: null,
        locals: {},
        headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(body) {
            if (!this.headersSent) { this.headersSent = true; this._json = body; }
            return this;
        },
        setHeader() {},
        end() { this.headersSent = true; return this; },
    };
    const next = jest.fn(async () => {
        // a stand-in financial handler: records that economics were entered
        req._handlerRan = true;
        res.status(200).json({ success: true, handler: 'ran' });
    });
    return { req, res, next };
}

// A mocked prisma exposing ONLY financialOperation, with controllable rows.
function mockPrisma(rows = {}, opts = {}) {
    return {
        financialOperation: {
            create: async ({ data }) => {
                const tuple = `${data.userId}|${data.endpoint}|${data.key}`;
                if (rows[tuple]) {
                    const err = new Error('Unique constraint failed');
                    err.code = 'P2002';
                    err.meta = { target: ['userId', 'endpoint', 'key'] };
                    throw err;
                }
                const row = { ...data, id: 'op-1', status: 'IN_PROGRESS', statusCode: null, responseBody: null };
                rows[tuple] = row;
                return row;
            },
            findUnique: async ({ where }) => rows[`${where.userId_endpoint_key.userId}|${where.userId_endpoint_key.endpoint}|${where.userId_endpoint_key.key}`] || null,
            updateMany: async ({ where, data }) => {
                const w = where.userId_endpoint_key
                    ? `${where.userId_endpoint_key.userId}|${where.userId_endpoint_key.endpoint}|${where.userId_endpoint_key.key}`
                    : Object.keys(rows).find((k) => rows[k].id === where.id);
                if (rows[w] && (where.status === undefined || rows[w].status === where.status)) {
                    Object.assign(rows[w], data);
                    return { count: 1 };
                }
                return { count: 0 };
            },
            deleteMany: async ({ where }) => {
                const k = Object.keys(rows).find((key) => rows[key].id === where.id);
                if (k && (where.status === undefined || rows[k].status === where.status)) {
                    delete rows[k];
                    return { count: 1 };
                }
                return { count: 0 };
            },
            ...(opts.throwOn ? { [opts.throwOn]: async () => { throw opts.err ?? new Error('db down'); } } : {}),
        },
    };
}

describe('Idempotency middleware (r42 contract)', () => {
    test('passes through when no Idempotency-Key header', () => {
        const { req, res, next } = mockReqRes({});
        req.app = { get: () => mockPrisma({}) };
        idempotency()(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    test('FAILS CLOSED when prisma is not available — handler never invoked', async () => {
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'test-key-123' });
        req.app = { get: () => null };
        await idempotency()(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res._json.code).toBe('IDEMPOTENCY_UNAVAILABLE');
    });

    test('FAILS CLOSED when the claim authority model is not available', async () => {
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'test-key-123' });
        req.app = { get: () => ({ financialOperation: null }) };
        await idempotency()(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res._json.code).toBe('IDEMPOTENCY_UNAVAILABLE');
    });

    test('FAILS CLOSED on a claim-layer database error — handler never invoked', async () => {
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'test-key-123' });
        req.app = { get: () => mockPrisma({}, { throwOn: 'create' }) };
        await idempotency()(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });

    test('claims BEFORE execute: first request inserts a claim and proceeds', async () => {
        const rows = {};
        const { req, res } = mockReqRes({ 'idempotency-key': 'fresh-key' }, { id: 7 }, { amount: 10 });
        req.app = { get: () => mockPrisma(rows) };
        let statusInsideHandler = null;
        await idempotency()(req, res, async () => {
            // observed AT HANDLER ENTRY — the claim must already exist and be
            // IN_PROGRESS (the unique INSERT ran before economics)
            const claim = Object.values(rows)[0];
            statusInsideHandler = claim?.status;
            res.status(200).json({ success: true });
        });
        expect(statusInsideHandler).toBe('IN_PROGRESS');
        const claim = Object.values(rows)[0];
        expect(claim.endpoint).toBe('POST /api/trades/initiate');
        expect(claim.userId).toBe(7);
    });

    test('replays a COMMITTED result without invoking the handler', async () => {
        const committed = {
            status: 'COMMITTED', statusCode: 200,
            fingerprint: fingerprintOf(mockReqRes({ 'idempotency-key': 'committed-key' }).req),
            responseBody: { success: true, tradeId: 42 },
        };
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'committed-key' });
        // findUnique returns the committed row regardless of fingerprint match
        req.app = {
            get: () => ({
                financialOperation: {
                    create: async () => { const e = new Error('conflict'); e.code = 'P2002'; throw e; },
                    findUnique: async () => committed,
                    updateMany: async () => ({ count: 1 }),
                    deleteMany: async () => ({ count: 1 }),
                },
            }),
        };
        await idempotency()(req, res, next);
        expect(next).not.toHaveBeenCalled(); // handler NOT invoked
        expect(res.statusCode).toBe(200);
        expect(res._json).toEqual(committed.responseBody); // byte-identical replay
    });

    test('refuses a duplicate while the first is IN_PROGRESS — deterministic 409', async () => {
        const inflight = {
            status: 'IN_PROGRESS', id: 'op-inflight', statusCode: null, responseBody: null,
        };
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'inflight-key' });
        req.app = {
            get: () => ({
                financialOperation: {
                    create: async () => { const e = new Error('conflict'); e.code = 'P2002'; throw e; },
                    findUnique: async () => inflight,
                    updateMany: async () => ({ count: 1 }),
                    deleteMany: async () => ({ count: 1 }),
                },
            }),
        };
        await idempotency()(req, res, next);
        expect(next).not.toHaveBeenCalled(); // economics never entered
        expect(res.statusCode).toBe(409);
        expect(res._json.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(res._json.operationId).toBe('op-inflight');
    });

    test('4xx validation failure releases the claim — the key is not poisoned', async () => {
        const rows = {};
        const prisma = mockPrisma(rows);
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'valid-key' });
        req.app = { get: () => prisma };
        const mw = idempotency();
        await mw(req, res, async () => {
            res.status(400).json({ success: false, code: 'VALIDATION' });
        });
        await new Promise((r) => setTimeout(r, 25)); // let release bookkeeping land
        const claim = Object.values(rows)[0];
        expect(claim).toBeUndefined(); // claim deleted → retry may execute
    });

    test('5xx with RETAIN (default) keeps the claim IN_PROGRESS — same key refuses', async () => {
        const rows = {};
        const prisma = mockPrisma(rows);
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'retain-key' });
        req.app = { get: () => prisma };
        const mw = idempotency(); // default failurePolicy: RETAIN
        await mw(req, res, async () => {
            res.status(500).json({ success: false, code: 'LOST_AFTER_COMMIT' });
        });
        await new Promise((r) => setTimeout(r, 25));
        const claim = Object.values(rows)[0];
        expect(claim.status).toBe('IN_PROGRESS'); // poisoned key — deterministic refusal
    });

    test('5xx with RELEASE clears the claim when the transaction provably rolled back', async () => {
        const rows = {};
        const prisma = mockPrisma(rows);
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'release-key' });
        req.app = { get: () => prisma };
        const mw = idempotency({ failurePolicy: 'RELEASE' });
        await mw(req, res, async () => {
            res.status(500).json({ success: false, code: 'ROLLED_BACK' });
        });
        await new Promise((r) => setTimeout(r, 25));
        const claim = Object.values(rows)[0];
        expect(claim).toBeUndefined(); // claim released → same key may retry
    });

    test('a 2xx commits the claim to COMMITTED with the delivered response', async () => {
        const rows = {};
        const prisma = mockPrisma(rows);
        const { req, res, next } = mockReqRes({ 'idempotency-key': 'ok-key' });
        req.app = { get: () => prisma };
        await idempotency()(req, res, next);
        await new Promise((r) => setTimeout(r, 25));
        const claim = Object.values(rows)[0];
        expect(claim.status).toBe('COMMITTED');
        expect(claim.statusCode).toBe(200);
        expect(claim.responseBody).toEqual({ success: true, handler: 'ran' });
    });
});
