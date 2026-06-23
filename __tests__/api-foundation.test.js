// __tests__/api-foundation.test.js
// =============================================================================
// Foundation middleware coverage — request tracing, API versioning alias, and
// the additive response-envelope helpers. Pure (no database), runs everywhere.
//
// These assert the THREE non-breaking guarantees we promised:
//   1. Every request gets an X-Request-Id (minted or honoured from the client).
//   2. /api/v1/<x> resolves to the SAME handler as /api/<x> (alias, no dup), and
//      req.apiVersion is negotiated from path or header.
//   3. res.ok()/res.fail() emit the {success,data,errors,meta} envelope WITHOUT
//      altering plain res.json(...) bodies that the live client still reads.
// =============================================================================
const express = require('express');
const request = require('supertest');

const requestId = require('../middleware/requestId');
const apiVersioning = require('../middleware/apiVersioning');
const responseHelpers = require('../middleware/responseHelpers');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  // Mirror server.js wiring exactly.
  app.use('/api', apiVersioning);
  app.use((req, res, next) => {
    const m = req.url.match(/^\/api\/v(\d+)(?=\/|\?|$)/);
    if (m) req.url = '/api' + req.url.slice(m[0].length);
    next();
  });
  app.use('/api', responseHelpers);

  // A legacy-style endpoint: heterogeneous key, NOT wrapped. Represents the
  // existing surface the Flutter client depends on.
  app.get('/api/legacy', (req, res) => {
    res.json({ success: true, widget: { id: 'w1' }, apiVersion: req.apiVersion });
  });

  // New-style endpoints opting into the envelope.
  app.get('/api/new/ok', (req, res) => {
    res.ok({ id: 'n1' }, { pagination: { page: 2, limit: 20, total: 100 } });
  });
  app.get('/api/new/fail', (req, res) => {
    res.fail('bad thing', { status: 422 });
  });
  app.get('/api/new/fail-fields', (req, res) => {
    res.fail({ email: ['Invalid email'], password: ['Too short'] });
  });

  return app;
}

describe('Foundation: request tracing', () => {
  const app = buildApp();

  test('mints an X-Request-Id when none supplied', async () => {
    const res = await request(app).get('/api/legacy');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  test('honours a well-formed client X-Request-Id', async () => {
    const id = 'trace-abc-123456';
    const res = await request(app).get('/api/legacy').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  test('replaces an oversized or wrong-charset X-Request-Id', async () => {
    // Oversized (>128) — a transmittable-but-unacceptable value.
    const tooLong = 'x'.repeat(500);
    const r1 = await request(app).get('/api/legacy').set('X-Request-Id', tooLong);
    expect(r1.headers['x-request-id']).not.toBe(tooLong);
    expect(r1.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);

    // Wrong charset (spaces) — also rejected in favour of a fresh uuid.
    const spaced = 'has spaces here';
    const r2 = await request(app).get('/api/legacy').set('X-Request-Id', spaced);
    expect(r2.headers['x-request-id']).not.toBe(spaced);
    expect(r2.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });
});

describe('Foundation: API versioning alias', () => {
  const app = buildApp();

  test('/api/<x> defaults to version 1 and is untouched', async () => {
    const res = await request(app).get('/api/legacy');
    expect(res.body.apiVersion).toBe(1);
    expect(res.headers['x-api-version']).toBe('v1');
    // Legacy body shape preserved exactly — heterogeneous key, no `data` wrap.
    expect(res.body.widget).toEqual({ id: 'w1' });
  });

  test('/api/v1/<x> resolves to the SAME handler (alias, no duplication)', async () => {
    const res = await request(app).get('/api/v1/legacy');
    expect(res.status).toBe(200);
    expect(res.body.widget).toEqual({ id: 'w1' });
    expect(res.body.apiVersion).toBe(1);
  });

  test('header negotiation sets req.apiVersion when path is unversioned', async () => {
    const res = await request(app).get('/api/legacy').set('X-API-Version', '2');
    expect(res.body.apiVersion).toBe(2);
  });
});

describe('Foundation: additive response envelope', () => {
  const app = buildApp();

  test('res.ok wraps data with meta + pagination', async () => {
    const res = await request(app).get('/api/new/ok');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ id: 'n1' });
    expect(res.body.errors).toBeNull();
    expect(res.body.meta.requestId).toBeTruthy();
    expect(res.body.meta.version).toBe('v1');
    expect(typeof res.body.meta.timestamp).toBe('string');
    expect(res.body.meta.pagination).toEqual({
      page: 2, limit: 20, total: 100, hasMore: true,
    });
  });

  test('res.fail wraps a string error and honours status', async () => {
    const res = await request(app).get('/api/new/fail');
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(res.body.errors).toEqual([{ message: 'bad thing' }]);
  });

  test('res.fail expands a field-errors object into [{field,message}]', async () => {
    const res = await request(app).get('/api/new/fail-fields');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        { field: 'email', message: 'Invalid email' },
        { field: 'password', message: 'Too short' },
      ])
    );
  });

  test('legacy res.json bodies are NOT rewritten', async () => {
    const res = await request(app).get('/api/legacy');
    // No `data` envelope key injected; original keys intact.
    expect(res.body).not.toHaveProperty('data');
    expect(res.body).not.toHaveProperty('meta');
    expect(res.body.widget).toEqual({ id: 'w1' });
  });
});
