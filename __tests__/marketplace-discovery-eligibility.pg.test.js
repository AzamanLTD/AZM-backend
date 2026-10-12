'use strict';

// =============================================================================
// MARKETPLACE DISCOVERY ELIGIBILITY (Mix-redesign audit finding B-1)
//
// Proves the discovery-eligibility defect against real PostgreSQL:
//
//  B-1 — searchBusinesses filtered isSuspended but NOT isPausedByOwner, so an
//        owner-paused business stayed discoverable in public search while its
//        order attempts were refused. The eligibility rule must be identical
//        at browse time and at order time. Falsification: on the pre-fix code
//        the paused business is returned by searchBusinesses.
//
// Scope note (2026-10-14 review): the originally claimed companion defect in
// the legacy `routes/storefrontRoutes.js` `/discover` handler was REMOVED from
// this PR. In production `src/routes/index.js` mounts
// `storefrontDiscoverRoutes` (the canonical public discovery router, which
// already filters isSuspended/isPausedByOwner/storefrontDisabled and applies
// `businessProfile.category` correctly) BEFORE the legacy
// `storefrontRoutes`, so the legacy handler is unreachable for
// `/api/storefront/discover`. An isolated-router test cannot demonstrate a
// production defect, and the canonical route's behaviour is already pinned by
// `tests/storefrontDiscoverDisabledFilter.test.js`.
// =============================================================================

const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('marketplace discovery eligibility (PostgreSQL)', () => {
    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        const poolUrl = url + (url.includes('?') ? '&' : '?') + 'connection_limit=16';
        process.env.DATABASE_URL = poolUrl;
        prisma = new PrismaClient();
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        // Same CASCADE form as the other PG suites: truncate the FK roots and
        // let the cascade clear profiles, products, layouts, themes, tickets.
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "BusinessStorefrontTheme" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── helpers ─────────────────────────────────────────────────────────────

    // Local seeder — the shared seedBusiness factory pins category and cannot
    // express isPausedByOwner/isSuspended, so this suite owns its profile rows.
    const seedEligibleBusiness = async (overrides = {}) => {
        const { businessName, ...profile } = {
            category: 'FOOD_BEVERAGE',
            businessName: `Discovery Test Business ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...overrides,
        };
        const owner = await seedUser(prisma);
        const biz = await prisma.businessProfile.create({
            data: {
                userId: owner.id,
                businessName,
                bizId: `BIZ-DISC-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                ...profile,
            },
        });
        return { owner, biz };
    };

    // ── B-1: paused businesses are not discoverable in public search ─────────

    test('B-1: searchBusinesses excludes owner-paused businesses', async () => {
        const active = await seedEligibleBusiness({ businessName: 'Eligible Kitchen' });
        const paused = await seedEligibleBusiness({
            businessName: 'Paused Kitchen',
            isPausedByOwner: true,
        });
        const suspended = await seedEligibleBusiness({
            businessName: 'Suspended Kitchen',
            isSuspended: true,
        });
        expect(paused.biz.isPausedByOwner).toBe(true);
        expect(suspended.biz.isSuspended).toBe(true);

        const { searchBusinesses } = require('../services/businessService');
        const rows = await searchBusinesses(prisma, { query: 'Kitchen', limit: 50 });

        const ids = rows.map((r) => r.id);
        expect(ids).toContain(active.biz.id);
        expect(ids).not.toContain(paused.biz.id);
        expect(ids).not.toContain(suspended.biz.id);
    });

    test('B-1: unpausing restores discoverability', async () => {
        const biz = await seedEligibleBusiness({
            businessName: 'Reopened Kitchen',
            isPausedByOwner: true,
        });

        const { searchBusinesses } = require('../services/businessService');
        let rows = await searchBusinesses(prisma, { query: 'Reopened Kitchen', limit: 50 });
        expect(rows.map((r) => r.id)).not.toContain(biz.biz.id);

        await prisma.businessProfile.update({
            where: { id: biz.biz.id },
            data: { isPausedByOwner: false },
        });
        rows = await searchBusinesses(prisma, { query: 'Reopened Kitchen', limit: 50 });
        expect(rows.map((r) => r.id)).toContain(biz.biz.id);
    });
});
