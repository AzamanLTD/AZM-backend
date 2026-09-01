'use strict';

const { withRequestId } = require('../../middleware/requestId');

const FINANCIAL_EVENTS = new Set([
    'escrow_funded',
    'escrow_settled',
    'escrow_pending_settlement',
    'escrow_refunded',
    'invoice_paid',
    'withdrawal_progress',
    'withdrawal_settled',
    'admin_alert',
]);

const wrapOperator = (operator) => {
    const originalEmit = operator.emit.bind(operator);
    operator.emit = (event, payload, ...args) => originalEmit(
        event,
        FINANCIAL_EVENTS.has(event) ? withRequestId(payload) : payload,
        ...args,
    );
    return operator;
};

const attachFinancialCorrelation = (io) => {
    if (!io || io.__azmFinancialCorrelation) return io;

    const originalTo = io.to.bind(io);
    io.to = (...args) => wrapOperator(originalTo(...args));

    if (typeof io.in === 'function') {
        const originalIn = io.in.bind(io);
        io.in = (...args) => wrapOperator(originalIn(...args));
    }

    Object.defineProperty(io, '__azmFinancialCorrelation', {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });

    return io;
};

module.exports = { FINANCIAL_EVENTS, attachFinancialCorrelation };
