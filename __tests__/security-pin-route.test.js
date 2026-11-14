// __tests__/security-pin-route.test.js
// =============================================================================
// Exercises the REAL Express route and middleware for POST /api/security/pin/set.
// The helper-method-only tests were not enough: the route previously called a
// helper that did not exist and every request died as HTTP 500.
// =============================================================================

process.env.APP_UNLOCK_PIN_MAX_ATTEMPTS = '5';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
}));

const securityRoutes = require('../routes/securityRoutes');
const { AppUnlockService } = require('../services/appUnlockService');

// Attempt budgets are shared state. Every case here authenticates as user 1,
// so without a reset one case spends another case's budget.
beforeEach(() => {
    AppUnlockService._resetMemoryState();
});

function buildApp(userRow) {
    const app = express();
    app.use(express.json());
    const prisma = {
        user: {
            findUnique: jest.fn(async () => ({ ...userRow })),
            update: jest.fn(async ({ data }) => { Object.assign(userRow, data); return userRow; }),
            // Compare-and-swap: only matches when the stored hash is unchanged.
            updateMany: jest.fn(async ({ where, data }) => {
                if ('pinHash' in where && where.pinHash !== (userRow.pinHash ?? null)) return { count: 0 };
                Object.assign(userRow, data);
                return { count: 1 };
            }),
        },
    };
    app.set('prisma', prisma);
    app.set('smsService', { sendSMS: jest.fn(async () => ({ success: true, mocked: true })) });
    app.use('/', securityRoutes);
    return { app, prisma };
}

describe('POST /api/security/pin/set (real route)', () => {
    test('first-time enrolment succeeds', async () => {
        const user = { id: 1, pinHash: null, isTwoFactorEnabled: false };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '4321' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
        expect(await bcrypt.compare('4321', prisma.user.updateMany.mock.calls[0][0].data.pinHash)).toBe(true);
    });

    test('rotating without the current PIN is refused, not a 500', async () => {
        const user = { id: 1, pinHash: await bcrypt.hash('1234', 10) };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '9999' });

        expect(res.status).toBeLessThan(500);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('PIN_CURRENT_REQUIRED');
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    test('rotating with the correct current PIN succeeds', async () => {
        const user = { id: 1, pinHash: await bcrypt.hash('1234', 10) };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '5678', currentPin: '1234' });

        expect(res.status).toBe(200);
        expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
        expect(await bcrypt.compare('5678', prisma.user.updateMany.mock.calls[0][0].data.pinHash)).toBe(true);
    });

    test('a wrong current PIN is refused and the stored hash is unchanged', async () => {
        const original = await bcrypt.hash('1234', 10);
        const user = { id: 1, pinHash: original };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '5678', currentPin: '0000' });

        expect(res.body.success).toBe(false);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(user.pinHash).toBe(original);
    });

    test('a malformed body is refused at the validation boundary', async () => {
        const user = { id: 1, pinHash: null };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '12ab' });

        expect(res.status).toBe(400);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    test('an over-long currentPin is refused by the schema', async () => {
        const user = { id: 1, pinHash: await bcrypt.hash('1234', 10) };
        const { app, prisma } = buildApp(user);
        const res = await request(app).post('/pin/set').send({ pin: '5678', currentPin: '123456789' });

        expect(res.status).toBe(400);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    test('concurrent guesses only buy as many comparisons as the budget allows', async () => {
        const hash = await bcrypt.hash('1234', 10);
        const user = { id: 1, pinHash: hash };
        const { app } = buildApp(user);

        const spy = jest.spyOn(bcrypt, 'compare');
        spy.mockClear();

        // 9 parallel wrong guesses against a budget of 5: at most 5 may ever
        // reach the expensive comparison. This is the property a
        // check-then-increment implementation cannot provide.
        await Promise.all(Array.from({ length: 9 }, (_, i) =>
            request(app).post('/pin/set').send({ pin: `000${i}`, currentPin: `9000` })));

        expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
        spy.mockRestore();
    });
});

describe('concurrent rotation and PIN length', () => {
    test('two rotations with the same old PIN: exactly one wins', async () => {
        const oldHash = await bcrypt.hash('1234', 10);
        const userRow = { id: 1, pinHash: oldHash };
        const { app } = buildApp(userRow);

        const [a, b] = await Promise.all([
            request(app).post('/pin/set').send({ pin: '1111', currentPin: '1234' }),
            request(app).post('/pin/set').send({ pin: '2222', currentPin: '1234' }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 409]);
        const loser = [a, b].find((r) => r.status === 409);
        expect(loser.body.code).toBe('PIN_ROTATION_CONFLICT');
    });

    test('a five digit PIN is refused at the boundary', async () => {
        const { app, prisma } = buildApp({ id: 1, pinHash: null });
        const res = await request(app).post('/pin/set').send({ pin: '12345' });
        expect(res.status).toBeLessThan(500);
        expect(res.body.success).toBe(false);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
});
