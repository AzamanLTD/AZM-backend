// __tests__/idempotency-claim-release-retry.test.js
// =============================================================================
// r42 claim RELEASE robustness.
//
// The release is a conditional delete (id + IN_PROGRESS) that must finish
// BEFORE the response leaves. When it failed, the client saw its 400 while the
// claim stayed IN_PROGRESS, so the corrected retry carrying the same key was
// refused with 409 by a phantom identity — the transit-booking-identity T9
// flake. The release now retries VERIFIED TRANSIENT database errors within a
// fixed budget and reports exhaustion loudly, without changing the fail-closed
// disposition.
//
// Pure mocked-prisma contract tests (no database). The real-PostgreSQL proofs
// stay in transit-booking-identity.pg.test.js and the r42 authority suite.
// =============================================================================

const logger = require('../src/config/logger');
const {
    idempotency,
    isTransientDbError,
    CLAIM_RELEASE_MAX_ATTEMPTS,
} = require('../middleware/idempotency');

const KEY = 'key-release-retry';

function mockReqRes({ key = KEY, body = { seatIds: ['1A'] } } = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/transit/book',
        path: '/api/transit/book',
        url: '/api/transit/book',
        baseUrl: '',
        route: { path: '/api/transit/book' },
        params: {},
        query: {},
        headers: key === null ? {} : { 'idempotency-key': key },
        body,
        user: { id: 42 },
    };
    const res = {
        statusCode: 200,
        _json: null,
        locals: {},
        headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(payload) {
            if (!this.headersSent) { this.headersSent = true; this._json = payload; }
            return this;
        },
        setHeader() {},
        end() { this.headersSent = true; return this; },
    };
    return { req, res };
}

// Prisma stub whose deleteMany follows a scripted queue:
//   'ok'        -> delete the IN_PROGRESS row, count 1
//   'transient' -> throw a deadlock/serialization wrapper (retriable)
//   'permanent' -> throw a non-retriable constraint error
//   'committed' -> the row transitioned to COMMITTED; predicate no longer
//                  matches, so the delete is a no-op (count 0), never a failure
function makePrisma(deleteScript = [], opts = {}) {
    const rows = {};
    const calls = { deleteMany: [], create: 0 };
    let deleteIndex = 0;

    const tupleOf = (where) => `${where.userId}|${where.endpoint}|${where.key}`;

    return {
        rows,
        calls,
        financialOperation: {
            create: async ({ data }) => {
                calls.create += 1;
                const tuple = tupleOf(data);
                if (rows[tuple]) {
                    const err = new Error('Unique constraint failed');
                    err.code = 'P2002';
                    err.meta = { target: ['userId', 'endpoint', 'key'] };
                    throw err;
                }
                rows[tuple] = {
                    ...data,
                    id: `op-${calls.create}`,
                    status: 'IN_PROGRESS',
                    statusCode: null,
                    responseBody: null,
                };
                return rows[tuple];
            },
            findUnique: async ({ where }) => {
                const k = where.userId_endpoint_key;
                return k ? (rows[tupleOf(k)] || null) : null;
            },
            updateMany: async ({ where, data }) => {
                const k = Object.keys(rows).find((t) => rows[t].id === where.id);
                if (k && (where.status === undefined || rows[k].status === where.status)) {
                    Object.assign(rows[k], data);
                    return { count: 1 };
                }
                return { count: 0 };
            },
            deleteMany: async ({ where }) => {
                calls.deleteMany.push(where);
                const behaviour = deleteScript[deleteIndex] || opts.defaultDelete || 'ok';
                deleteIndex += 1;
                if (behaviour === 'transient') {
                    const err = new Error('Transaction failed due to a write conflict or a deadlock');
                    err.code = 'P2034';
                    throw err;
                }
                if (behaviour === 'deadlock_raw') {
                    const err = new Error('Raw query failed');
                    err.code = 'P2010';
                    err.meta = { code: 'P2010', message: 'Raw query failed. Code: `40P01`. Message: `deadlock detected`' };
                    throw err;
                }
                if (behaviour === 'permanent') {
                    const err = new Error('Foreign key constraint failed on the field: `userId`');
                    err.code = 'P2003';
                    throw err;
                }
                const k = Object.keys(rows).find((t) => rows[t].id === where.id);
                if (!k) return { count: 0 };
                if (behaviour === 'committed') {
                    rows[k].status = 'COMMITTED';
                    return { count: 0 };
                }
                if (where.status !== undefined && rows[k].status !== where.status) return { count: 0 };
                delete rows[k];
                return { count: 1 };
            },
        },
    };
}

// Drives one keyed request. `finalStatus` is what the financial handler does.
async function drive(mw, prisma, { finalStatus = 400, key = KEY, body } = {}) {
    const { req, res } = mockReqRes({ key, body });
    req.app = { get: () => prisma };
    const next = async () => {
        if (finalStatus >= 400) {
            res.status(finalStatus).json({ success: false, message: 'seat already taken' });
        } else {
            res.status(finalStatus).json({ success: true, booking: { seatIds: ['1B'] } });
        }
    };
    await mw(req, res, next);
    // A release disposition delivers the response AFTER the release attempt
    // finishes; wait for delivery so every assertion sees the real ordering.
    await settle(() => res._json !== null);
    return { req, res };
}

// The release runs on the response path; wait for it to settle.
async function settle(predicate, tries = 400) {
    for (let i = 0; i < tries; i += 1) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 1));
    }
    return predicate();
}

describe('claim release retry — transient database errors', () => {
    let errorSpy;
    let warnSpy;

    beforeEach(() => {
        errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('one transient failure then success: the claim is deleted before the '
        + '400 is delivered and the SAME key is reusable', async () => {
        const prisma = makePrisma(['transient', 'ok']);
        const mw = idempotency({ releaseOn4xx: true, claimReleaseRetry: { attempts: 3, delayMs: 0 } });

        const { res } = await drive(mw, prisma);
        expect(res.statusCode).toBe(400);
        expect(res._json.message).toBe('seat already taken');

        // Release happened, and it happened BEFORE the response left.
        expect(await settle(() => prisma.calls.deleteMany.length === 2)).toBe(true);
        expect(Object.keys(prisma.rows)).toHaveLength(0);
        expect(res.locals.financialClaimReleaseFailure).toBeUndefined();
        expect(errorSpy).not.toHaveBeenCalled();

        // The same key now executes FRESH (no phantom identity, no 409).
        const { res: second } = await drive(mw, prisma, { finalStatus: 201, body: { seatIds: ['1B'] } });
        expect(second.statusCode).toBe(201);
        expect(second._json.success).toBe(true);
        expect(prisma.calls.create).toBe(2);
    });

    test('multiple transient failures then success: bounded attempts, never '
        + 'unbounded', async () => {
        const prisma = makePrisma(['transient', 'deadlock_raw', 'ok']);
        const mw = idempotency({ releaseOn4xx: true, claimReleaseRetry: { attempts: 3, delayMs: 0 } });

        const { res } = await drive(mw, prisma);
        expect(res.statusCode).toBe(400);
        expect(await settle(() => prisma.calls.deleteMany.length === 3)).toBe(true);
        expect(prisma.calls.deleteMany).toHaveLength(3);
        expect(Object.keys(prisma.rows)).toHaveLength(0);
        expect(res.locals.financialClaimReleaseFailure).toBeUndefined();
    });

    test('a transient storm is capped at the configured attempt budget', async () => {
        const prisma = makePrisma(['transient', 'transient', 'transient', 'transient', 'ok']);
        const mw = idempotency({ releaseOn4xx: true, claimReleaseRetry: { attempts: 3, delayMs: 0 } });

        const { res } = await drive(mw, prisma);
        expect(res.statusCode).toBe(400);
        expect(await settle(() => prisma.calls.deleteMany.length >= 3)).toBe(true);
        expect(prisma.calls.deleteMany).toHaveLength(3);
        const failure = res.locals.financialClaimReleaseFailure;
        expect(failure).toMatchObject({ code: 'IDEMPOTENCY_CLAIM_RELEASE_FAILED', attempts: 3, transient: true, exhausted: true });
        expect(errorSpy).toHaveBeenCalled();
    });

    test('permanent (non-transient) failure is not retried: claim stays '
        + 'IN_PROGRESS, no duplicate execution, failure is observable', async () => {
        const prisma = makePrisma(['permanent', 'permanent', 'permanent']);
        const mw = idempotency({ releaseOn4xx: true, claimReleaseRetry: { attempts: 3, delayMs: 0 } });

        const { res } = await drive(mw, prisma);
        expect(res.statusCode).toBe(400);

        expect(await settle(() => prisma.calls.deleteMany.length === 1)).toBe(true);
        expect(prisma.calls.deleteMany).toHaveLength(1); // NOT retried
        expect(Object.keys(prisma.rows)).toHaveLength(1); // claim survives, IN_PROGRESS
        expect(Object.values(prisma.rows)[0].status).toBe('IN_PROGRESS');

        const failure = res.locals.financialClaimReleaseFailure;
        expect(failure).toMatchObject({
            code: 'IDEMPOTENCY_CLAIM_RELEASE_FAILED',
            attempts: 1,
            transient: false,
            exhausted: false,
            errCode: 'P2003',
        });
        const logged = errorSpy.mock.calls.find(([, msg]) => /claim release FAILED/.test(String(msg)));
        expect(logged).toBeTruthy();
        expect(logged[0]).toMatchObject({ code: 'IDEMPOTENCY_CLAIM_RELEASE_FAILED', operationId: expect.any(String) });

        // A same-key retry can never execute twice: the retained claim refuses.
        const { res: retry } = await drive(mw, prisma, { finalStatus: 201 });
        expect(retry.statusCode).toBe(409);
        expect(retry._json.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        // The retry attempted a claim insert, hit the uniqueness guard and was
        // refused: still exactly ONE claim row, still IN_PROGRESS, zero
        // second executions of the financial handler.
        expect(Object.keys(prisma.rows)).toHaveLength(1);
        expect(Object.values(prisma.rows)[0].status).toBe('IN_PROGRESS');
    });

    test('a claim that becomes COMMITTED before the retry is preserved by the '
        + 'conditional predicate — a no-op, never a failure', async () => {
        const prisma = makePrisma(['transient', 'committed']);
        const mw = idempotency({ releaseOn4xx: true, claimReleaseRetry: { attempts: 3, delayMs: 0 } });

        const { res } = await drive(mw, prisma);
        expect(res.statusCode).toBe(400);
        expect(await settle(() => prisma.calls.deleteMany.length === 2)).toBe(true);

        // Every attempt kept the id + IN_PROGRESS predicate.
        for (const where of prisma.calls.deleteMany) {
            expect(where.status).toBe('IN_PROGRESS');
            expect(where.id).toEqual(expect.any(String));
        }
        // The committed row survived, and nothing was reported as a failure.
        expect(Object.values(prisma.rows)[0].status).toBe('COMMITTED');
        expect(res.locals.financialClaimReleaseFailure).toBeUndefined();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('production default budget is bounded and small', () => {
        expect(CLAIM_RELEASE_MAX_ATTEMPTS).toBeGreaterThan(1);
        expect(CLAIM_RELEASE_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
    });
});

describe('transient error classification', () => {
    test('retriable: Prisma conflict/timeout and connection codes', () => {
        for (const code of ['P1001', 'P1017', 'P2024', 'P2028', 'P2034']) {
            expect(isTransientDbError(Object.assign(new Error('x'), { code }))).toBe(true);
        }
    });

    test('retriable: SQLSTATE surfaced through cause or a raw-query wrapper', () => {
        const viaCause = Object.assign(new Error('serialization'), { cause: { code: '40001' } });
        expect(isTransientDbError(viaCause)).toBe(true);

        const raw = Object.assign(new Error('Raw query failed'), {
            code: 'P2010',
            meta: { message: 'Raw query failed. Code: `40P01`. Message: `deadlock detected`' },
        });
        expect(isTransientDbError(raw)).toBe(true);

        const lockTimeout = Object.assign(new Error('lock'), { meta: { code: '55P03' } });
        expect(isTransientDbError(lockTimeout)).toBe(true);
    });

    test('NOT retriable: constraint, record-not-found, business and plain errors', () => {
        for (const code of ['P2002', 'P2003', 'P2025', 'P2010']) {
            expect(isTransientDbError(Object.assign(new Error('x'), { code }))).toBe(false);
        }
        expect(isTransientDbError(new Error('seat already taken'))).toBe(false);
        expect(isTransientDbError(null)).toBe(false);
        expect(isTransientDbError(undefined)).toBe(false);
    });
});
