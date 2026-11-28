// __tests__/pos-sync-outbox-retired.test.js
// =============================================================================
// POST /api/business-os/sync-outbox no longer creates orders.
//
// Its create_order branch wrote a COMPLETED order and a ledger income row from
// a client-supplied float total (default customer id 1, client-controlled
// createdAt, no transaction), bypassing the POS settlement containment that
// /pos/order enforces. Offline orders replay through /pos/order. The handler
// must contain no order or ledger write at all.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

function syncOutboxHandlerSource() {
    const src = fs.readFileSync(path.join(__dirname, '../routes/businessOSRoutes.js'), 'utf8');
    const start = src.indexOf("router.post('/sync-outbox'");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nrouter.', start + 10);
    return src.slice(start, next === -1 ? undefined : next);
}

test('sync-outbox writes no order and no ledger entry', () => {
    const handler = syncOutboxHandlerSource();
    expect(handler).not.toMatch(/businessOrder\.create/);
    expect(handler).not.toMatch(/businessLedgerEntry\.create/);
    expect(handler).not.toMatch(/parseFloat\(payload/);
    expect(handler).toContain('POS_SYNC_CREATE_RETIRED');
});
