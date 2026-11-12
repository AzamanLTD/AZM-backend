// __tests__/wp-h-authority-policy-drift.test.js
// The preflight status policy lives in TWO places: the JS service that sizes the
// regime change, and the SECURITY DEFINER function that enforces it. The function
// must never accept a caller's policy, so the only safe relationship is equality.
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/fiatLiquidityActivationService');

const sql = fs.readFileSync(path.join(__dirname, '..', 'infra', 'sql', 'azm_authority_activate.sql'), 'utf8');

const arrayLiteral = (name) => {
    const m = new RegExp(`${name}\\s+constant\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, 'i').exec(sql);
    if (!m) throw new Error(`${name} not found in the activation SQL`);
    return (m[1].match(/'[^']*'/g) || []).map((q) => q.replace(/'/g, ''));
};

describe('WP-H canonical preflight policy', () => {
    test('the database function carries the exact canonical blocking set', () => {
        expect(arrayLiteral('c_blocking').sort()).toEqual([...svc.BLOCKING_STATUSES].sort());
    });

    test('the database function carries the exact canonical parked set', () => {
        expect(arrayLiteral('c_parked').sort()).toEqual([...svc.PARKED_STATUSES].sort());
    });

    test('the function takes no status arrays, so a caller cannot narrow the policy', () => {
        expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.azm_authority_activate\(\s*p_operator\s+text,\s*p_approver\s+text,\s*p_reason\s+text,\s*p_evidence_ref\s+text,\s*p_evidence_digest\s+text\s*\)/);
        expect(sql).not.toMatch(/p_blocking_statuses|p_parked_statuses/);
    });
});
