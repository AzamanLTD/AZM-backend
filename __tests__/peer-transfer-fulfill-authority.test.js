// __tests__/peer-transfer-fulfill-authority.test.js
// =============================================================================
// Fulfilling a fund request debits the payer, so it carries the same second
// factor as /transfer/send, and an already-finalized request is only reported
// as success when it was actually paid.
//
//   1. PUT /api/friends/transfer/:id/fulfill mounts require2FA after KYC, like
//      POST /transfer/send.
//   2. A request that was DECLINED before this fulfil arrived answers 409
//      TRANSFER_REQUEST_NOT_PENDING ("Nothing was sent"), never success.
//   3. A request that a concurrent fulfil already COMPLETED still answers the
//      200 idempotent replay (the r25 single-winner contract is unchanged).
//   4. requestFunds refuses zero, negative, exponent and over-precision amounts
//      and stores an exact Decimal, never a float.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');

function mockRes() {
    return {
        _status: null,
        _body: null,
        status(c) { this._status = c; return this; },
        json(b) { this._body = b; return this; },
    };
}

function appWith(prisma) {
    const store = { prisma, socketio: null, emitBalanceUpdate: null, notificationService: { sendNotification: async () => {} } };
    return { get: (k) => store[k] };
}

describe('fulfil route chain', () => {
    test('fulfil carries KYC then a second factor, exactly like send', () => {
        const router = require('../routes/friendRoutes');
        const layerFor = (method, path) => router.stack.find(
            (l) => l.route && l.route.path === path && l.route.methods[method]
        );
        // require2FA() returns a fresh anonymous closure per mount, so identify
        // it by its source text rather than by reference or name.
        const { require2FA } = require('../middleware/require2FA');
        const twoFaSource = require2FA().toString();
        const sources = (layer) => layer.route.stack.map((s) => s.handle.toString());

        const fulfil = layerFor('put', '/transfer/:id/fulfill');
        const send = layerFor('post', '/transfer/send');
        expect(fulfil).toBeDefined();
        const fulfilSources = sources(fulfil);
        const at = fulfilSources.indexOf(twoFaSource);
        expect(at).toBeGreaterThan(-1);
        expect(sources(send)).toContain(twoFaSource);
        // After KYC, before the handler.
        expect(fulfil.route.stack[at - 1].handle.name).toBe('kycGate');
        expect(at).toBeLessThan(fulfilSources.length - 1);
    });
});

describe('fulfil of an already-finalized request', () => {
    const ctrl = require('../controllers/peerTransferController');

    function prismaFor(finalStatus) {
        let reads = 0;
        return {
            peerTransfer: {
                findUnique: jest.fn(async () => {
                    reads += 1;
                    if (reads === 1) {
                        return {
                            id: 't1', type: 'REQUEST', status: 'PENDING', senderId: 7, receiverId: 9,
                            amount: new Prisma.Decimal('12.50'), friendshipId: 'f1', friendship: { id: 'f1' },
                        };
                    }
                    return { id: 't1', status: finalStatus };
                }),
            },
            // The PENDING -> COMPLETED claim loses: something finalized the row first.
            $transaction: jest.fn(async (fn) => fn({
                peerTransfer: { updateMany: jest.fn(async () => ({ count: 0 })) },
            })),
        };
    }

    test('declined first: 409, nothing reported as sent', async () => {
        const res = mockRes();
        await ctrl.fulfillTransferRequest({ user: { id: 7 }, params: { id: 't1' }, app: appWith(prismaFor('DECLINED')) }, res);
        expect(res._status).toBe(409);
        expect(res._body).toMatchObject({ success: false, code: 'TRANSFER_REQUEST_NOT_PENDING' });
        expect(res._body.message).toMatch(/Nothing was sent/);
    });

    test('completed by a concurrent fulfil: 200 idempotent replay', async () => {
        const res = mockRes();
        await ctrl.fulfillTransferRequest({ user: { id: 7 }, params: { id: 't1' }, app: appWith(prismaFor('COMPLETED')) }, res);
        expect(res._status).toBe(200);
        expect(res._body).toMatchObject({ success: true, idempotent: true });
    });
});

describe('requestFunds amount parsing', () => {
    const ctrl = require('../controllers/peerTransferController');

    function prismaCapture() {
        const created = [];
        return {
            created,
            friendship: { findUnique: jest.fn(async () => ({ requesterId: 9, addresseeId: 7, status: 'ACCEPTED' })) },
            user: { findUnique: jest.fn(async () => ({ username: 'req', equippedCardSkin: null })) },
            peerTransfer: { create: jest.fn(async ({ data }) => { created.push(data); return { id: 't9', ...data }; }) },
            directMessage: { create: jest.fn(async ({ data }) => ({ id: 'm1', ...data, sender: { id: 9 } })) },
        };
    }

    test.each(['0', '-5', '1e3', '1.123456789', 'abc'])('refuses %p with 400 before any write', async (amount) => {
        const prisma = prismaCapture();
        const res = mockRes();
        await ctrl.requestFunds({ user: { id: 9 }, body: { friendshipId: 'f1', amount }, app: appWith(prisma) }, res);
        expect(res._status).toBe(400);
        expect(prisma.peerTransfer.create).not.toHaveBeenCalled();
    });

    test('stores the exact decimal, not a float', async () => {
        const prisma = prismaCapture();
        const res = mockRes();
        await ctrl.requestFunds({ user: { id: 9 }, body: { friendshipId: 'f1', amount: '0.10000001' }, app: appWith(prisma) }, res);
        expect(prisma.created).toHaveLength(1);
        const stored = prisma.created[0].amount;
        expect(stored).toBeInstanceOf(Prisma.Decimal);
        expect(stored.toFixed(8)).toBe('0.10000001');
    });
});
