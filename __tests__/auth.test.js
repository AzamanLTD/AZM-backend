// __tests__/auth.test.js
// =============================================================================
// Auth integration tests (B-08) — register, login, protected access, expired
// token rejection, refresh rotation.
//
// These hit a real Express app + database via Supertest. That requires a
// disposable Postgres pointed at by TEST_DATABASE_URL. When it isn't set we
// SKIP the suite (rather than fail) so `npm test` stays green in environments
// without a DB (CI without a service container, a fresh checkout, this audit
// box). Set TEST_DATABASE_URL to a throwaway database to activate them.
//
// To run for real:
//   TEST_DATABASE_URL=postgres://... JWT_SECRET=$(openssl rand -hex 32) npm test
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // Leave a breadcrumb so a green run doesn't hide the fact these were skipped.
    // eslint-disable-next-line no-console
    console.warn(
        '[auth.test] TEST_DATABASE_URL not set — skipping auth integration tests. ' +
        'Set it to a disposable Postgres URL to enable them.'
    );
}

describeOrSkip('Auth flow (integration)', () => {
    let app;
    let request;
    const unique = `t_${Date.now()}`;
    const creds = { email: `${unique}@azaman.test`, username: unique, password: 'Str0ng!Pass#2026' };
    let accessToken;
    let refreshToken;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        request = require('supertest');
        // The app must export the Express instance without calling listen() in
        // test mode. server.js guards listen with NODE_ENV !== 'test'.
        app = require('../server');
    });

    test('register creates a new user', async () => {
        const res = await request(app).post('/api/auth/register').send(creds);
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.success).toBe(true);
    });

    test('login returns an access + refresh token', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: creds.email, password: creds.password });
        expect(res.statusCode).toBe(200);
        accessToken = res.body.accessToken || res.body.token;
        refreshToken = res.body.refreshToken;
        expect(accessToken).toBeTruthy();
        expect(refreshToken).toBeTruthy();
    });

    test('protected endpoint accepts a valid token', async () => {
        const res = await request(app)
            .get('/api/users/profile')
            .set('Authorization', `Bearer ${accessToken}`);
        expect(res.statusCode).toBe(200);
    });

    test('protected endpoint rejects a missing token with 401', async () => {
        const res = await request(app).get('/api/users/profile');
        expect(res.statusCode).toBe(401);
    });

    test('protected endpoint rejects a garbage token with 401', async () => {
        const res = await request(app)
            .get('/api/users/profile')
            .set('Authorization', 'Bearer not.a.real.jwt');
        expect(res.statusCode).toBe(401);
    });

    test('an expired token is rejected with code TOKEN_EXPIRED', async () => {
        const jwt = require('jsonwebtoken');
        // Mint a token that is already expired (exp in the past).
        const expired = jwt.sign(
            { id: 1, username: creds.username, role: 'USER', tokenVersion: 0, typ: 'access' },
            process.env.JWT_SECRET,
            { expiresIn: -10 }
        );
        const res = await request(app)
            .get('/api/users/profile')
            .set('Authorization', `Bearer ${expired}`);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    test('refresh rotates the token and the old refresh token stops working', async () => {
        const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(first.statusCode).toBe(200);
        expect(first.body.accessToken).toBeTruthy();
        const newRefresh = first.body.refreshToken;
        expect(newRefresh).toBeTruthy();
        expect(newRefresh).not.toBe(refreshToken);

        // Replaying the now-rotated original token must fail (one-time use).
        const replay = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(replay.statusCode).toBe(401);
        expect(replay.body.code).toBe('REFRESH_INVALID');
    });
});
