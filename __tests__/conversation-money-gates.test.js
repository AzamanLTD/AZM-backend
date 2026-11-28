// __tests__/conversation-money-gates.test.js
// =============================================================================
// Money that leaves the caller through a conversation carries the same gates
// as the dedicated money routes, and only reaches someone in the conversation.
//
//   1. MONEY_SEND messages, accept-money, fund-escrow and release-escrow mount
//      KYC then a second factor; text, decline and dispute do not.
//   2. MONEY_SEND to a user who is not a participant is refused 403
//      RECIPIENT_NOT_IN_CONVERSATION before any read or write of money.
// =============================================================================
'use strict';

const router = require('../routes/conversationRoutes');
const { moneySendGate } = router;

function mockRes() {
    return {
        _status: null, _body: null,
        status(c) { this._status = c; return this; },
        json(b) { this._body = b; return this; },
    };
}

describe('conversation route gates', () => {
    const layer = (path) => router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
    const stackSrc = (l) => l.route.stack.map((s) => String(s.handle));
    const gated = (l) => stackSrc(l).some((src) => src.includes('requireKyc(kycAction)'));

    test.each([
        '/:conversationId/messages/:messageId/accept-money',
        '/:conversationId/messages/:messageId/fund-escrow',
        '/:conversationId/messages/:messageId/release-escrow',
    ])('%s carries KYC + second factor', (p) => {
        expect(gated(layer(p))).toBe(true);
    });

    test.each([
        '/:conversationId/messages/:messageId/decline-money',
        '/:conversationId/messages/:messageId/dispute-escrow',
    ])('%s moves nothing and is not gated', (p) => {
        expect(gated(layer(p))).toBe(false);
    });

    test('the message route gates MONEY_SEND only', () => {
        expect(layer('/:conversationId/messages').route.stack.some((s) => s.handle === moneySendGate)).toBe(true);
    });

    test('a text message passes the send gate untouched', async () => {
        let passed = false;
        await moneySendGate({ body: { type: 'TEXT', text: 'hi' } }, mockRes(), () => { passed = true; });
        expect(passed).toBe(true);
    });

    test('MONEY_SEND from an unverified caller is refused before the handler', async () => {
        const prisma = { user: { findUnique: jest.fn(async () => ({ kycStatus: 'UNVERIFIED', role: 'USER', isDeleted: false })) } };
        const req = { body: { type: 'MONEY_SEND' }, user: { id: 3 }, app: { get: () => prisma } };
        const res = mockRes();
        let passed = false;
        await moneySendGate(req, res, () => { passed = true; });
        expect(passed).toBe(false);
        expect(res._status).toBe(403);
        expect(res._body).toMatchObject({ code: 'KYC_REQUIRED', requiredFor: 'p2p' });
    });
});

describe('MONEY_SEND recipient must be in the conversation', () => {
    const { ConversationMoneyService } = require('../services/conversationMoneyService');

    // Only the replay lookup may run; any money read or write throws.
    function prismaWithReplay(existing) {
        return {
            conversationMoneyTicket: { findUnique: jest.fn(async () => existing) },
            message: { findUnique: jest.fn(async () => ({ id: 'm1', sender: { id: 3 } })) },
            $transaction: () => { throw new Error('no money transaction may start'); },
            user: new Proxy({}, { get: () => { throw new Error('user must not be touched'); } }),
        };
    }

    test('a new send to a non-participant is refused before any money read or write', async () => {
        const prisma = prismaWithReplay(null);
        const svc = new ConversationMoneyService({ prisma, io: null, emitBalanceUpdate: async () => {} });
        const conv = { id: 'c1', type: 'PERSONAL', participants: [{ id: 3 }, { id: 4 }] };
        await expect(svc._sendMoney({
            user: { id: 3 }, conv, moneyAmount: '5', recipientId: 99, asset: 'USDC', clientRequestId: 'req-x',
        })).rejects.toMatchObject({ status: 403, code: 'RECIPIENT_NOT_IN_CONVERSATION' });
    });

    test('a committed same-key replay still returns its stored outcome after the recipient left', async () => {
        const existing = {
            kind: 'MONEY_SEND', conversationId: 'c1', requesterId: 3, counterpartyId: 4,
            currency: 'USDC', amount: '5', messageId: 'm1',
        };
        const prisma = prismaWithReplay(existing);
        const svc = new ConversationMoneyService({ prisma, io: null, emitBalanceUpdate: async () => {} });
        const convWithout4 = { id: 'c1', type: 'PERSONAL', participants: [{ id: 3 }] };
        const res = await svc._sendMoney({
            user: { id: 3 }, conv: convWithout4, moneyAmount: '5', recipientId: 4, asset: 'USDC', clientRequestId: 'req-y',
        });
        expect(res.replay).toBe(true);
    });
});
