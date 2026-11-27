// __tests__/wp-h-activation-ledger-types.test.js
// =============================================================================
// The activation function's orphaned-ledger blocker must filter on transaction
// types that EXIST. It named FIAT_DEPOSIT / FIAT_WITHDRAWAL / MOMO_*, none of
// which are in the TransactionType enum, so it could never block activation;
// the JS preflight (fiatLiquidityActivationService) used WITHDRAWAL_FIAT. The
// two must agree and every literal must be a real enum value.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function enumValues(schema, name) {
    const start = schema.indexOf(`enum ${name} {`);
    const m = start === -1 ? null : [null, schema.slice(start, schema.indexOf('}', start)).split('{')[1]];
    return m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
}

test('every orphaned-ledger type in the activation SQL is a real TransactionType', () => {
    const sql = read('infra/sql/azm_authority_activate.sql');
    const m = sql.match(/t\."type"::text IN \(([^)]*)\)/);
    expect(m).toBeTruthy();
    const types = m[1].split(',').map((t) => t.trim().replace(/^'|'$/g, ''));
    const valid = new Set(enumValues(read('prisma/schema.prisma'), 'TransactionType'));
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect({ type: t, valid: valid.has(t) }).toEqual({ type: t, valid: true });
});

test('the SQL blocker and the JS preflight check the same type', () => {
    const sql = read('infra/sql/azm_authority_activate.sql');
    const js = read('src/services/fiatLiquidityActivationService.js');
    const sqlTypes = sql.match(/t\."type"::text IN \(([^)]*)\)/)[1].split(',').map((t) => t.trim().replace(/^'|'$/g, ''));
    const jsTypes = [...js.matchAll(/t\."type" = '([A-Z_]+)'/g)].map((x) => x[1]);
    expect(jsTypes.length).toBeGreaterThan(0);
    expect(new Set(sqlTypes)).toEqual(new Set(jsTypes));
});
