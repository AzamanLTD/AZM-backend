// __tests__/sso-no-unsigned-fallback.test.js
// =============================================================================
// Route-level proof that POST /api/auth/sso can never authenticate an unsigned
// token. These call the real controller handler (controllers/ssoController.js)
// and stub only its collaborators, so the readiness check and the verification
// call under test are the production ones.
//
// Background: the removed SSO_DEV_FALLBACK=1 branch decoded the JWT payload
// without checking the signature, then trusted its aud, email and subject.
// With NODE_ENV unset (the unsafe side of a `=== 'production'` test) an
// unsigned token with no exp claim could create a user and mint a session.
// =============================================================================

jest.mock('../src/config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Mutable so each case can choose whether Firebase Admin is initialised and
// what verification returns. The `mock` prefix is required for jest's hoisted
// factory to close over them.
let mockApps = [];
let mockVerify = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: () => mockApps }));
jest.mock('firebase-admin/auth', () => ({
    getAuth: () => ({ verifyIdToken: (...args) => mockVerify(...args) }),
}));

let mockIssueTokenPair = jest.fn();
jest.mock('../services/authTokenService', () => ({
    issueTokenPair: (...args) => mockIssueTokenPair(...args),
}));

const PROJECT = 'azaman-app';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unsignedToken = (claims = {}) => {
    const payload = {
        aud: PROJECT,
        iss: `https://securetoken.google.com/${PROJECT}`,
        sub: 'attacker-uid',
        user_id: 'attacker-uid',
        email: 'attacker@example.com',
        auth_time: 1_700_000_000,
        iat: 1_700_000_000,
        ...claims,
    };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete payload[k];
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
};

function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function prismaStub({ existingUser = null } = {}) {
    return {
        user: {
            findUnique: jest.fn(async () => existingUser),
            create: jest.fn(async ({ data }) => ({ id: 'new-user-1', ...data })),
            update: jest.fn(async ({ data }) => ({ id: 'new-user-1', ...data })),
        },
    };
}

/**
 * Loads the controller with a specific environment, then runs one request.
 * The environment is applied BEFORE the module is required (the controller
 * reads its optional audience pin at load time) and held for the whole call,
 * then restored, so no other suite inherits the mutation.
 */
async function request(token, { env = {}, apps = [], verify, prisma } = {}) {
    const saved = { ...process.env };
    delete process.env.NODE_ENV;
    delete process.env.SSO_DEV_FALLBACK;
    delete process.env.SSO_EXPECTED_AUD;
    delete process.env.FIREBASE_PROJECT_ID;
    Object.assign(process.env, env);

    mockApps = apps;
    mockVerify = verify || jest.fn();
    const p = prisma || prismaStub();

    try {
        let controller;
        jest.isolateModules(() => {
            controller = require('../controllers/ssoController');
        });
        const res = fakeRes();
        const req = {
            body: { idToken: token, provider: 'google' },
            headers: {},
            ip: '127.0.0.1',
            app: { get: () => p },
        };
        await controller.ssoLogin(req, res);
        return { res, prisma: p };
    } finally {
        process.env = saved;
    }
}

beforeEach(() => {
    mockIssueTokenPair = jest.fn(async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        refreshExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    }));
    mockApps = [];
    mockVerify = jest.fn();
});

describe('SSO refuses every unverified path (503 when Firebase Admin is absent)', () => {
    const cases = [
        ['NODE_ENV unset, flag unset', {}],
        ['NODE_ENV unset, flag on', { SSO_DEV_FALLBACK: '1' }],
        ['development, flag on', { NODE_ENV: 'development', SSO_DEV_FALLBACK: '1' }],
        ['test, flag on', { NODE_ENV: 'test', SSO_DEV_FALLBACK: '1' }],
        ['production, flag on', { NODE_ENV: 'production', SSO_DEV_FALLBACK: '1' }],
    ];

    test.each(cases)('%s with the audience configured', async (_label, env) => {
        const { res, prisma } = await request(unsignedToken(), {
            env: { ...env, SSO_EXPECTED_AUD: PROJECT },
            apps: [],
        });
        expect(res.statusCode).toBe(503);
        expect(res.body.success).toBe(false);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockIssueTokenPair).not.toHaveBeenCalled();
    });

    test('the flag alone cannot enable an unsigned path', async () => {
        const { res } = await request(unsignedToken(), {
            env: { SSO_DEV_FALLBACK: '1', SSO_EXPECTED_AUD: PROJECT },
            apps: [],
        });
        expect(res.statusCode).toBe(503);
    });
});

describe('SSO rejects forged tokens that look legitimate', () => {
    test('an unsigned token with a correct aud and no exp is rejected', async () => {
        const token = unsignedToken({ exp: undefined });
        const { res, prisma } = await request(token, {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [],
        });
        expect(res.statusCode).toBe(503);
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    test('an unsigned token without exp is rejected even when Admin is present but rejects', async () => {
        const verify = jest.fn(async () => { throw new Error('invalid signature'); });
        const { res, prisma } = await request(unsignedToken({ exp: undefined }), {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [{ name: '[DEFAULT]' }],
            verify,
        });
        expect(res.statusCode).toBe(401);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(mockIssueTokenPair).not.toHaveBeenCalled();
    });

    test('a forged administrator-looking identity cannot create an account', async () => {
        const token = unsignedToken({ email: 'admin@azaman.me', role: 'ADMIN', admin: true });
        const { res, prisma } = await request(token, {
            env: { NODE_ENV: 'development', SSO_DEV_FALLBACK: '1', SSO_EXPECTED_AUD: PROJECT },
            apps: [],
        });
        expect(res.statusCode).toBe(503);
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockIssueTokenPair).not.toHaveBeenCalled();
    });

    test('no decode path survives a rejected verification', async () => {
        const verify = jest.fn(async () => { throw new Error('bad token'); });
        const { res, prisma } = await request(unsignedToken(), {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [{ name: '[DEFAULT]' }],
            verify,
        });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ success: false, message: 'Invalid or expired ID token.' });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
});

describe('SSO uses Firebase Admin as the only authority', () => {
    test('a verified token continues through the existing flow and mints a session', async () => {
        const verify = jest.fn(async () => ({
            uid: 'firebase-uid-1',
            sub: 'firebase-uid-1',
            email: 'real@example.com',
            name: 'Real User',
            aud: PROJECT,
        }));
        const { res, prisma } = await request('header.payload.signature', {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [{ name: '[DEFAULT]' }],
            verify,
        });
        expect(verify).toHaveBeenCalledWith('header.payload.signature');
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.accessToken).toBe('access-token');
        expect(res.body.refreshToken).toBe('refresh-token');
        expect(prisma.user.create).toHaveBeenCalledTimes(1);
        expect(mockIssueTokenPair).toHaveBeenCalledTimes(1);
    });

    test('the raw token string is what reaches verifyIdToken', async () => {
        const verify = jest.fn(async () => ({
            uid: 'u', sub: 'u', email: 'a@b.c', aud: PROJECT,
        }));
        const token = unsignedToken();
        await request(token, {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [{ name: '[DEFAULT]' }],
            verify,
        });
        expect(verify).toHaveBeenCalledWith(token);
    });

    test('a verified token with the wrong audience is refused after verification', async () => {
        const verify = jest.fn(async () => ({
            uid: 'u', sub: 'u', email: 'a@b.c', aud: 'some-other-project',
        }));
        const { res, prisma } = await request('header.payload.signature', {
            env: { SSO_EXPECTED_AUD: PROJECT },
            apps: [{ name: '[DEFAULT]' }],
            verify,
        });
        expect(verify).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(401);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(mockIssueTokenPair).not.toHaveBeenCalled();
    });
});

describe('the unsigned fallback is gone from the source', () => {
    test('no flag, no manual payload decode, no dev-fallback responses', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'ssoController.js'), 'utf8');
        expect(src).not.toMatch(/SSO_DEV_FALLBACK/);
        expect(src).not.toMatch(/dev-fallback/);
        expect(src).not.toMatch(/JSON\.parse\(\s*Buffer\.from\(\s*parts\[1\]/);
        expect(src).not.toMatch(/SSO dev-fallback misconfigured/);
    });
});
