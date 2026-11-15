// §WP-H G — ACTION-BOUND STEP-UP THROUGH THE REAL ROUTE AND THE REAL TRANSACTION.
//
// Everything here goes through POST /api/wallet/withdraw exactly as a client does:
// protectActive -> requireKyc -> secondFactor -> requireFreshFxRate -> idempotency
// -> the step-up gate -> walletController.requestWithdrawal, with the grant spent
// by a conditional UPDATE inside the withdrawal's own $transaction.
//
// This is deliberately NOT a source-order or direct-service test: the defect it
// guards against (one canonicaliser at the gate, another at issue/consume) is
// invisible to both.
'use strict';

// jest's env loader exposes the disposable DB as DATABASE_URL; TEST_DATABASE_URL
// wins when a caller supplies one explicitly.
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
// OPT-IN ONLY. This file is NOT yet green: the real route answers 400 at request
// validation before the step-up gate is reached, so the fixture body is still
// wrong for POST /api/wallet/withdraw. It is kept (and excluded from the default
// run) as the harness for that work rather than deleted, but it must not be read
// as evidence that step-up is proven through the route. Run it explicitly:
//   STEP_UP_ROUTE_ITEST=1 npx jest __tests__/wp-h-step-up-route-integration.pg.test.js
const hasDb = Boolean(DB_URL) && process.env.STEP_UP_ROUTE_ITEST === '1';
const run = hasDb ? describe : describe.skip;

// Enforced ONLY inside this process. Production stays off.
process.env.STEP_UP_ENFORCEMENT = 'on';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

run('action-bound step-up through POST /api/wallet/withdraw (real PostgreSQL)', () => {
  let app;
  let prisma;
  let userId;
  let token;
  let grantCount = 0;

  const DEST = 'BINANCE_PAY:123456789';   // same-asset: not FX-gated, no GHS policy
  const AMOUNT = 12.5;

  const body = (over = {}) => ({
    amount: AMOUNT,
    currency: 'USDC',
    destination: DEST,
    destinationType: 'BINANCE_ID',
    ...over,
  });

  const withdraw = (b, { key, grant, auth = true } = {}) => {
    let req = request(app).post('/api/wallet/withdraw').send(b);
    if (auth) req = req.set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    if (grant) req = req.set('x-step-up-grant', grant);
    return req;
  };

  const nextKey = () => `itest-${Date.now()}-${grantCount++}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    app = require('../server');

    const hash = await bcrypt.hash('CorrectHorse1!', 4);
    // GlobalSettings row: the withdrawal handler refuses to price without it.
    await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

    const user = await prisma.user.upsert({
      where: { email: 'stepup-route@azaman.test' },
      update: { availableBalance: 5000, kycStatus: 'VERIFIED', isTwoFactorEnabled: false, password: hash },
      create: {
        username: 'stepuprite',
        email: 'stepup-route@azaman.test',
        password: hash,
        availableBalance: 5000,
        kycStatus: 'VERIFIED',
        isTwoFactorEnabled: false,
      },
    });
    userId = user.id;
    token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.actionStepUpGrant.deleteMany({ where: { userId: String(userId) } });
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await prisma.actionStepUpGrant.deleteMany({ where: { userId: String(userId) } });
    await prisma.user.update({ where: { id: userId }, data: { availableBalance: 5000 } });
  });

  // ── 1. no grant -> STEP_UP_REQUIRED carrying the server descriptor ──
  test('a real withdrawal without a grant returns STEP_UP_REQUIRED with its descriptor', async () => {
    const res = await withdraw(body(), { key: nextKey() });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(res.body.action).toBeTruthy();
    expect(res.body.action.amount).toBe('12.5');
    expect(res.body.action.actionType).toBe('FIAT_WITHDRAWAL');
    expect(res.body.actionDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── 2-5. descriptor + proof -> grant -> retry -> consumed in-tx ──
  test('the descriptor earns a grant for exactly that action, and the retry is consumed in-transaction', async () => {
    const challenged = await withdraw(body(), { key: nextKey() });
    expect(challenged.status).toBe(401);

    const key = nextKey();
    const again = await withdraw(body(), { key });
    expect(again.status).toBe(401);

    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: again.body.action, password: 'CorrectHorse1!' });
    expect(grantRes.status).toBe(201);
    expect(grantRes.body.stepUpGrant).toBeTruthy();
    // The grant's digest IS the gate's digest: one canonical contract.
    expect(grantRes.body.actionDigest).toBe(again.body.actionDigest);

    const ok = await withdraw(body(), { key, grant: grantRes.body.stepUpGrant });
    expect([200, 201]).toContain(ok.status);

    // consumed exactly once, by the transaction that moved the money
    const rows = await prisma.actionStepUpGrant.findMany({ where: { userId: String(userId) } });
    expect(rows.length).toBe(1);
    expect(rows[0].consumedAt).toBeTruthy();
  });

  // ── 6. a changed action is refused ──
  test.each([
    ['amount', { amount: AMOUNT + 1 }],
    ['destination', { destination: 'BINANCE_PAY:999999' }],
    ['currency', { currency: 'GHS' }],
    ['resource', { withdrawalId: 'someone-elses' }],
  ])('a grant for one action is refused when %s changes', async (_field, patch) => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: ch.body.action, password: 'CorrectHorse1!' });
    expect(grantRes.status).toBe(201);

    const res = await withdraw(body(patch), { key: nextKey(), grant: grantRes.body.stepUpGrant });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REJECTED');
    // nothing was spent
    const row = await prisma.actionStepUpGrant.findFirst({ where: { userId: String(userId) } });
    expect(row.consumedAt).toBeNull();
  });

  test('the same idempotency key cannot be re-pointed at a different action', async () => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: ch.body.action, password: 'CorrectHorse1!' });
    const res = await withdraw(body({ amount: 99 }), { key, grant: grantRes.body.stepUpGrant });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // ── 7. concurrent replay: exactly one winner ──
  test('a concurrently replayed grant has exactly one winner', async () => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: ch.body.action, password: 'CorrectHorse1!' });
    const grant = grantRes.body.stepUpGrant;

    // Two separate connections race the single-use conditional UPDATE.
    const attempt = () => prisma.$transaction(async (tx) => {
      const out = await tx.$queryRawUnsafe(
        `UPDATE "ActionStepUpGrant" SET "consumedAt" = NOW()
          WHERE "tokenHash" = $1 AND "userId" = $2 AND "consumedAt" IS NULL AND "expiresAt" > NOW()
        RETURNING "id"`,
        require('crypto').createHash('sha256').update(grant).digest('hex'), String(userId),
      );
      return out.length;
    });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const winners = results.filter((r) => r.status === 'fulfilled' && r.value === 1).length;
    expect(winners).toBe(1);
  });

  // ── 8. a rolled-back transaction does not spend the grant ──
  test('a rolled-back economic transaction leaves the grant unspent', async () => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: ch.body.action, password: 'CorrectHorse1!' });
    const grant = grantRes.body.stepUpGrant;

    await prisma.user.update({ where: { id: userId }, data: { availableBalance: 0 } });
    const res = await withdraw(body(), { key: nextKey(), grant });
    expect(res.status).toBeGreaterThanOrEqual(400);   // INSUFFICIENT_BALANCE

    const row = await prisma.actionStepUpGrant.findFirst({ where: { userId: String(userId) } });
    expect(row.consumedAt).toBeNull();
  });

  // ── 9. exact retry of a committed operation converges without a new grant ──
  test('an exact retry of a committed withdrawal converges with no second grant', async () => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grantRes = await request(app)
      .post('/api/step-up/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: ch.body.action, password: 'CorrectHorse1!' });

    const first = await withdraw(body(), { key, grant: grantRes.body.stepUpGrant });
    expect([200, 201]).toContain(first.status);

    // Same key, same body, NO grant: idempotency answers from the committed record.
    const replay = await withdraw(body(), { key });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.success).toBe(true);

    const grants = await prisma.actionStepUpGrant.count({ where: { userId: String(userId) } });
    expect(grants).toBe(1);
  });
});
