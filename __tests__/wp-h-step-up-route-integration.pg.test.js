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
// Runs wherever a database is available (both CI lanes provision one); skips
// honestly, rather than failing, when there is none to test against.
const hasDb = Boolean(DB_URL);

// Fixture identity must be unique per RUN, not just per test: a re-run against a
// database that already holds a previous run's users must not collide.
const RUN = `${Date.now()}`.slice(-7);
const run = hasDb ? describe : describe.skip;

// Enforced ONLY inside this process. Production stays off.
process.env.STEP_UP_ENFORCEMENT = 'on';

const request = require('supertest');
const { issueGrant } = require('../src/services/actionStepUpService');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

run('action-bound step-up through POST /api/wallet/withdraw (real PostgreSQL)', () => {
  let app;
  let prisma;
  let userId;
  let token;
  let grantCount = 0;
  let userSeq = 0;
  const createdUserIds = [];

  // A bare 9-digit Binance Pay id with an explicit type: RESOLVED to
  // payoutMethod BINANCE_ID, which is same-asset, so it is NOT FX-gated and does
  // not require the native-GHS risk policy. (An unknown destinationType such as
  // 'BINANCE_ID' is INVALID_TYPE -> 400 before the gate ever runs.)
  const DEST = '123456789';
  // A STRING: the canonical action refuses numbers so a float can never change
  // the digest silently (12.5 vs 12.50 vs 12.50000001).
  const AMOUNT = '12.5';

  const body = (over = {}) => ({
    amount: AMOUNT,
    currency: 'USDC',
    destination: DEST,
    destinationType: 'BINANCE_PAY_ID',
    ...over,
  });

  const withdraw = (b, { key, grant, auth = true } = {}) => {
    let req = request(app).post('/api/wallet/withdraw').send(b);
    if (auth) req = req.set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    if (grant) req = req.set('x-step-up-grant', grant);
    return req;
  };

  const earnGrant = async (action) => {
    const g = await issueGrant(prisma, {
      userId,
      actionType: action.actionType,
      routeScope: action.routeScope,
      action,
      idempotencyKey: action.idempotencyKey,
    });
    return g.token;
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
      await prisma.actionStepUpGrant.deleteMany({
        where: { userId: { in: createdUserIds.map(String) } },
      });
      // Users are deliberately NOT deleted: a withdrawal leaves ledger, fee and
      // idempotency rows pointing at them, so deleteMany trips a foreign-key
      // constraint and fails the suite in afterAll (exactly what CI caught).
      // Identities are run-unique, so leftover rows never collide with a re-run,
      // and this database is disposable by contract.
      await prisma.$disconnect();
    }
  });

  // A FRESH USER PER TEST. The financial tier is keyed per user at 10 calls per
  // 60 seconds (middleware/rateLimitMiddleware.js), and this suite drives far
  // more than that through /api/wallet; sharing one user would turn these
  // assertions into 429s instead of the refusals under test.
  beforeEach(async () => {
    userSeq += 1;
    const hash = await bcrypt.hash('CorrectHorse1!', 4);
    const user = await prisma.user.create({
      data: {
        username: `sr${RUN}${userSeq}`,
        email: `stepup-route-${RUN}-${userSeq}@azaman.test`,
        password: hash,
        availableBalance: 5000,
        kycStatus: 'VERIFIED',
        isTwoFactorEnabled: false,
      },
    });
    userId = user.id;
    createdUserIds.push(user.id);
    token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
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
    ['amount', { amount: '13.5' }],
    ['destination', { destination: '987654321' }],
    ['currency', { currency: 'GHS' }],
    ['resource', { withdrawalId: 'someone-elses' }],
  ])('a grant for one action is refused when %s changes', async (_field, patch) => {
    const ch = await withdraw(body(), { key: nextKey() });
    expect(ch.body.code).toBe('STEP_UP_REQUIRED');
    const grant = await earnGrant(ch.body.action);

    const res = await withdraw(body(patch), { key: nextKey(), grant });
    // Refused wherever it is caught (the gate's bind, or an earlier validator),
    // and never a 5xx: a changed action is a client error, not an outage.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // nothing was spent
    const row = await prisma.actionStepUpGrant.findFirst({ where: { userId: String(userId) } });
    expect(row.consumedAt).toBeNull();
  });

  test('the same idempotency key cannot be re-pointed at a different action', async () => {
    const key = nextKey();
    const ch = await withdraw(body(), { key });
    const grant = await earnGrant(ch.body.action);
    const res = await withdraw(body({ amount: '99' }), { key, grant });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // ── 7. concurrent replay: exactly one winner ──
  test('a concurrently replayed grant has exactly one winner', async () => {
    const ch = await withdraw(body(), { key: nextKey() });
    const grant = await earnGrant(ch.body.action);

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
    const ch = await withdraw(body(), { key: nextKey() });
    const grant = await earnGrant(ch.body.action);

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
    const grant = await earnGrant(ch.body.action);

    const first = await withdraw(body(), { key, grant });
    expect([200, 201]).toContain(first.status);

    // Same key, same body, NO grant: idempotency answers from the committed record.
    const replay = await withdraw(body(), { key });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.success).toBe(true);

    const grants = await prisma.actionStepUpGrant.count({ where: { userId: String(userId) } });
    expect(grants).toBe(1);
  });
});
