// __tests__/refresh-login-streak.test.js
// =============================================================================
// Regression test for the "daily logins aren't recording" bug (2026-07-06).
//
// Root cause: POST /api/auth/refresh (which fires silently on almost every
// app re-open once a user has a valid session) never touched
// loginStreak/lastLoginAt at all -- only the explicit POST /api/auth/login
// endpoint did. Since refresh-token rotation keeps most users signed in
// indefinitely, the streak was frozen at day 1 for any normal "just open the
// app" flow. Fixed by wiring services/loginStreakService.recordDailyLogin()
// into refreshController.refresh() too.
//
// Hits a real Express app + database via Supertest, same pattern as
// __tests__/auth.test.js. Skips (not fails) without TEST_DATABASE_URL.
//
// TIME-ANCHORING (fixed 2026-07-07): backdate lastLoginAt using UTC
// calendar-day arithmetic (Date.UTC(...) at noon), NOT a raw millisecond
// offset like "Date.now() - 25h". A raw offset is flaky right around UTC
// midnight -- e.g. if the suite happens to run at 00:39 UTC, "25h ago"
// lands on the day BEFORE yesterday (a 2-day gap), not yesterday (a 1-day
// gap), because it crosses two midnight boundaries instead of one. Anchoring
// to noon UTC on the actual target calendar day is immune to what wall-clock
// time the test happens to execute at.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[refresh-login-streak.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Login streak is recorded on token refresh, not just /login', () => {
    let app;
    let request;
    let prisma;
    const unique = `rstreak_${Date.now()}`;
    const creds = { email: `${unique}@azaman.test`, username: unique, password: 'Str0ng!Pass#2026' };
    let refreshToken;
    let userId;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        request = require('supertest');
        app = require('../server');
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('setup: register + login establishes day-1 streak', async () => {
        const reg = await request(app).post('/api/auth/register').send(creds);
        expect([200, 201]).toContain(reg.statusCode);

        const login = await request(app).post('/api/auth/login').send({ email: creds.email, password: creds.password });
        expect(login.statusCode).toBe(200);
        refreshToken = login.body.refreshToken;
        userId = login.body.user?.id;
        expect(refreshToken).toBeTruthy();

        const user = await prisma.user.findUnique({ where: { id: userId } });
        expect(user.loginStreak).toBe(1);
    });

    test('refreshing on the SAME calendar day does not change the streak', async () => {
        const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(res.statusCode).toBe(200);
        refreshToken = res.body.refreshToken; // rotate for next call

        const user = await prisma.user.findUnique({ where: { id: userId } });
        expect(user.loginStreak).toBe(1); // unchanged — same day
    });

    test('refreshing after the calendar day has rolled over DOES advance the streak (the actual bug)', async () => {
        // Simulate "yesterday's last login" anchored to an actual calendar
        // day (noon UTC yesterday), not a raw hour offset — see the
        // TIME-ANCHORING note in the file header for why that's flaky.
        const now = new Date();
        const yesterdayNoonUtc = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0
        ));
        await prisma.user.update({
            where: { id: userId },
            data: { lastLoginAt: yesterdayNoonUtc },
        });

        const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(res.statusCode).toBe(200);
        refreshToken = res.body.refreshToken;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        // Before the fix this would still read 1 -- refresh never touched it.
        expect(user.loginStreak).toBe(2);
    });

    test('a broken streak (2+ day gap) resets to 1 on refresh, not just on /login', async () => {
        // Same anchoring approach — 4 calendar days back at noon UTC, immune
        // to what wall-clock time the suite happens to run at.
        const now = new Date();
        const fourDaysAgoNoonUtc = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 4, 12, 0, 0
        ));
        await prisma.user.update({
            where: { id: userId },
            data: { lastLoginAt: fourDaysAgoNoonUtc },
        });

        const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(res.statusCode).toBe(200);

        const user = await prisma.user.findUnique({ where: { id: userId } });
        expect(user.loginStreak).toBe(1);
    });
});
