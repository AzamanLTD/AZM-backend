// =============================================================================
// Admin 2FA routes (routes/adminRoutes.js /2fa/*).
//
// The routes used a column that does not exist (twoFactorEnabled; the User
// column is isTwoFactorEnabled), so an admin could never turn an
// authenticator on, and require2FA (which reads isTwoFactorEnabled) always
// fell back to the password. And /2fa/setup replaced the secret of an
// enabled authenticator with no check, so a stolen session could install
// its own and then pass every second-factor check (fee publishes,
// withdrawals). Both are pinned here.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/totpStepClaimService', () => {
    const actual = jest.requireActual('../src/services/totpStepClaimService');
    return { ...actual, verifyAndClaimTotp: jest.fn(async ({ token }) => (token === '123456' ? { ok: true } : { ok: false, code: 'TOTP_INVALID' })) };
});

const { table } = require('./helpers/transitPrismaFake');

let router;
beforeAll(() => { router = require('../routes/adminRoutes'); });

const handler = (method, path) => {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (method, path, db, body = {}) => {
    let status = 200; let payload = null;
    await handler(method, path)({
        app: { get: (k) => (k === 'prisma' ? db : null) }, user: { id: 7, email: 'ops@azaman.test' }, body,
    }, { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
    return { status, payload };
};
const makeDb = (u = {}) => ({ user: table([{ id: 7, isTwoFactorEnabled: false, twoFactorSecret: null, ...u }]) });

describe('admin 2FA', () => {
    test('setup, verify, status and disable use isTwoFactorEnabled', async () => {
        const db = makeDb();
        const setup = await call('post', '/2fa/setup', db);
        expect(setup.status).toBe(200);
        expect(db.user.rows[0].twoFactorSecret).toBe(setup.payload.secret);

        const verify = await call('post', '/2fa/verify', db, { token: '123456' });
        expect(verify.status).toBe(200);
        expect(db.user.rows[0].isTwoFactorEnabled).toBe(true);
        expect(db.user.rows[0]).not.toHaveProperty('twoFactorEnabled');

        const status = await call('get', '/2fa/status', db);
        expect(status.payload).toEqual({ success: true, enabled: true, hasSecret: true });

        expect((await call('post', '/2fa/disable', db, { token: '000000' })).status).toBe(400);
        expect(db.user.rows[0].isTwoFactorEnabled).toBe(true);
        expect((await call('post', '/2fa/disable', db, { token: '123456' })).status).toBe(200);
        expect(db.user.rows[0]).toEqual(expect.objectContaining({ isTwoFactorEnabled: false, twoFactorSecret: null }));
    });

    test('an enabled authenticator\'s secret cannot be replaced', async () => {
        const db = makeDb({ isTwoFactorEnabled: true, twoFactorSecret: 'ORIGINALSECRET' });
        const setup = await call('post', '/2fa/setup', db);
        expect(setup.status).toBe(409);
        expect(setup.payload.code).toBe('2FA_ALREADY_ENABLED');
        expect(db.user.rows[0].twoFactorSecret).toBe('ORIGINALSECRET');
    });

    test('verify refuses when already enabled', async () => {
        const db = makeDb({ isTwoFactorEnabled: true, twoFactorSecret: 'S' });
        expect((await call('post', '/2fa/verify', db, { token: '123456' })).status).toBe(400);
    });
});
