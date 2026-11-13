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

// §WP-H slice 6 — THE TRIGGER IMPLEMENTATION, TIED TO THE SHIPPED MIGRATION.
// A migration edit that changes the immutability function body must fail here,
// because the runtime inspection and the activation function both compare against
// the contract module rather than against the database's own current text.
const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations',
    '20261110230000_p5d_enforced_authority_activation', 'migration.sql'), 'utf8');

describe('WP-H canonical trigger implementation', () => {
    const contract = require('../src/services/authorityTriggerContract');

    const shippedBody = () => {
        const m = /CREATE OR REPLACE FUNCTION azm_authority_activation_immutable\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/.exec(migrationSql);
        if (!m) throw new Error('the immutability trigger function is not in the shipped migration');
        return m[1];
    };

    test('the contract body is exactly the body the migration installs', () => {
        expect(contract.CANONICAL_TRIGGER_SOURCE).toBe(shippedBody());
    });

    test('the contract digest is derived from that body, not a stale literal', () => {
        expect(contract.TRIGGER_SOURCE_SHA256).toBe(contract.digestOfTriggerSource(shippedBody()));
        expect(contract.TRIGGER_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('the canonical body actually refuses, so the fingerprint cannot bless a no-op', () => {
        expect(shippedBody()).toMatch(/RAISE EXCEPTION/);
        expect(shippedBody()).toMatch(/append-only/);
        expect(contract.isCanonicalTriggerSource(shippedBody())).toBe(true);
        expect(contract.isCanonicalTriggerSource('\nBEGIN\n  RETURN NEW;\nEND;\n')).toBe(false);
        expect(contract.isCanonicalTriggerSource(null)).toBe(false);
    });

    test('the activation SQL compares the body and injects it, rather than hard-coding a copy', () => {
        expect(sql).toMatch(/c_trigger_src\s+constant\s+text\s+:=/);
        expect(sql).toMatch(/v_fn_src IS DISTINCT FROM c_trigger_src/);
        expect(sql).toContain('{{CANONICAL_TRIGGER_SOURCE}}');

        const { functionSql } = require('../infra/lib/authority-function-sql');
        const rendered = functionSql('a_runtime_operator', 'a_fn_owner');
        expect(rendered).not.toContain('{{CANONICAL_TRIGGER_SOURCE}}');
        // Dollar-quoted, so the body appears verbatim: no quoting to drift out of sync.
        expect(rendered).toContain(contract.CANONICAL_TRIGGER_SOURCE);
    });
});
