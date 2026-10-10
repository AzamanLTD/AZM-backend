'use strict';
// =============================================================================
// GHS listing-price model — REAL PostgreSQL proofs (P1, 2026-10-10).
//
// Pins the owner-approved invariants of
// docs/MARKETPLACE_GHS_PRICING_AND_PAYMENT_CONTRACT_2026-10-10.md §1.1 + §6:
//   • the DB (partial unique index), not the service, guarantees one ACTIVE
//     current row per (product, currency, scope, branch);
//   • effective-date CHECK: a closed window is strictly ordered;
//   • a base price is positive (free-item model not in v1);
//   • confirmation records actor + timestamp; MIGRATION rows never resolve;
//   • exact-decimal discipline: sub-pesewa, float, negative-zero and
//     whitespace inputs are rejected; the parser never rounds silently;
//   • priceDeltaGhs bounds + worst-case final-price validation in integer
//     pesewas.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const svc = require('../services/businessPriceService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('BusinessPrice GHS listing model (real PostgreSQL)', () => {
    let db;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    beforeEach(async () => {
        await db.businessPrice.deleteMany({});
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghs-price-test-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GHS Price Test Profile' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghs-price-test-user' } } });
    });

    async function seedProduct(n = 1) {
        const owner = await db.user.create({
            data: { username: `ghs-price-test-user-${n}-${Date.now()}`, email: `ghs-price-test-${n}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `GHS Price Test Profile ${n}`,
                bizId: `BIZ-GHS-${n}-${String(Date.now()).slice(-6)}`,
                category: 'FOOD_BEVERAGE',
            },
        });
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `GHS price test product ${n}`,
                slug: `ghs-price-test-${n}-${Date.now()}`,
                priceUsdc: new Prisma.Decimal('10.5'),
            },
        });
        return { profile, product };
    }

    // ─── exact-decimal parser (§6 test matrix) ────────────────────────────────

    describe('exact-decimal parsing', () => {
        test('accepts canonical 2dp strings and integer-pesewas arithmetic', () => {
            expect(svc.parseBaseGhsAmount('25.00').toString()).toBe('25');
            expect(svc.pesewasToGhsString(svc.toPesewas(svc.parseBaseGhsAmount('125000')))).toBe('125000.00');
            expect(svc.toPesewas('0.10') + svc.toPesewas('0.20')).toBe(30n); // 30 pesewas, never 0.30000000000000004
        });

        test.each(['25.001', '25.00 ', ' 25.00', '-0', '-0.00', '', '1e2', '25,00'])(
            'rejects malformed input "%s" without rounding silently', (bad) => {
                expect(() => svc.parseBaseGhsAmount(bad)).toThrow(svc.BusinessPriceError);
            });

        test('rejects JS numbers — binary floating-point is never authoritative', () => {
            expect(() => svc.parseBaseGhsAmount(25)).toThrow(/never an authoritative GHS input/);
            expect(() => svc.parseBaseGhsAmount(0.1 + 0.2)).toThrow(/never an authoritative GHS input/);
        });

        test('rejects non-positive base prices (free-item model not in v1)', () => {
            expect(() => svc.parseBaseGhsAmount('0')).toThrow(/positive/);
            expect(() => svc.parseBaseGhsAmount('0.00')).toThrow(/positive/);
            expect(() => svc.parseBaseGhsAmount('-5.00')).toThrow(/negative/);
        });

        test('deltas accept zero and negatives but reject negative zero and sub-pesewa', () => {
            expect(() => svc.parseGhsDecimal('0', { allowNegative: true })).not.toThrow();
            expect(() => svc.parseGhsDecimal('-1.50', { allowNegative: true })).not.toThrow();
            expect(() => svc.parseGhsDecimal('-0', { allowNegative: true })).toThrow(/negative zero/);
            expect(() => svc.parseGhsDecimal('-1.505', { allowNegative: true })).toThrow(/2dp decimal/);
        });
    });

    // ─── priceDeltaGhs configuration validation ─────────────────────────────

    describe('priceDeltaGhs validation', () => {
        test('worst-case selection (base + every negative delta) must stay positive — integer pesewas', () => {
            const result = svc.validateGhsDeltas({
                baseGhs: '20.00',
                variants: [{ name: 'Size', options: [{ label: 'Small', priceDeltaGhs: '-5.00' }, { label: 'Large', priceDeltaGhs: '3.00' }] }],
                modifierGroups: [{ name: 'Add-ons', max: 2, options: [{ name: 'Extra Sauce', priceDeltaGhs: '-14.99' }] }],
            });
            expect(result.worstCaseFinalPesewas).toBe(1n); // 20.00 - 5.00 - 14.99 = 0.01 GHS
        });

        test('rejects a configuration whose worst case is not a positive price', () => {
            expect(() => svc.validateGhsDeltas({
                baseGhs: '20.00',
                variants: [{ options: [{ label: 'Small', priceDeltaGhs: '-5.00' }] }],
                modifierGroups: [{ options: [{ name: 'X', priceDeltaGhs: '-15.01' }] }],
            })).toThrow(/positive price/);
        });

        test('rejects out-of-bounds and float deltas', () => {
            expect(() => svc.validateGhsDeltas({
                baseGhs: '20.00',
                variants: [{ options: [{ label: 'X', priceDeltaGhs: '-100001.00' }] }],
            })).toThrow(/bounds/);
            expect(() => svc.validateGhsDeltas({
                baseGhs: '20.00',
                variants: [{ options: [{ label: 'X', priceDeltaGhs: 2.5 }] }],
            })).toThrow(/authoritative GHS input/);
        });
    });

    // ─── the database as the single-current-price authority ───────────────────

    describe('single-current-price enforcement', () => {
        test('a second concurrent ACTIVE current row is rejected by the DB partial unique index, not app code', async () => {
            // The partial unique index EXISTS and is the DB-layer authority
            // (Prisma's P2002 message prints the field list, not the index name).
            const index = await db.$queryRaw`
                SELECT indexdef FROM pg_indexes
                WHERE indexname = 'business_price_current_unique' AND tablename = 'BusinessPrice'`;
            expect(index).toHaveLength(1);
            expect(String(index[0].indexdef)).toMatch(/CREATE UNIQUE INDEX/);
            expect(String(index[0].indexdef)).toMatch(/WHERE/); // partial: ACTIVE + current rows only

            const { product } = await seedProduct();
            await db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('25.00') },
            });
            // A raw create that bypasses the service MUST fail at the DB layer.
            await expect(db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('30.00') },
            })).rejects.toThrow(/Unique constraint failed/);

            // ...and the identity folds NULL locationId of DEFAULT scope: a
            // DEFAULT row and a NULL-location row are the same identity.
            await expect(db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('30.00'), locationId: null },
            })).rejects.toThrow(/Unique constraint failed/);

            // A BRANCH row for another branch is a DIFFERENT identity and is allowed.
            await expect(db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('30.00'), scope: 'BRANCH', locationId: 'loc-other' },
            })).resolves.toBeTruthy();
        });

        test('setPrice archives the current row and creates exactly one new ACTIVE row', async () => {
            const { product } = await seedProduct();
            const first = await db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '25.00', confirmedByType: 'BUSINESS', confirmedById: 'u1', confirm: true,
            }));
            expect(first.status).toBe('ACTIVE');
            expect(first.confirmedAt).not.toBeNull();
            expect(first.confirmedById).toBe('u1');

            const second = await db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '27.50', confirmedByType: 'BUSINESS', confirmedById: 'u1', confirm: true,
            }));

            const rows = await db.businessPrice.findMany({ where: { businessProductId: product.id }, orderBy: { effectiveFrom: 'asc' } });
            expect(rows).toHaveLength(2);
            const [oldRow, newRow] = rows;
            expect(oldRow.status).toBe('ARCHIVED');
            expect(oldRow.effectiveTo).not.toBeNull();
            expect(newRow.status).toBe('ACTIVE');
            expect(newRow.effectiveTo).toBeNull();
            expect(newRow.amountExact.toString()).toBe('27.5');
            expect(second.id).toBe(newRow.id);
        });
    });

    // ─── effective-date integrity ────────────────────────────────────────────

    describe('effective-date CHECK', () => {
        test('a closed window must be strictly after its start — rejected by the DB CHECK', async () => {
            const { product } = await seedProduct();
            const from = new Date();
            await expect(db.businessPrice.create({
                data: {
                    businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('10.00'),
                    effectiveFrom: from, effectiveTo: from, status: 'ARCHIVED',
                },
            })).rejects.toThrow(/business_price_effective_window_check/);

            const before = new Date(from.getTime() - 1000);
            await expect(db.businessPrice.create({
                data: {
                    businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('10.00'),
                    effectiveFrom: from, effectiveTo: before, status: 'ARCHIVED',
                },
            })).rejects.toThrow(/business_price_effective_window_check/);
        });

        test('positive-amount CHECK rejects zero and negative prices at the DB layer', async () => {
            const { product } = await seedProduct();
            await expect(db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('0') },
            })).rejects.toThrow(/business_price_amount_positive/);
            await expect(db.businessPrice.create({
                data: { businessProductId: product.id, currency: 'GHS', amountExact: new Prisma.Decimal('-1.00') },
            })).rejects.toThrow(/business_price_amount_positive/);
        });
    });

    // ─── confirmation, eligibility, MIGRATION exclusion ───────────────────────

    describe('confirmation and eligibility', () => {
        test('MIGRATION rows never resolve; BUSINESS confirmation (actor + timestamp) makes the price eligible', async () => {
            const { product } = await seedProduct();
            // A raw backfill-style row: MIGRATION-authored, unconfirmed.
            await db.businessPrice.create({
                data: {
                    businessProductId: product.id, currency: 'GHS',
                    amountExact: new Prisma.Decimal('12.00'),
                    confirmedByType: 'MIGRATION', confirmedAt: null,
                },
            });
            expect(await svc.resolveEffectiveGhsPrice(db, product.id)).toBeNull();

            // P2 worklist confirm: a BUSINESS actor with id + timestamp.
            const row = await db.businessPrice.findFirst({ where: { businessProductId: product.id } });
            const confirmed = await db.$transaction(async (tx) => svc.confirmPrice(tx, {
                priceId: row.id, confirmedByType: 'BUSINESS', confirmedById: 'u42',
            }));
            expect(confirmed.confirmedAt).not.toBeNull();
            expect(confirmed.confirmedById).toBe('u42');
            expect(confirmed.confirmedByType).toBe('BUSINESS');

            const resolved = await svc.resolveEffectiveGhsPrice(db, product.id);
            expect(resolved.id).toBe(confirmed.id);
            expect(resolved.amountExact.toString()).toBe('12');

            // confirmPrice is idempotent: a replay converges without rewriting the trail.
            const replay = await db.$transaction(async (tx) => svc.confirmPrice(tx, {
                priceId: row.id, confirmedByType: 'ADMIN', confirmedById: 'other-admin',
            }));
            expect(replay.confirmedById).toBe('u42'); // first confirmation wins
        });

        test('setPrice refuses unconfirmed writes without an actor and MIGRATION confirmations', async () => {
            const { product } = await seedProduct();
            await expect(db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '5.00', confirm: true, confirmedById: null,
            }))).rejects.toThrow(/auditable actor/);
            await expect(db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '5.00', confirmedByType: 'MIGRATION', confirm: true, confirmedById: 'm1',
            }))).rejects.toThrow(/MIGRATION rows never confirm/);
        });

        test('resolveEffectiveGhsPrice ignores BRANCH rows (v1 rule) and unknown products', async () => {
            const { product } = await seedProduct();
            await db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '9.99', scope: 'BRANCH', locationId: 'loc-1',
                confirmedByType: 'ADMIN', confirmedById: 'a1', confirm: true,
            }));
            expect(await svc.resolveEffectiveGhsPrice(db, product.id)).toBeNull(); // BRANCH is schema-ready, not consumed in v1
            expect(await svc.resolveEffectiveGhsPrice(db, 'does-not-exist')).toBeNull();
        });
    });

    // ─── scope hygiene ───────────────────────────────────────────────────────

    describe('scope rules', () => {
        test('BRANCH requires a location; DEFAULT forbids one', async () => {
            const { product } = await seedProduct();
            await expect(db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '5.00', scope: 'BRANCH', locationId: null,
                confirmedByType: 'ADMIN', confirmedById: 'a1',
            }))).rejects.toThrow(/BRANCH scope requires a locationId/);
            await expect(db.$transaction(async (tx) => svc.setPrice(tx, {
                businessProductId: product.id, amountGhs: '5.00', scope: 'DEFAULT', locationId: 'loc-1',
                confirmedByType: 'ADMIN', confirmedById: 'a1',
            }))).rejects.toThrow(/DEFAULT scope must have locationId null/);
        });
    });
});
