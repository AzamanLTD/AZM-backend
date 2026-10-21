'use strict';
// =============================================================================
// WORKSTREAM D — BUSINESS OFFERED-CATEGORIES CONTRACT (real PostgreSQL proofs)
//
// Pins the additive, backward-compatible contract for additional declared
// business offerings (Workstream D, review items 4-6 of the AZAMAN work
// programme 2026-10-21):
//   • the canonical set is the EXISTING BusinessCategory enum — no invented
//     taxonomy; the primary category stays in its own `category` column;
//   • registration persists explicitly declared offerings (deduped);
//   • PATCH /profile validates strictly: unknown category → 400 with ZERO
//     mutation; non-array → 400; >8 entries → 400;
//   • an EMPTY list is a valid state (existing records keep []) — the
//     marketplace card must render no fake icons for it;
//   • the public search surface carries the field (full rows, additive);
//   • dedupe preserves the first declaration order.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const businessService = require('../services/businessService');
const {
    businessRegisterSchema,
    businessUpdateSchema,
} = require('../services/validation/businessSchemas');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('Business offered-categories contract (real PostgreSQL)', () => {
    let db;
    let seq;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'OffCat Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'offcat-user' } } });
        await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'OffCat Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'offcat-user' } } });
    });

    // ─── seed helpers ───────────────────────────────────────────────────────

    async function seedUser() {
        const n = seq++;
        return db.user.create({
            data: { username: `offcat-user-${n}`, email: `offcat-${n}@test.azm`, password: 'x' },
        });
    }

    async function seedBusiness(user, { offeredCategories } = {}) {
        const n = seq++;
        return db.businessProfile.create({
            data: {
                userId: user.id,
                bizId: `BIZ-9000${String(n).padStart(5, '0')}`,
                businessName: `OffCat Biz ${n}`,
                category: 'HOSPITALITY',
                ...(offeredCategories ? { offeredCategories } : {}),
            },
        });
    }

    // ─── 1. Zod contract shape ──────────────────────────────────────────────

    test('register schema: canonical enum array accepted; unknown category 400s', () => {
        const ok = businessRegisterSchema.safeParse({
            businessName: 'Test',
            category: 'HOSPITALITY',
            offeredCategories: ['FOOD_BEVERAGE', 'RETAIL'],
        });
        expect(ok.success).toBe(true);

        const bad = businessRegisterSchema.safeParse({
            businessName: 'Test',
            offeredCategories: ['NOT_A_CATEGORY'],
        });
        expect(bad.success).toBe(false);
        expect(bad.error.issues[0].message).toMatch(/Invalid option|Invalid enum value/i);
    });

    test('update schema: >8 offerings 400s; empty array accepted', () => {
        const tooMany = businessUpdateSchema.safeParse({
            offeredCategories: [
                'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY',
                'REAL_ESTATE', 'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT',
                'LOGISTICS',
            ],
        });
        expect(tooMany.success).toBe(false);
        expect(tooMany.error.issues[0].message).toMatch(/at most 8/i);

        const empty = businessUpdateSchema.safeParse({ offeredCategories: [] });
        expect(empty.success).toBe(true);
    });

    // ─── 2. Service contract on real Postgres ──────────────────────────────

    test('registration persists explicitly declared, deduped offerings', async () => {
        const user = await seedUser();
        const { businessProfile } = await businessService.registerBusiness(db, {
            userId: user.id,
            businessName: 'OffCat Reg Biz',
            category: 'HOSPITALITY',
            offeredCategories: ['FOOD_BEVERAGE', 'FOOD_BEVERAGE', 'RETAIL'],
        });
        expect(businessProfile.offeredCategories).toEqual(['FOOD_BEVERAGE', 'RETAIL']);
    });

    test('PATCH persists valid offerings and returns the full profile', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user);

        const updated = await businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: ['FOOD_BEVERAGE', 'ENTERTAINMENT'] },
        });
        expect(updated.offeredCategories).toEqual(['FOOD_BEVERAGE', 'ENTERTAINMENT']);
        expect(updated.category).toBe('HOSPITALITY',
            'the PRIMARY category stays in its own column — offerings never rewrite it');

        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.offeredCategories).toEqual(['FOOD_BEVERAGE', 'ENTERTAINMENT']);
    });

    test('unknown category → 400 AND zero mutation (nothing silently dropped)', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: ['EDUCATION'] });

        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: ['NOT_A_CATEGORY'] },
        })).rejects.toThrow(/unknown category: NOT_A_CATEGORY/i);

        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.offeredCategories).toEqual(['EDUCATION'],
            'the failed update must not touch the stored offerings');
    });

    // ─── 2b. Registration strictness (no silent filtering) ─────────────────

    test('registration REJECTS an unknown category (never silently filtered)', async () => {
        const user = await seedUser();
        await expect(businessService.registerBusiness(db, {
            userId: user.id,
            businessName: 'OffCat Reject Biz',
            category: 'HOSPITALITY',
            offeredCategories: ['FOOD_BEVERAGE', 'NOT_A_CATEGORY'],
        })).rejects.toThrow(/unknown category: NOT_A_CATEGORY/i);

        const any = await db.businessProfile.findFirst({
            where: { businessName: 'OffCat Reject Biz' } });
        expect(any).toBeNull(); // rejected registration created NOTHING
    });

    test('registration REJECTS the primary category inside the offerings', async () => {
        const user = await seedUser();
        await expect(businessService.registerBusiness(db, {
            userId: user.id,
            businessName: 'OffCat Dup Biz',
            category: 'HOSPITALITY',
            offeredCategories: ['FOOD_BEVERAGE', 'HOSPITALITY'],
        })).rejects.toThrow(/must not repeat the primary category/i);
    });

    // ─── 2c. Final-profile validation (key-order independence) ─────────────

    test('PATCH rejects offerings repeating the NEW primary (category-first order)', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: ['EDUCATION'] });
        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: {
                category: 'FOOD_BEVERAGE',
                offeredCategories: ['EDUCATION', 'FOOD_BEVERAGE'],
            },
        })).rejects.toThrow(/must not repeat the primary category/i);
        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.category).toBe('HOSPITALITY',
            'the whole request must be rejected with zero mutation');
        expect(reread.offeredCategories).toEqual(['EDUCATION']);
    });

    test('PATCH rejects offerings repeating the NEW primary (offerings-first order)', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: ['EDUCATION'] });
        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: {
                offeredCategories: ['EDUCATION', 'FOOD_BEVERAGE'],
                category: 'FOOD_BEVERAGE',
            },
        })).rejects.toThrow(/must not repeat the primary category/i);
        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.category).toBe('HOSPITALITY');
        expect(reread.offeredCategories).toEqual(['EDUCATION']);
    });

    test('PATCH accepts a combined category+offerings change that is consistent', async () => {
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: ['EDUCATION'] });
        const updated = await businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: {
                category: 'FOOD_BEVERAGE',
                offeredCategories: ['ENTERTAINMENT', 'EDUCATION'],
            },
        });
        expect(updated.category).toBe('FOOD_BEVERAGE');
        expect(updated.offeredCategories).toEqual(['ENTERTAINMENT', 'EDUCATION']);
    });

    // ─── 2d. Overlay installer proofs (real PostgreSQL, disposable DB) ──────

    const overlay = require('../infra/install-business-offered-categories-overlay');

    test('installer adds the column to an existing table WITHOUT damaging rows', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: ['EDUCATION'] });

        // Absence proof: drop, then install.
        await db.$executeRawUnsafe('ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "offeredCategories"');
        const absent = await db.$queryRawUnsafe(
            'SELECT 1 FROM information_schema.columns WHERE table_name = \'BusinessProfile\' AND column_name = \'offeredCategories\'');
        expect(absent.length).toBe(0);

        const r = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r.ok).toBe(1);

        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread).not.toBeNull(); // existing rows survive the overlay
        expect(reread.businessName).toBe(biz.businessName);

        const after = await db.$queryRawUnsafe(
            'SELECT attnotnull, column_default FROM information_schema.columns c '
          + 'JOIN pg_catalog.pg_attribute a ON a.attname = c.column_name '
          + 'WHERE c.table_name = \'BusinessProfile\' AND c.column_name = \'offeredCategories\'');
        expect(after.length).toBeGreaterThan(0);
        expect(after[0].attnotnull).toBe(true);
    });

    test('installer is idempotent when the correctly shaped column exists', async () => {
        // Column already exists from db push / previous install.
        await seedBusiness(await seedUser());
        const r = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r.ok).toBe(1);
        // A second install (true idempotence) must also succeed.
        const r2 = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r2.ok).toBe(1);
    });

    test('installer FAILS (fail-closed) when the column has an invalid shape', async () => {
        // Corrupt the shape on purpose: wrong element type + nullable.
        await db.$executeRawUnsafe('ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "offeredCategories"');
        await db.$executeRawUnsafe(
            'ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "offeredCategories" TEXT');
        await expect(overlay.installBusinessOfferedCategoriesOverlay(db))
            .rejects.toThrow(/drift/i);

        // Restore the correct shape for later tests.
        await db.$executeRawUnsafe('ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "offeredCategories"');
        const r = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r.ok).toBe(1);
    });

    test('non-array and >8 → 400 with zero mutation', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user);

        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: 'RETAIL' },
        })).rejects.toThrow(/must be an array/i);

        const nine = Array(9).fill('RETAIL');
        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: nine },
        })).rejects.toThrow(/at most 8/i);

        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.offeredCategories).toEqual([]);
    });

    test('an empty array CLEARS offerings — "no additional offerings" is valid', async () => {
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });

        const updated = await businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: [] },
        });
        expect(updated.offeredCategories).toEqual([]);
    });

    test('existing records read as [] — backward compatible', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user); // created without the field
        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.offeredCategories).toEqual([]);
    });

    // ─── 3. Public surface ─────────────────────────────────────────────────

    test('public search rows carry offeredCategories (additive payload field)', async () => {
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });

        const rows = await businessService.searchBusinesses(db, { query: 'OffCat Biz' });
        const mine = rows.find((r) => r.offeredCategories?.includes('FOOD_BEVERAGE'));
        expect(mine).toBeDefined();
        expect(typeof mine.offeredCategories).toBe('object');
        // Legacy rows without the field are untouched and still parse.
        expect(rows.every((r) => Array.isArray(r.offeredCategories))).toBe(true);
    });
});
