// __tests__/helpers/mockTransaction.js
// §WP-H D — test doubles for money paths must model a TRANSACTION.
//
// The payout claim and the manual-review park now take the shared authority lock
// and re-read the regime INSIDE a transaction, so a double without
// `$transaction` (or without `$executeRawUnsafe`, which the advisory lock uses)
// makes the code under test throw instead of exercising it. Wrapping a mock with
// withTransactions keeps every existing stub working and gives the transaction
// callback the same stub, which is what these unit tests intend: one logical
// client, transaction boundaries observed rather than simulated away.
'use strict';

function withTransactions(mockPrisma) {
    const base = mockPrisma || {};
    if (typeof base.$executeRawUnsafe !== 'function') {
        base.$executeRawUnsafe = async () => 1;
    }
    if (typeof base.$queryRawUnsafe !== 'function') {
        base.$queryRawUnsafe = async () => [];
    }
    if (typeof base.$transaction !== 'function') {
        // The callback receives the same double, so any stub it reaches keeps
        // working; array form is supported for completeness.
        base.$transaction = async (arg, ...rest) => (typeof arg === 'function'
            ? arg(base)
            : Promise.all(arg));
    }
    return base;
}

module.exports = { withTransactions };
