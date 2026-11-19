// §B5 — THE TRANSACTION CONSUMPTION CONTRACT EVERY PROTECTED ROUTE NOW USES.
//
// The six routes that previously only MOUNTED the gate now consume the grant
// inside their own economic transaction (escrowService.fundEscrow /
// markSatisfied, p2p.service.completeTrade, tradeController initiate/accept,
// the internal-transfer handler). All seven call ONE function,
// consumeStepUpOrThrow(tx, stepUp), so these proofs are the property each route
// relies on. Route-level end-to-end batteries are still owed per route.
'use strict';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);
const run = hasDb ? describe : describe.skip;

const { PrismaClient } = require('@prisma/client');
const { createDisposableDatabase } = require('./helpers/disposableDatabase');
const S = require('../src/services/actionStepUpService');

const ACTION = {
    actionType: 'INTERNAL_TRANSFER',
    routeScope: 'POST /api/wallet/internal-transfer',
    params: { direction: 'TO_POOL', amount: '25.00000000' },
    idempotencyKey: 'b5-consume-1',
};

run('§B5 transaction consumption contract (real PostgreSQL)', () => {
    let disposable;
    let prisma;
    const userId = 'user-consume-1';

    beforeAll(async () => {
        disposable = await createDisposableDatabase('b5consume');
        prisma = new PrismaClient({ datasources: { db: { url: disposable.url } } });
    }, 300000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        if (disposable) await disposable.drop();
    }, 120000);

    const issue = (over = {}) => S.issueGrant(prisma, {
        userId,
        actionType: ACTION.actionType,
        routeScope: ACTION.routeScope,
        action: ACTION,
        idempotencyKey: ACTION.idempotencyKey,
        ...over,
    });

    const consumedAt = async (token) => {
        const rows = await prisma.$queryRawUnsafe(
            'SELECT "consumedAt" FROM "ActionStepUpGrant" WHERE "tokenHash" = $1', S.hashToken(token));
        return rows[0] ? rows[0].consumedAt : undefined;
    };

    test('no context is a refusal, not an unguarded write', async () => {
        await expect(prisma.$transaction((tx) => S.consumeStepUpOrThrow(tx, null)))
            .rejects.toMatchObject({ code: 'STEP_UP_REJECTED', reason: 'MISSING_GRANT' });
    });

    test('a grant is spent inside the transaction it authorises', async () => {
        const { token } = await issue();
        const verdict = await prisma.$transaction((tx) =>
            S.consumeStepUpOrThrow(tx, { token, userId, actionType: ACTION.actionType, action: ACTION }));
        expect(verdict.ok).toBe(true);
        expect(await consumedAt(token)).not.toBeNull();
    });

    test('a rolled-back economic write releases the grant', async () => {
        const { token } = await issue({ idempotencyKey: 'b5-consume-rollback' });
        await expect(prisma.$transaction(async (tx) => {
            await S.consumeStepUpOrThrow(tx, { token, userId, actionType: ACTION.actionType, action: ACTION });
            throw new Error('economic write failed after consumption');
        })).rejects.toThrow('economic write failed');
        // The consumedAt UPDATE rolled back with the transaction: still spendable.
        expect(await consumedAt(token)).toBeNull();
        const retry = await prisma.$transaction((tx) =>
            S.consumeStepUpOrThrow(tx, { token, userId, actionType: ACTION.actionType, action: ACTION }));
        expect(retry.ok).toBe(true);
    });

    test('two concurrent consumers produce exactly one winner', async () => {
        const { token } = await issue({ idempotencyKey: 'b5-consume-race' });
        const attempt = () => prisma.$transaction((tx) =>
            S.consumeStepUpOrThrow(tx, { token, userId, actionType: ACTION.actionType, action: ACTION }));
        const settled = await Promise.allSettled([attempt(), attempt()]);
        expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(settled.find((r) => r.status === 'rejected').reason.code).toBe('STEP_UP_REJECTED');
    });

    test('a grant issued for one action refuses a different action', async () => {
        const { token } = await issue({ idempotencyKey: 'b5-consume-binding' });
        const different = { ...ACTION, params: { direction: 'TO_POOL', amount: '250.00000000' } };
        await expect(prisma.$transaction((tx) =>
            S.consumeStepUpOrThrow(tx, { token, userId, actionType: ACTION.actionType, action: different })))
            .rejects.toMatchObject({ code: 'STEP_UP_REJECTED' });
        expect(await consumedAt(token)).toBeNull();
    });

    test('a different authenticated user refuses', async () => {
        const { token } = await issue({ idempotencyKey: 'b5-consume-user' });
        await expect(prisma.$transaction((tx) =>
            S.consumeStepUpOrThrow(tx, { token, userId: 'someone-else', actionType: ACTION.actionType, action: ACTION })))
            .rejects.toMatchObject({ code: 'STEP_UP_REJECTED' });
        expect(await consumedAt(token)).toBeNull();
    });
});
