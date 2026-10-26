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

    test('register/update schemas: null offerings RESOLVE to [] (not a 400) '
        + 'while every other malformed shape still rejects', () => {
        const regNull = businessRegisterSchema.safeParse({
            businessName: 'TT',
            offeredCategories: null,
        });
        expect(regNull.success).toBe(true,
            'null must pass the schema and resolve to [] downstream '
            + '(controller ternary on register, service on update)');

        const updNull = businessUpdateSchema.safeParse({ offeredCategories: null });
        expect(updNull.success).toBe(true);

        // The strict rejections stay strict — only null/omission resolve.
        for (const bad of ['RETAIL', 42, { 0: 'RETAIL' }, ['NOT_A_CATEGORY']]) {
            expect(businessUpdateSchema.safeParse({ offeredCategories: bad }).success)
                .toBe(false);
        }
    });

    test('service: register with null -> []; PATCH with null -> clears to []', async () => {
        const user = await seedUser();
        const { businessProfile } = await businessService.registerBusiness(db, {
            userId: user.id,
            businessName: 'OffCat Null Biz',
            category: 'HOSPITALITY',
            offeredCategories: null,
        });
        expect(businessProfile.offeredCategories).toEqual([]);

        await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });
        const updated = await businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: null },
        });
        expect(updated.offeredCategories).toEqual([]);
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

    // ─── 2c-bis. Final-profile invariant on category-ONLY PATCH ────────────

    test('PATCH that changes ONLY the primary category to a value already in '
        + 'the STORED offerings is rejected with zero mutation', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });

        // offerings OMITTED from the request entirely — the stored list is
        // the final list, so the new primary would repeat an "additional" offering.
        await expect(businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { category: 'FOOD_BEVERAGE' },
        })).rejects.toThrow(/must not repeat the primary category \(FOOD_BEVERAGE\)/i);

        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.category).toBe('HOSPITALITY',
            'the rejected PATCH must leave the primary category untouched');
        expect(reread.offeredCategories).toEqual(['FOOD_BEVERAGE'],
            'the rejected PATCH must leave the stored offerings untouched');
    });

    test('category-ONLY PATCH to a NON-colliding category succeeds and PRESERVES '
        + 'the stored offerings (omission never clears)', async () => {
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });

        const updated = await businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { category: 'TECHNOLOGY' },
        });
        expect(updated.category).toBe('TECHNOLOGY');
        expect(updated.offeredCategories).toEqual(['FOOD_BEVERAGE'],
            'an omitted offerings field preserves the stored list');
    });

    // ─── 2c-ter. CONCURRENCY: the cross-field invariant survives concurrent
    // PATCHes (deterministic, real PostgreSQL) ─────────────────────────────
    //
    // The single-request validation is not enough by itself: read → validate
    // → write as separate operations lets two concurrent PATCHes each pass
    // against the OLD row (A: category-only, B: offerings-only) and both
    // commit, storing the primary inside its own offerings. updateBusinessProfile
    // now reads, validates and writes inside ONE transaction under a row
    // FOR UPDATE lock, so the second request wakes up on the FIRST's committed
    // state and revalidates against THAT.

    test('two conflicting PATCHes raced together: both transactions are '
        + 'provably OPEN before either proceeds, and exactly one may commit', async () => {
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: [] });

        // Deterministic coordination INSIDE the interactive transactions:
        // each service call is wrapped so the barrier is released only when
        // the REAL transaction callback starts executing. Both service
        // callbacks then wait until BOTH transactions are open, so the two
        // FOR UPDATE lock attempts run against each other — this proves the
        // interleaving instead of assuming it from Promise.all timing.
        let opened = 0;
        let releaseBarrier;
        const barrier = new Promise((res) => { releaseBarrier = res; });
        // Full delegating wrapper: $transaction is intercepted for the
        // barrier; EVERYTHING ELSE passes through to the real client, so
        // against a pre-fix implementation (no transaction layer) the two
        // requests still execute the plain read-validate-write path and the
        // test fails on the RACE (two commits / broken invariant), not on a
        // missing wrapper surface. NOTE: NOT Object.create(db) — the Prisma
        // client is proxied internally and assigning $transaction on a
        // prototype child ALSO overwrites the real client's $transaction
        // (infinite recursion). A Proxy with per-get binding avoids both.
        const instrumented = new Proxy({}, {
            get: (_target, prop) => {
                if (prop === '$transaction') {
                    return (fn, opts) => db.$transaction(async (tx) => {
                        opened += 1;
                        if (opened === 2) releaseBarrier();
                        await barrier; // both transaction callbacks open, released together
                        return fn(tx);
                    }, opts);
                }
                const value = Reflect.get(db, prop);
                return typeof value === 'function' ? value.bind(db) : value;
            }
        });

        const requestA = businessService.updateBusinessProfile(instrumented, {
            userId: user.id,
            updates: { category: 'FOOD_BEVERAGE' },
        });
        const requestB = businessService.updateBusinessProfile(instrumented, {
            userId: user.id,
            updates: { offeredCategories: ['FOOD_BEVERAGE'] },
        });

        // Both transactions are provably open before either callback
        // proceeds. Without the serialization fix there is no $transaction
        // layer at all: the barrier can never release, both requests race
        // the read-validate-write sequence unserialized, and the assertions
        // below then fail on the RACE itself (two commits / invariant broken).
        const raced = await Promise.race([
            barrier.then(() => true),
            new Promise((res) => setTimeout(() => res(false), 2000)),
        ]);
        const [resA, resB] = await Promise.allSettled([requestA, requestB]);

        const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1,
            'the row lock must serialize the pair: exactly one of the two '
            + 'conflicting PATCHes may commit (pre-fix: both win the race)');

        // Whichever won, the COMMITTED state cannot repeat the primary.
        const row = await db.businessProfile.findFirst({ where: { userId: user.id } });
        expect(row.offeredCategories).not.toContain(row.category,
            'the stored profile must never list its primary as an additional offering');
        if (resA.status === 'fulfilled') {
            expect(raced).toBe(true);
            expect(row.category).toBe('FOOD_BEVERAGE');
            expect(row.offeredCategories).toEqual([]);
        } else {
            expect(raced).toBe(true);
            expect(row.category).toBe('HOSPITALITY');
            expect(row.offeredCategories).toEqual(['FOOD_BEVERAGE']);
            expect(resB.reason.message).toMatch(/must not repeat the primary category/i);
        }
        if (resA.status === 'rejected') {
            expect(resA.reason.message).toMatch(/must not repeat the primary category/i);
        }
    });

    test('a PATCH parked on a held row lock is PROVEN waiting (pg_locks '
        + 'evidence), then revalidates against the COMMITTED row', async () => {
        const user = await seedUser();
        const biz = await seedBusiness(user, { offeredCategories: [] });

        // Deterministic interleave with OBSERVED lock-wait evidence, no
        // fixed sleeps: the holder transaction takes the row lock and
        // publishes its own transaction id; the service PATCH below is then
        // proven BLOCKED on that exact lock via pg_locks (a NOT-granted
        // transactionid wait pointing at the holder) BEFORE the holder
        // commits. Pre-fix there is no lock to wait on: no wait is ever
        // observed AND the parked PATCH sails through with a bad commit —
        // so the failure mode is the race, not a missing test surface.
        let holderXid;
        let lockHeld;
        let holderReleased;
        const held = new Promise((res) => { lockHeld = res; });
        const committingTx = db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "BusinessProfile" WHERE "userId" = ${user.id} LIMIT 1 FOR UPDATE`;
            const [xidRow] = await tx.$queryRaw`SELECT txid_current()::text AS xid`;
            holderXid = xidRow.xid;
            lockHeld();
            await new Promise((r) => { holderReleased = r; }); // wait for proof, not a timer
            await tx.businessProfile.update({ where: { id: biz.id }, data: { category: 'FOOD_BEVERAGE' } });
        });
        await held;

        const blocked = businessService.updateBusinessProfile(db, {
            userId: user.id,
            updates: { offeredCategories: ['FOOD_BEVERAGE'] },
        });

        // Poll for POSITIVE evidence that the service transaction is
        // waiting on the holder's transaction id (row-lock wait).
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i += 1) {
            const [row] = await db.$queryRaw`
                SELECT count(*)::int AS n FROM pg_locks
                WHERE locktype = 'transactionid' AND granted = false
                  AND transactionid::text = ${holderXid}`;
            waiting = row.n >= 1;
            if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting).toBe(true,
            'the parked PATCH must be OBSERVED waiting on the holder row lock '
            + '(pg_locks transactionid wait) before the holder commits');

        holderReleased(); // release the holder so it commits the category change
        await expect(blocked).rejects.toThrow(
            /must not repeat the primary category \(FOOD_BEVERAGE\)/i);
        await committingTx; // holder finished cleanly

        const row = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(row.category).toBe('FOOD_BEVERAGE');
        expect(row.offeredCategories).toEqual([],
            'the rejected PATCH must not have written anything');
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

    test('REGRESSION (CI run 39685609232): a db-push-rendered NULLABLE column with NULL rows is NORMALIZED to the NOT NULL contract', async () => {
        // Prisma db push renders scalar LIST columns nullable (it does so
        // for amenities/cuisineTypes too) and ADD COLUMN IF NOT EXISTS
        // no-ops on an existing column, so the installer must ENFORCE
        // NOT NULL itself. This is the exact CI shape that failed.
        const biz = await seedBusiness(await seedUser());
        await db.$executeRawUnsafe(
            `ALTER TABLE "BusinessProfile" ALTER COLUMN "offeredCategories" DROP NOT NULL`);
        await db.$executeRawUnsafe(
            `UPDATE "BusinessProfile" SET "offeredCategories" = NULL WHERE id = '${biz.id}'`);
        const before = await db.$queryRawUnsafe(
            `SELECT attnotnull FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
             WHERE cl.relname = 'BusinessProfile'
               AND a.attname = 'offeredCategories'`);
        expect(before[0].attnotnull).toBe(false);

        const r = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r.ok).toBe(1);

        // NOT NULL enforced, NULL row backfilled to the empty array...
        const after = await db.$queryRawUnsafe(
            `SELECT attnotnull FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
             WHERE cl.relname = 'BusinessProfile'
               AND a.attname = 'offeredCategories'`);
        expect(after[0].attnotnull).toBe(true);
        const reread = await db.businessProfile.findUnique({ where: { id: biz.id } });
        expect(reread.offeredCategories).toEqual([]);
        // ...and a second install is still idempotent.
        const r2 = await overlay.installBusinessOfferedCategoriesOverlay(db);
        expect(r2.ok).toBe(1);
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

        const rows = (await businessService.searchBusinesses(db, { query: 'OffCat Biz' })).rows;
        const mine = rows.find((r) => r.offeredCategories?.includes('FOOD_BEVERAGE'));
        expect(mine).toBeDefined();
        expect(typeof mine.offeredCategories).toBe('object');
        // Legacy rows without the field are untouched and still parse.
        expect(rows.every((r) => Array.isArray(r.offeredCategories))).toBe(true);
    });

    // ─── 4. Controller/route-level error contract (real PostgreSQL) ────────
    //
    // The service rejections above are only half the contract: the HTTP
    // layer must classify them correctly. The invariant error message
    // contains none of the legacy classifier's keywords, so before the
    // typed-error mapping a valid-but-conflicting PATCH reached the API
    // client as HTTP 500. These tests pin the full route behavior:
    // duplicate-primary PATCHes return 400 with ZERO mutation, while
    // genuine unexpected failures stay 500.

    const buildBusinessApp = () => {
        const request = require('supertest');
        const express = require('express');
        const jwt = require('jsonwebtoken');
        const businessRoutes = require('../routes/businessRoutes');
        const app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/business', businessRoutes);
        const signToken = (userId) => jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
        return { app, request, signToken };
    };

    test('route: duplicate-primary PATCH (offerings containing the new primary) '
        + 'returns 400 — NOT 500 — with zero mutation', async () => {
        const { app, request, signToken } = buildBusinessApp();
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: [] });

        const res = await request(app)
            .patch('/api/business/profile')
            .set('Authorization', `Bearer ${signToken(user.id)}`)
            .send({ category: 'FOOD_BEVERAGE', offeredCategories: ['FOOD_BEVERAGE'] });

        expect(res.status).toBe(400,
            'a valid-but-conflicting PATCH is a client error, not an internal one');
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/must not repeat the primary category/i);

        // Zero mutation through the whole route stack.
        const row = await db.businessProfile.findFirst({ where: { userId: user.id } });
        expect(row.category).toBe('HOSPITALITY');
        expect(row.offeredCategories).toEqual([]);
    });

    test('route: duplicate-primary PATCH (primary colliding with STORED '
        + 'offerings) returns 400 with zero mutation', async () => {
        const { app, request, signToken } = buildBusinessApp();
        const user = await seedUser();
        await seedBusiness(user, { offeredCategories: ['FOOD_BEVERAGE'] });

        const res = await request(app)
            .patch('/api/business/profile')
            .set('Authorization', `Bearer ${signToken(user.id)}`)
            .send({ category: 'FOOD_BEVERAGE' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/must not repeat the primary category/i);
        const row = await db.businessProfile.findFirst({ where: { userId: user.id } });
        expect(row.category).toBe('HOSPITALITY');
        expect(row.offeredCategories).toEqual(['FOOD_BEVERAGE']);
    });

    test('route: POST /register with the primary repeated in offeredCategories '
        + 'returns 400 and creates NO BusinessProfile', async () => {
        const { app, request, signToken } = buildBusinessApp();
        const user = await seedUser();

        const res = await request(app)
            .post('/api/business/register')
            .set('Authorization', `Bearer ${signToken(user.id)}`)
            .send({
                businessName: 'OffCat Biz Dup',
                category: 'HOSPITALITY',
                offeredCategories: ['FOOD_BEVERAGE', 'HOSPITALITY'],
            });

        expect(res.status).toBe(400,
            'a duplicate-primary registration is a client error, not an internal one');
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/must not repeat the primary category/i);

        const created = await db.businessProfile.findMany({ where: { userId: user.id } });
        expect(created).toHaveLength(0);
    });

    test('controller: registration infrastructure failure remains HTTP 500', async () => {
        const ctrl = require('../controllers/businessController');
        const res = {
            status: (code) => { res._code = code; return res; },
            json: (body) => { res._body = body; }
        };
        const rejectAll = () => Promise.reject(new Error('connection terminated'));
        const brokenPrisma = {
            businessProfile: { findFirst: rejectAll, create: rejectAll, update: rejectAll }
        };
        await ctrl.registerBusiness(
            { app: { get: () => brokenPrisma }, user: { id: 'x' }, body: { businessName: 'OffCat Biz Ok', category: 'RETAIL' } },
            res
        );
        expect(res._code).toBe(500);
        expect(res._body.message).toBe('connection terminated');
    });

    test('controller: a genuine unexpected failure remains HTTP 500', async () => {
        const ctrl = require('../controllers/businessController');
        const res = {
            status: (code) => {
                res._code = code;
                return res;
            },
            json: (body) => { res._body = body; }
        };
        // An infrastructure-level failure the service cannot classify as
        // validation — must surface as 500, never swallowed into a 400.
        const brokenPrisma = {
            $transaction: () => Promise.reject(new Error('connection terminated'))
        };
        await ctrl.updateBusinessProfile(
            { app: { get: () => brokenPrisma }, user: { id: 'does-not-matter' }, body: { businessName: 'OffCat Biz Renamed' } },
            res
        );
        expect(res._code).toBe(500);
        expect(res._body.success).toBe(false);
        expect(res._body.message).toBe('connection terminated');
    });
});
