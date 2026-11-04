// __tests__/sso-fallback-characterisation.test.js
// =============================================================================
// CHARACTERISATION TEST - documents a live security weakness in production
// code. It asserts the CURRENT behaviour, including the insecure part, so the
// weakness is visible in CI rather than only in a review comment.
//
// It exercises the REAL controllers/ssoController.js handler. Nothing in
// production is modified or mocked at the logic level: only its external
// collaborators (firebase-admin readiness, Prisma, token issuance, logger) are
// stubbed, exactly as a route-level test would.
//
// WHEN THE FALLBACK IS REMOVED, the "accepts an unsigned token" test below
// must be inverted to expect a refusal. That inversion is the proof of the fix.
// =============================================================================
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('firebase-admin/app', () => ({ getApps: () => [] }));
// The real firebase-admin/auth expects a real app module; with the readiness
// stub above it cannot load. The fallback branch never calls getAuth(), so a
// stub that throws if reached is the faithful shape.
jest.mock('firebase-admin/auth', () => ({ getAuth: () => { throw new Error('getAuth called while uninitialised'); } }));
jest.mock('../services/authTokenService', () => ({
    issueTokenPair: jest.fn(async () => ({ accessToken: 'access', refreshToken: 'refresh', refreshExpiresAt: new Date() })),
}));

const PROJECT = 'azaman-app';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** An unsigned token: alg 'none', no signature, no exp, chosen identity. */
function forgedToken({ aud = PROJECT, email = 'attacker@example.com', sub = 'forged-sub', exp } = {}) {
    const header = b64({ alg: 'none', typ: 'JWT' });
    const claims = b64({ aud, iss: 'https://securetoken.google.com/' + aud, sub, email, ...(exp ? { exp } : {}) });
    return header + '.' + claims + '.';
}

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

function prismaStub() {
    return {
        user: {
            findUnique: jest.fn(async () => null),
            create: jest.fn(async ({ data }) => ({ id: 'user-1', ...data })),
            update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
        },
    };
}

/**
 * The flags SSO_DEV_FALLBACK / SSO_EXPECTED_AUD are read at module load, while
 * NODE_ENV is read at request time. Both must therefore be in effect for the
 * whole call, not just the require.
 */
async function callWith(env, { token, prisma }) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        let controller;
        jest.isolateModules(() => {
            controller = require('../controllers/ssoController');
        });
        const req = { body: { idToken: token, provider: 'google' }, headers: {}, ip: '127.0.0.1', app: { get: () => prisma } };
        const res = fakeRes();
        await controller.ssoLogin(req, res);
        return res;
    } finally {
        process.env = saved;
    }
}

const baseEnv = {
    SSO_DEV_FALLBACK: '1',
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_SERVICE_ACCOUNT: '',
    FIREBASE_SERVICE_ACCOUNT_BASE64: '',
};

describe('SSO fallback — current behaviour (documents the weakness)', () => {
    test('production refuses, even with the fallback flag set', async () => {
        const prisma = prismaStub();
        const res = await callWith({ ...baseEnv, NODE_ENV: 'production' }, { token: forgedToken(), prisma });
        expect(res.statusCode).toBe(503);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('a non-production env WITHOUT the flag refuses', async () => {
        const prisma = prismaStub();
        const res = await callWith({ ...baseEnv, NODE_ENV: 'development', SSO_DEV_FALLBACK: '0' }, { token: forgedToken(), prisma });
        expect(res.statusCode).toBe(503);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('a non-production env with the flag and no expected audience refuses', async () => {
        const prisma = prismaStub();
        const res = await callWith({
            NODE_ENV: 'development', SSO_DEV_FALLBACK: '1',
            FIREBASE_PROJECT_ID: '', SSO_EXPECTED_AUD: '', FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '',
        }, { token: forgedToken(), prisma });
        expect(res.statusCode).toBe(503);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('the audience guard does reject a foreign project', async () => {
        const prisma = prismaStub();
        const res = await callWith({ ...baseEnv, NODE_ENV: 'development' }, { token: forgedToken({ aud: 'someone-else' }), prisma });
        expect(res.statusCode).toBe(401);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    // THIS IS THE WEAKNESS. An unsigned token, with a correct project audience
    // and no exp claim, is accepted and reaches user creation + token issuance.
    // Possession of the Firebase project id (public, shipped in every client) is
    // the only thing an attacker needs in such an environment.
    test('ACCEPTS an unsigned token in a non-production env with the flag set', async () => {
        const prisma = prismaStub();
        const res = await callWith({ ...baseEnv, NODE_ENV: 'development' }, { token: forgedToken(), prisma });
        expect(prisma.user.findUnique).toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
    });

    test('ACCEPTS an unsigned token that carries no exp claim at all', async () => {
        const prisma = prismaStub();
        const res = await callWith({ ...baseEnv, NODE_ENV: 'development' }, { token: forgedToken({ exp: undefined }), prisma });
        expect(res.statusCode).toBe(201);
    });
});
