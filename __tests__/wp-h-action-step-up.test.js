// §WP-H G — action-bound step-up grants, proved against real PostgreSQL.
//
// The grant is the authorisation for ONE economic action. These tests prove the
// binding (amount, currency, recipient, operation, idempotency identity, user),
// the single-use consumption, the transaction coupling, and that no plaintext
// token is ever persisted.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { createDisposableDatabase } = require('./helpers/disposableDatabase');
const S = require('../src/services/actionStepUpService');

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const ACTION = {
    method: 'POST',
    route: '/api/withdrawals/fiat',
    operation: 'GHS_WITHDRAWAL',
    currency: 'GHS',
    amount: '1250.00',
    destination: '0244000000',
    resource: null,
    idempotencyKey: 'idem-abc-1',
};

d('WP-H action-bound step-up grant (real PostgreSQL)', () => {
    let disposable;
    let prisma;

    beforeAll(async () => {
        disposable = await createDisposableDatabase('stepup');
        prisma = new PrismaClient({ datasources: { db: { url: disposable.url } } });
    }, 300000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        if (disposable) await disposable.drop();
    }, 120000);

    const issue = (over = {}) => S.issueGrant(prisma, {
        userId: 'user-1',
        actionType: 'FIAT_WITHDRAWAL',
        routeScope: '/api/withdrawals/fiat',
        action: ACTION,
        idempotencyKey: ACTION.idempotencyKey,
        ...over,
    });

    test('the stored row never contains the plaintext token', async () => {
        const { token } = await issue();
        const rows = await prisma.$queryRawUnsafe('SELECT * FROM "ActionStepUpGrant"');
        const flat = JSON.stringify(rows);
        expect(flat.includes(token)).toBe(false);
        expect(rows.some((r) => r.tokenHash === S.hashToken(token))).toBe(true);
    });

    test('a grant is consumed exactly once', async () => {
        const { token } = await issue();
        const first = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
        expect(first.ok).toBe(true);
        const second = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
        expect(second.ok).toBe(false);
        expect(second.reason).toBe(S.REASON.ALREADY_USED);
    });

    test('a rolled-back economic write does not spend the grant', async () => {
        const { token } = await issue();
        await expect(prisma.$transaction(async (tx) => {
            const verdict = await S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' });
            expect(verdict.ok).toBe(true);
            throw new Error('economic write failed');
        })).rejects.toThrow('economic write failed');

        const retry = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
        expect(retry.ok).toBe(true);
    });

    test('every material field is bound: amount, currency, recipient, operation, idempotency key', async () => {
        const cases = [
            { amount: '9999.00' },
            { currency: 'USDC' },
            { destination: '0200000000' },
            { operation: 'GHS_DEPOSIT' },
            { idempotencyKey: 'idem-abc-2' },
            { route: '/api/withdrawals/other' },
        ];
        for (const mutation of cases) {
            const { token } = await issue();
            const verdict = await prisma.$transaction((tx) => S.consumeGrant(tx, {
                token, userId: 'user-1', action: { ...ACTION, ...mutation }, actionType: 'FIAT_WITHDRAWAL',
            }));
            expect(verdict.ok).toBe(false);
            expect(verdict.reason).toBe(S.REASON.ACTION_MISMATCH);
            // The grant is still spendable for the action it was issued for.
            const own = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
            expect(own.ok).toBe(true);
        }
    });

    test('another user cannot spend it', async () => {
        const { token } = await issue();
        const verdict = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-2', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe(S.REASON.WRONG_USER);
    });

    test('an expired grant refuses', async () => {
        const { token } = await issue({ ttlSeconds: -1 });
        const verdict = await prisma.$transaction((tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }));
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe(S.REASON.EXPIRED);
    });

    test('concurrent consumption has exactly one winner', async () => {
        const { token } = await issue();
        const attempts = await Promise.all([1, 2, 3, 4, 5].map(() => prisma.$transaction(
            (tx) => S.consumeGrant(tx, { token, userId: 'user-1', action: ACTION, actionType: 'FIAT_WITHDRAWAL' }),
        )));
        const winners = attempts.filter((a) => a.ok === true);
        expect(winners.length).toBe(1);
        expect(attempts.filter((a) => a.ok === false).length).toBe(4);
    });

    test('the TTL constant is 60 seconds', () => {
        expect(S.STEP_UP_TTL_SECONDS).toBe(60);
    });
});
