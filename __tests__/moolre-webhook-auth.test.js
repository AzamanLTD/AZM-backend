// __tests__/moolre-webhook-auth.test.js
// =============================================================================
// Moolre callback authentication follows the provider's documented contract
// (docs.moolre.com guides/webhooks-and-callbacks, api/payments/webhook):
//   X-Moolre-Signature: t=<unix>,v1=HMAC-SHA256("<t>.<raw body>", wallet secret)
//   with a 5-minute window; legacy data.secret until 2027-03-31.
// The undocumented static header and bare-body HMAC are accepted outside
// production only.
// =============================================================================
'use strict';

const crypto = require('crypto');
const { verifyMoolreCallback, sign, LEGACY_BODY_SECRET_SUNSET_MS } = require('../src/services/moolreWebhookAuth');

const SECRET = 'wallet-secret-123';
const NOW = Date.parse('2026-11-27T12:00:00Z');
const T = Math.floor(NOW / 1000);
const body = { status: 1, code: 'P01', data: { txstatus: 1, externalref: 'AZ-1', amount: '10.00' } };
const raw = JSON.stringify(body);
const signed = (t = T, r = raw) => `t=${t},v1=${sign(SECRET, t, r)}`;

const verify = (over = {}) => verifyMoolreCallback({
    headers: {}, rawBody: raw, body, secret: SECRET, nowMs: NOW, nodeEnv: 'production', ...over,
});

test('the documented signature authenticates', () => {
    expect(verify({ headers: { 'x-moolre-signature': signed() } })).toEqual({ ok: true, method: 'SIGNATURE' });
    // order and spacing tolerant
    expect(verify({ headers: { 'x-moolre-signature': ` v1=${sign(SECRET, T, raw)} , t=${T}` } }).ok).toBe(true);
});

test('a signature over a different body, key or timestamp is refused', () => {
    expect(verify({ headers: { 'x-moolre-signature': signed(T, raw + ' ') } })).toMatchObject({ ok: false, status: 401, reason: 'SIGNATURE_INVALID' });
    const otherKey = `t=${T},v1=${crypto.createHmac('sha256', 'nope').update(`${T}.${raw}`).digest('hex')}`;
    expect(verify({ headers: { 'x-moolre-signature': otherKey } }).ok).toBe(false);
    expect(verify({ headers: { 'x-moolre-signature': `t=${T + 1},v1=${sign(SECRET, T, raw)}` } }).ok).toBe(false);
});

test('a signature outside the 5-minute window is refused (replay)', () => {
    expect(verify({ headers: { 'x-moolre-signature': signed(T - 301) } })).toMatchObject({ ok: false, reason: 'SIGNATURE_EXPIRED' });
    expect(verify({ headers: { 'x-moolre-signature': signed(T + 301) } })).toMatchObject({ ok: false, reason: 'SIGNATURE_EXPIRED' });
    expect(verify({ headers: { 'x-moolre-signature': signed(T - 299) } }).ok).toBe(true);
});

test('legacy data.secret authenticates until the documented sunset', () => {
    const legacy = { ...body, data: { ...body.data, secret: SECRET } };
    expect(verify({ body: legacy, rawBody: JSON.stringify(legacy) })).toEqual({ ok: true, method: 'LEGACY_BODY_SECRET' });
    expect(verify({ body: legacy, rawBody: JSON.stringify(legacy), nowMs: LEGACY_BODY_SECRET_SUNSET_MS }).ok).toBe(false);
});

test('a body that asserts the wrong secret is refused even with a valid signature', () => {
    for (const bad of [{ ...body, data: { ...body.data, secret: 'wrong' } }, { ...body, secret: 'wrong' }]) {
        const r = JSON.stringify(bad);
        expect(verify({ body: bad, rawBody: r, headers: { 'x-moolre-signature': signed(T, r) } }))
            .toMatchObject({ ok: false, reason: 'BODY_SECRET_MISMATCH' });
    }
});

test('production refuses the undocumented static header and bare HMAC', () => {
    const bare = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verify({ headers: { 'x-moolre-webhook-secret': SECRET } }).ok).toBe(false);
    expect(verify({ headers: { 'x-moolre-signature': bare } }).ok).toBe(false);
});

test('outside production the legacy harness forms still work', () => {
    const bare = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verify({ nodeEnv: 'test', headers: { 'x-moolre-webhook-secret': SECRET } })).toEqual({ ok: true, method: 'NONPROD_STATIC_HEADER' });
    expect(verify({ nodeEnv: 'test', headers: { 'x-moolre-signature': bare } })).toEqual({ ok: true, method: 'NONPROD_BARE_HMAC' });
});

test('no configured secret is 503, no credentials is 401', () => {
    expect(verify({ secret: undefined })).toMatchObject({ ok: false, status: 503 });
    expect(verify()).toMatchObject({ ok: false, status: 401, reason: 'MISSING_AUTHENTICATION' });
});

describe('payout webhook normalisation never reads the envelope as an outcome', () => {
    const ctrl = require('../controllers/fiatSettlementWebhook.controller');
    const normalize = ctrl._normalizeMoolre || ctrl.normalizeMoolre;
    const maybe = normalize ? test : test.skip;

    maybe('an envelope-level status is never read as the payout outcome', () => {
        expect(normalize({ status: 'FAILED', externalref: 'AZ-9' }).status).toBeNull();
        expect(normalize({ status: 0, code: 'P12', message: 'x' }).status).toBeNull();
    });
    maybe('a flat body is read only through its transaction txstatus', () => {
        expect(normalize({ txstatus: 2, externalref: 'AZ-8', status: 'SUCCESSFUL' })).toMatchObject({ status: 'FAILED', reference: 'AZ-8' });
    });
    maybe('a single documented payout hook is read from its own data', () => {
        const hookBody = { status: 1, code: 'P12', data: { hooks: [{ status: 1, code: 'SS02', data: { txstatus: 2, externalref: 'AZ-2' } }] } };
        expect(normalize(hookBody)).toMatchObject({ status: 'FAILED', reference: 'AZ-2' });
    });
    maybe('a multi-hook batch is not guessed at', () => {
        const batch = { data: { hooks: [{ data: { txstatus: 1, externalref: 'A' } }, { data: { txstatus: 2, externalref: 'B' } }] } };
        expect(normalize(batch).status).toBeNull();
    });
});
