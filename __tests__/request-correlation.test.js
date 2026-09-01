const requestMiddleware = require('../middleware/requestId');
const { attachFinancialCorrelation, FINANCIAL_EVENTS } = require('../src/sockets/financialCorrelation');

describe('request correlation', () => {
    test('propagates a valid caller request id and exposes it on the response', () => {
        const req = { headers: { 'x-request-id': 'azm-test-request-123' } };
        const res = { locals: {}, setHeader: jest.fn() };
        let observed;

        requestMiddleware(req, res, () => {
            observed = requestMiddleware.withRequestId({ operation: 'fund' });
        });

        expect(req.id).toBe('azm-test-request-123');
        expect(res.locals.requestId).toBe('azm-test-request-123');
        expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'azm-test-request-123');
        expect(requestMiddleware.getRequestId()).toBe('azm-test-request-123');
        expect(observed).toEqual({ operation: 'fund', requestId: 'azm-test-request-123' });
    });

    test('rejects unsafe caller ids and generates a new correlation id', () => {
        const req = { headers: { 'x-request-id': 'unsafe id with spaces' } };
        const res = { locals: {}, setHeader: jest.fn() };
        requestMiddleware(req, res, () => {});

        expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    });

    test('adds requestId only to financial socket events and preserves non-financial payloads', () => {
        const financialOperator = { emit: jest.fn() };
        const otherOperator = { emit: jest.fn() };
        const io = {
            to: jest.fn((room) => room === 'financial' ? financialOperator : otherOperator),
        };

        attachFinancialCorrelation(io);
        expect(FINANCIAL_EVENTS.has('escrow_funded')).toBe(true);
        expect(FINANCIAL_EVENTS.has('chat_message')).toBe(false);

        const req = { headers: { 'x-request-id': 'correlation-456' } };
        const res = { locals: {}, setHeader: jest.fn() };
        requestMiddleware(req, res, () => {
            io.to('financial').emit('escrow_funded', { escrowId: 'escrow-1' });
            io.to('other').emit('chat_message', { text: 'hello' });
        });

        expect(financialOperator.emit).toHaveBeenCalledWith(
            'escrow_funded',
            { escrowId: 'escrow-1', requestId: 'correlation-456' },
        );
        expect(otherOperator.emit).toHaveBeenCalledWith(
            'chat_message',
            { text: 'hello' },
        );
    });
});
