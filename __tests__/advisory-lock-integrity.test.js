// __tests__/advisory-lock-integrity.test.js
// =============================================================================
// Real-PostgreSQL proof that every transaction-scoped PostgreSQL advisory lock
// used by production backend code returns a deserializable value to Prisma.
//
// Background defect: `SELECT pg_advisory_xact_lock(...)` returns a `void`
// column, which Prisma's query engine cannot deserialize. The production shape
// is `SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))` (the form
// proven in PR #247's shift-scheduling fix).
//
// This suite NEVER mocks Prisma — every test executes the actual lock SQL
// through the affected production service against real PostgreSQL
// (TEST_DATABASE_URL). Skips cleanly when TEST_DATABASE_URL is not set,
// matching the repo's DB-gated suite convention.
//
// Coverage:
//   businessTaxPresetService        — mutation reaches lockBusinessTaxPresets();
//                                     concurrent default mutations serialize.
//   orderTrackingMutationSafeService— lock + callback execute; concurrent
//                                     mutations lose no timeline entries;
//                                     failure after lock rolls back AND the
//                                     lock releases (transaction-scoped proof).
//   storefrontDraftMutationSafeService — normal mutation, canonical stale
//                                     CAS 409, concurrent serialization,
//                                     rollback-then-retry proof.
//   storefrontPublishSafeService    — publish succeeds THROUGH the shared
//                                     withDraftMutation boundary (no second
//                                     lock is added; a source-level guard
//                                     additionally asserts no duplicate lock
//                                     call is ever introduced).
// =============================================================================
const fs = require('fs');
const path = require('path');
const { seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[advisory-lock-integrity.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Advisory-lock integrity (real PostgreSQL)', () => {
  let prisma;
  let bizCounter = 0;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  const _uniq = () => `${Date.now()}_${++bizCounter}`;

  async function seedBusiness() {
    const owner = await seedUser(prisma);
    const id = _uniq();
    const biz = await prisma.businessProfile.create({
      data: {
        userId: owner.id,
        bizId: `BIZ-LOCKTEST-${id}`,
        businessName: `LockTest ${id}`,
        category: 'FOOD_BEVERAGE',
        kybStatus: 'VERIFIED',
      },
    });
    return { owner, biz };
  }

  async function seedTheme() {
    const id = _uniq();
    return prisma.businessStorefrontTheme.create({
      data: {
        key: `classic_light_${id}`,
        name: `LockTest Theme ${id}`,
        tier: 'FREE',
        isActive: true,
        displayOrder: 0,
        tokenSet: {},
      },
    });
  }

  async function seedOrder(bizId) {
    const customer = await seedUser(prisma);
    return prisma.businessOrder.create({
      data: {
        businessProfileId: bizId,
        customerId: customer.id,
        status: 'PAID',
        title: 'LockTest Order',
        amountUsdc: 10.0,
        orderRef: `ORD-LOCKTEST-${_uniq()}`,
      },
    });
  }

  // ── 1. businessTaxPresetService ───────────────────────────────────────────

  describe('businessTaxPresetService (lockBusinessTaxPresets)', () => {
    test('a mutation reaches lockBusinessTaxPresets() and succeeds against PostgreSQL', async () => {
      const { biz } = await seedBusiness();
      const taxService = require('../services/businessTaxPresetService');

      const preset = await taxService.createTaxPreset(prisma, biz.id, {
        name: 'VAT',
        type: 'PERCENTAGE',
        value: 15.0,
        isDefault: true,
      });

      expect(preset.id).toBeTruthy();
      expect(preset.isDefault).toBe(true);
      expect(preset.businessProfileId).toBe(biz.id);
    });

    test('concurrent default creations serialize — exactly one default remains', async () => {
      const { biz } = await seedBusiness();
      const taxService = require('../services/businessTaxPresetService');

      const results = await Promise.all(
        ['VAT', 'NHIL', 'SERVICE'].map((name, i) =>
          taxService.createTaxPreset(prisma, biz.id, {
            name,
            type: 'PERCENTAGE',
            value: 5 + i,
            isDefault: true,
          }),
        ),
      );

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.id)).toBe(true);

      const defaults = await prisma.businessTaxPreset.findMany({
        where: { businessProfileId: biz.id, isDefault: true },
      });
      expect(defaults).toHaveLength(1);
    });
  });

  // ── 2. orderTrackingMutationSafeService ───────────────────────────────────

  describe('orderTrackingMutationSafeService (withOrderTrackingMutation)', () => {
    test('the lock call succeeds and the callback executes against PostgreSQL', async () => {
      const { biz } = await seedBusiness();
      const order = await seedOrder(biz.id);
      const { withOrderTrackingMutation } = require('../services/orderTrackingMutationSafeService');

      let callbackRan = false;
      const result = await withOrderTrackingMutation(
        prisma,
        order.id,
        biz.id,
        async (tx, tracking) => {
          callbackRan = true;
          expect(tracking.orderId).toBe(order.id);
          return tx.orderTracking.update({
            where: { orderId: order.id },
            data: { timeline: [{ status: 'PLACED', timestamp: new Date().toISOString() }] },
          });
        },
      );

      expect(callbackRan).toBe(true);
      expect(result.timeline).toHaveLength(1);
    });

    test('concurrent mutations on the same order lose no timeline entries', async () => {
      const { biz } = await seedBusiness();
      const order = await seedOrder(biz.id);
      const { withOrderTrackingMutation } = require('../services/orderTrackingMutationSafeService');

      const N = 5;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          withOrderTrackingMutation(prisma, order.id, biz.id, async (tx, tracking) => {
            const timeline = Array.isArray(tracking.timeline) ? tracking.timeline : [];
            return tx.orderTracking.update({
              where: { orderId: order.id },
              data: {
                timeline: [...timeline, { status: `EVENT_${i}`, timestamp: new Date().toISOString() }],
              },
            });
          }),
        ),
      );

      const final = await prisma.orderTracking.findUnique({ where: { orderId: order.id } });
      expect(final).toBeTruthy();
      expect(final.timeline).toHaveLength(N);
      const statuses = final.timeline.map((e) => e.status).sort();
      expect(statuses).toEqual(['EVENT_0', 'EVENT_1', 'EVENT_2', 'EVENT_3', 'EVENT_4']);
    });

    test('failure after the lock is acquired rolls back, and the lock releases (transaction-scoped)', async () => {
      const { biz } = await seedBusiness();
      const order = await seedOrder(biz.id);
      const { withOrderTrackingMutation } = require('../services/orderTrackingMutationSafeService');

      const boom = Object.assign(new Error('deliberate failure after lock'), { code: 'TEST_BOOM' });
      await expect(
        withOrderTrackingMutation(prisma, order.id, biz.id, async () => { throw boom; }),
      ).rejects.toMatchObject({ code: 'TEST_BOOM' });

      // The upsert (which happens after the lock is acquired) must have been
      // rolled back with the transaction.
      expect(await prisma.orderTracking.findUnique({ where: { orderId: order.id } })).toBeNull();

      // If the advisory lock were session/global-scoped, this immediate retry
      // on the SAME key would deadlock. Transaction scope releases it on
      // rollback, so the retry must succeed straight away.
      const retried = await withOrderTrackingMutation(
        prisma,
        order.id,
        biz.id,
        (tx) => tx.orderTracking.update({
          where: { orderId: order.id },
          data: { timeline: [{ status: 'RETRY_OK', timestamp: new Date().toISOString() }] },
        }),
      );
      expect(retried.timeline).toHaveLength(1);
      expect(retried.timeline[0].status).toBe('RETRY_OK');
    });
  });

  // ── 3. storefrontDraftMutationSafeService ─────────────────────────────────

  describe('storefrontDraftMutationSafeService (withDraftMutation)', () => {
    async function seedDraft(bizId) {
      const theme = await seedTheme();
      return prisma.businessStorefrontLayout.create({
        data: {
          businessProfileId: bizId,
          status: 'DRAFT',
          themeId: theme.id,
          layoutJson: { hello: 'world' },
        },
      });
    }

    test('a normal mutation executes through the lock boundary successfully', async () => {
      const { biz } = await seedBusiness();
      const draft = await seedDraft(biz.id);
      const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');

      const result = await withDraftMutation(prisma, biz.id, null, (tx) =>
        tx.businessStorefrontLayout.update({
          where: { id: draft.id },
          data: { layoutJson: { hello: 'updated' } },
          select: { id: true, layoutJson: true },
        }),
      );

      expect(result.id).toBe(draft.id);
      expect(result.layoutJson).toEqual({ hello: 'updated' });
    });

    test('a stale expectedUpdatedAt still produces the canonical STOREFRONT_DRAFT_STALE 409', async () => {
      const { biz } = await seedBusiness();
      await seedDraft(biz.id);
      const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');

      const stale = new Date(Date.now() - 60_000).toISOString();
      await expect(
        withDraftMutation(prisma, biz.id, stale, () => Promise.resolve('unreachable')),
      ).rejects.toMatchObject({ code: 'STOREFRONT_DRAFT_STALE', statusCode: 409 });
    });

    test('a fresh expectedUpdatedAt passes the compare-and-swap check', async () => {
      const { biz } = await seedBusiness();
      const draft = await seedDraft(biz.id);
      const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');

      const fresh = draft.updatedAt.toISOString();
      const result = await withDraftMutation(prisma, biz.id, fresh, (tx) =>
        tx.businessStorefrontLayout.update({
          where: { id: draft.id },
          data: { layoutJson: { hello: 'cas-ok' } },
          select: { id: true },
        }),
      );
      expect(result.id).toBe(draft.id);
    });

    test('concurrent draft mutations on the same business serialize', async () => {
      const { biz } = await seedBusiness();
      const draft = await seedDraft(biz.id);
      const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');

      await Promise.all(
        [0, 1, 2].map((i) =>
          withDraftMutation(prisma, biz.id, null, (tx) =>
            tx.businessStorefrontLayout.update({
              where: { id: draft.id },
              data: { layoutJson: { writer: i } },
            }),
          ),
        ),
      );

      const rows = await prisma.businessStorefrontLayout.findMany({
        where: { businessProfileId: biz.id, status: 'DRAFT' },
      });
      expect(rows).toHaveLength(1); // no duplicate drafts despite concurrency
      expect(rows[0].layoutJson).toHaveProperty('writer');
    });

    test('failure inside the mutation callback rolls back; an immediate retry re-acquires the same lock', async () => {
      const { biz } = await seedBusiness();
      const draft = await seedDraft(biz.id);
      const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');

      const before = await prisma.businessStorefrontLayout.findUnique({ where: { id: draft.id } });
      const boom = Object.assign(new Error('deliberate draft failure'), { code: 'TEST_BOOM' });
      await expect(
        withDraftMutation(prisma, biz.id, null, async () => { throw boom; }),
      ).rejects.toMatchObject({ code: 'TEST_BOOM' });

      // Nothing changed — the transaction rolled back.
      const after = await prisma.businessStorefrontLayout.findUnique({ where: { id: draft.id } });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // Same lock key, immediately re-acquirable → transaction-scoped lock.
      const retried = await withDraftMutation(prisma, biz.id, null, (tx) =>
        tx.businessStorefrontLayout.update({
          where: { id: draft.id },
          data: { layoutJson: { hello: 'retry-ok' } },
          select: { id: true, layoutJson: true },
        }),
      );
      expect(retried.layoutJson).toEqual({ hello: 'retry-ok' });
    });
  });

  // ── 4. storefrontPublishSafeService (shared draft lock path) ──────────────

  describe('storefrontPublishSafeService (publish inherits the shared draft lock)', () => {
    test('publishLayoutSafe succeeds against PostgreSQL through the shared withDraftMutation boundary', async () => {
      const { owner, biz } = await seedBusiness();
      const theme = await seedTheme();
      await prisma.businessStorefrontLayout.create({
        data: {
          businessProfileId: biz.id,
          status: 'DRAFT',
          themeId: theme.id,
          layoutJson: {}, // minimal valid layout: no studio experience, no premium widgets
        },
      });

      const { publishLayoutSafe } = require('../services/storefrontPublishSafeService');
      const published = await publishLayoutSafe(prisma, biz.id, owner.id, null);

      expect(published.status).toBe('PUBLISHED');
      expect(published.businessProfileId).toBe(biz.id);
      expect(published.publishedBy).toBe(owner.id);
      expect(published.publishedAt).toBeTruthy();

      // The draft is consumed by publish (existing semantics).
      const drafts = await prisma.businessStorefrontLayout.findMany({
        where: { businessProfileId: biz.id, status: 'DRAFT' },
      });
      expect(drafts).toHaveLength(0);
    });

    test('publish carries the draft compare-and-swap semantics (stale snapshot → 409)', async () => {
      const { biz } = await seedBusiness();
      const theme = await seedTheme();
      await prisma.businessStorefrontLayout.create({
        data: {
          businessProfileId: biz.id,
          status: 'DRAFT',
          themeId: theme.id,
          layoutJson: {},
        },
      });

      const { publishLayoutSafe } = require('../services/storefrontPublishSafeService');
      const stale = new Date(Date.now() - 60_000).toISOString();
      await expect(publishLayoutSafe(prisma, biz.id, 1, stale)).rejects.toMatchObject({
        code: 'STOREFRONT_DRAFT_STALE',
        statusCode: 409,
      });
    });

    test('publish service adds no duplicate advisory lock (source-level guard)', () => {
      const publishSrc = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'storefrontPublishSafeService.js'),
        'utf8',
      );
      expect(publishSrc).not.toMatch(/pg_advisory/);
      expect(publishSrc).toMatch(/withDraftMutation/);
    });
  });
});
