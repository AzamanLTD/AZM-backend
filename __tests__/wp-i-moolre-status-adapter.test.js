'use strict';

/**
 * WP-I — Moolre status adapter contract tests.
 *
 * PROVENANCE OF FIXTURES: every shape below is modelled on the official
 * Moolre Payment Status API reference (docs.moolre.com/ai/live/payment-status.html)
 * and the Payment Webhook field table. The `legacy` fixture represents a shape
 * that appears in NO public Moolre document; it exists only to prove that
 * undocumented fields are labelled, never treated as documented equivalence.
 */

const fs = require('fs');
const path = require('path');
const {
    parseMoolreStatusResponse, extractObservation, settlementFromTxstatus,
    ADAPTER_DOCUMENTED, ADAPTER_LEGACY, SETTLED, PENDING, FAILED, UNKNOWN,
} = require('../src/services/providers/moolreStatusAdapter');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'moolre', name), 'utf8');
const parseFixture = (name, httpStatus = 200) => parseMoolreStatusResponse({ httpStatus, rawBody: fixture(name) });

describe('Moolre status adapter — documented contract', () => {
    test('documented success parses as SETTLED with exact fields', () => {
        const r = parseFixture('status-success.json');
        expect(r.adapter).toBe(ADAPTER_DOCUMENTED);
        expect(r.transportOk).toBe(true);
        expect(r.settlement).toBe(SETTLED);
        expect(r.txstatus).toBe(1);
        expect(r.reason).toBeNull();

        const obs = extractObservation(r.data);
        expect(obs.externalRef).toBe('AZM-DEP-000123');
        expect(obs.accountNumber).toBe('100000100002');
        expect(obs.transactionId).toBe('34008096');
        expect(obs.amount).toBe('5.00');
        expect(obs.value).toBe('4.60');
    });

    test('a 200 with a failed wrapper status is not transport success', () => {
        const r = parseFixture('status-wrapper-failed.json');
        expect(r.transportOk).toBe(false);
        expect(r.settlement).toBe(UNKNOWN);
        expect(r.reason).toBe('API_STATUS_NOT_SUCCESS');
    });

    test('top-level success with nested pending status is NOT settled', () => {
        const r = parseFixture('status-pending.json');
        expect(r.transportOk).toBe(true);
        expect(r.settlement).toBe(PENDING);
        expect(r.reason).toBe('TXSTATUS_0');
    });

    test('failed transaction status is not settled', () => {
        const r = parseFixture('status-failed.json');
        expect(r.settlement).toBe(FAILED);
    });

    test('missing txstatus is UNKNOWN, never settled', () => {
        const r = parseFixture('status-no-txstatus.json');
        expect(r.transportOk).toBe(true);
        expect(r.settlement).toBe(UNKNOWN);
        expect(r.reason).toBe('TXSTATUS_MISSING');
    });

    test('numeric and string numeric statuses map identically; unknown values are UNKNOWN', () => {
        expect(settlementFromTxstatus(1)).toBe(SETTLED);
        expect(settlementFromTxstatus('1')).toBe(SETTLED);
        expect(settlementFromTxstatus(0)).toBe(PENDING);
        expect(settlementFromTxstatus(2)).toBe(FAILED);
        expect(settlementFromTxstatus(9)).toBe(UNKNOWN);
        expect(settlementFromTxstatus('settled')).toBe(UNKNOWN);
        expect(settlementFromTxstatus(null)).toBe(UNKNOWN);
    });

    test('non-200, non-JSON and non-object bodies never reach settlement', () => {
        expect(parseMoolreStatusResponse({ httpStatus: 500, rawBody: fixture('status-success.json') }).settlement).toBe(UNKNOWN);
        expect(parseMoolreStatusResponse({ httpStatus: 200, rawBody: '<html>oops</html>' }).reason).toBe('BODY_NOT_JSON');
        expect(parseMoolreStatusResponse({ httpStatus: 200, rawBody: '[]' }).reason).toBe('BODY_NOT_OBJECT');
        expect(parseMoolreStatusResponse({ httpStatus: 200, rawBody: '{"status":1}' }).reason).toBe('DATA_MISSING');
    });

    test('retained bytes digest is reproducible and changes with the body', () => {
        const a = parseFixture('status-success.json');
        const b = parseFixture('status-success.json');
        const c = parseFixture('status-pending.json');
        expect(a.digest).toBe(b.digest);
        expect(a.digest).not.toBe(c.digest);
        expect(a.digest).toHaveLength(64);
    });
});

describe('Moolre status adapter — undocumented shapes are labelled, not equated', () => {
    test('legacy state field is parsed but flagged as undocumented', () => {
        const r = parseFixture('status-legacy-state.json');
        expect(r.adapter).toBe(ADAPTER_LEGACY);
        expect(r.settlement).toBe(SETTLED);
        expect(r.reason).toBe('LEGACY_STATE_SETTLED_UNDOCUMENTED');
    });

    test('extractObservation refuses incomplete data', () => {
        expect(() => extractObservation({ externalref: 'X' })).toThrow(/missing accountnumber/i);
        expect(() => extractObservation(null)).toThrow(/no data object/i);
    });
});
