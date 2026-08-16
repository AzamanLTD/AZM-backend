// __tests__/card-skin-and-ad-color.test.js
// =============================================================================
// Unit tests for the 2026-07-06 features:
//   A. AzmSpendService.purchaseCardSkin / equipCardSkin / getCardSkinCatalog
//   B. businessService.updateBusinessProfile — adAccentColor validation
//
// These run WITHOUT a live database — prisma is a lightweight in-memory fake
// that mimics the exact calls each function makes (findUnique/update/create,
// $transaction runs the callback against the same fake). This exercises the
// real business logic (insufficient-balance guard, idempotent re-purchase,
// ownership-gated equip, invalid-skin rejection, hex color validation)
// deterministically and fast, unlike the TEST_DATABASE_URL-gated integration
// tests elsewhere in this suite.
// =============================================================================

const { AzmSpendService, CARD_SKIN_OPTIONS, FREE_CARD_SKIN } = require('../services/azmSpendService');
const businessService = require('../services/businessService');

// ── Minimal in-memory fake Prisma ────────────────────────────────────────────
function makeFakePrisma(initialUser) {
    let user = { ...initialUser };
    const spendLogs = [];

    const userClient = {
        findUnique: async ({ select }) => {
            if (!select) return { ...user };
            const out = {};
            for (const k of Object.keys(select)) out[k] = user[k];
            return out;
        },
        update: async ({ data, select }) => {
            if (data.azmBalance && data.azmBalance.decrement !== undefined) {
                user.azmBalance = Number(user.azmBalance) - data.azmBalance.decrement;
            }
            for (const [k, v] of Object.entries(data)) {
                if (k === 'azmBalance') continue;
                user[k] = v;
            }
            if (!select) return { ...user };
            const out = {};
            for (const k of Object.keys(select)) out[k] = user[k];
            return out;
        }
    };

    const prisma = {
        user: userClient,
        azmSpendLog: {
            create: async ({ data }) => {
                const row = { id: `log_${spendLogs.length + 1}`, ...data };
                spendLogs.push(row);
                return row;
            }
        },
        $transaction: async (fn) => fn(prisma),
        _debug: { getUser: () => user, getSpendLogs: () => spendLogs }
    };
    return prisma;
}

describe('AzmSpendService — card skins', () => {
    test('CARD_SKIN_OPTIONS never includes the free classic skin', () => {
        expect(CARD_SKIN_OPTIONS.some(s => s.id === FREE_CARD_SKIN)).toBe(false);
        expect(CARD_SKIN_OPTIONS.length).toBeGreaterThan(0);
        for (const s of CARD_SKIN_OPTIONS) {
            expect(s.cost).toBeGreaterThan(0);
        }
    });

    test('purchaseCardSkin: debits AZM and adds to ownedCardSkins', async () => {
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);

        const skin = CARD_SKIN_OPTIONS[0]; // gold, cost 20
        const result = await svc.purchaseCardSkin(1, skin.id);

        expect(result.purchased).toBe(true);
        expect(result.ownedCardSkins).toContain(skin.id);
        expect(result.newBalance).toBe(100 - skin.cost);
        expect(prisma._debug.getSpendLogs()).toHaveLength(1);
        expect(prisma._debug.getSpendLogs()[0].source).toBe('CARD_SKIN');
    });

    test('purchaseCardSkin: insufficient balance throws and does NOT debit', async () => {
        const prisma = makeFakePrisma({ id: 1, azmBalance: 0.5, ownedCardSkins: [], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);

        const skin = CARD_SKIN_OPTIONS[0];
        await expect(svc.purchaseCardSkin(1, skin.id)).rejects.toThrow(/Insufficient AZM/);
        expect(prisma._debug.getUser().azmBalance).toBe(0.5); // untouched
        expect(prisma._debug.getSpendLogs()).toHaveLength(0);
    });

    test('purchaseCardSkin: re-purchasing an owned skin is idempotent (no double charge)', async () => {
        const skin = CARD_SKIN_OPTIONS[0];
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [skin.id], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);

        const result = await svc.purchaseCardSkin(1, skin.id);
        expect(result.purchased).toBe(false);
        expect(result.newBalance).toBe(100); // unchanged
        expect(prisma._debug.getSpendLogs()).toHaveLength(0);
    });

    test('purchaseCardSkin: rejects an unknown skin id', async () => {
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);
        await expect(svc.purchaseCardSkin(1, 'not_a_real_skin')).rejects.toThrow(/Invalid card skin/);
    });

    test('equipCardSkin: classic is always equippable even with no purchases', async () => {
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);
        const result = await svc.equipCardSkin(1, FREE_CARD_SKIN);
        expect(result.equippedCardSkin).toBe(FREE_CARD_SKIN);
    });

    test('equipCardSkin: rejects equipping an unowned skin', async () => {
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);
        await expect(svc.equipCardSkin(1, CARD_SKIN_OPTIONS[0].id)).rejects.toThrow(/do not own/);
    });

    test('equipCardSkin: succeeds once the skin is owned', async () => {
        const skin = CARD_SKIN_OPTIONS[0];
        const prisma = makeFakePrisma({ id: 1, azmBalance: 100, ownedCardSkins: [skin.id], equippedCardSkin: FREE_CARD_SKIN });
        const svc = new AzmSpendService(prisma, null);
        const result = await svc.equipCardSkin(1, skin.id);
        expect(result.equippedCardSkin).toBe(skin.id);
        expect(prisma._debug.getUser().equippedCardSkin).toBe(skin.id);
    });

    test('getCardSkinCatalog: reports ownership and affordability per skin', async () => {
        const owned = CARD_SKIN_OPTIONS[0];
        const prisma = makeFakePrisma({
            id: 1,
            azmBalance: owned.cost, // can only afford the owned one, nothing else
            ownedCardSkins: [owned.id],
            equippedCardSkin: owned.id
        });
        const svc = new AzmSpendService(prisma, null);
        const catalog = await svc.getCardSkinCatalog(1);

        expect(catalog.equippedCardSkin).toBe(owned.id);
        const classicEntry = catalog.skins.find(s => s.id === FREE_CARD_SKIN);
        expect(classicEntry.owned).toBe(true);
        expect(classicEntry.cost).toBe(0);
        const ownedEntry = catalog.skins.find(s => s.id === owned.id);
        expect(ownedEntry.owned).toBe(true);
    });
});

// ── businessService — adAccentColor validation ───────────────────────────────
function makeFakeBusinessPrisma(initialProfile) {
    let profile = { ...initialProfile };
    return {
        businessProfile: {
            findUnique: async () => ({ ...profile }),
            findFirst: async () => ({ ...profile }),
            update: async ({ data }) => {
                profile = { ...profile, ...data };
                return { ...profile };
            }
        },
        _debug: { getProfile: () => profile }
    };
}

describe('businessService.updateBusinessProfile — adAccentColor', () => {
    test('accepts a valid 6-digit hex color', async () => {
        const prisma = makeFakeBusinessPrisma({ userId: 1, businessName: 'Test Biz', adAccentColor: null });
        const updated = await businessService.updateBusinessProfile(prisma, {
            userId: 1,
            updates: { adAccentColor: '#FFAA00' }
        });
        expect(updated.adAccentColor).toBe('#FFAA00');
    });

    test('rejects a malformed hex color', async () => {
        const prisma = makeFakeBusinessPrisma({ userId: 1, businessName: 'Test Biz', adAccentColor: null });
        await expect(businessService.updateBusinessProfile(prisma, {
            userId: 1,
            updates: { adAccentColor: 'not-a-color' }
        })).rejects.toThrow(/hex color/);
    });

    test('rejects a 3-digit shorthand hex (must be 6-digit)', async () => {
        const prisma = makeFakeBusinessPrisma({ userId: 1, businessName: 'Test Biz', adAccentColor: null });
        await expect(businessService.updateBusinessProfile(prisma, {
            userId: 1,
            updates: { adAccentColor: '#FA0' }
        })).rejects.toThrow(/hex color/);
    });

    test('empty string clears the override back to category-default tint', async () => {
        const prisma = makeFakeBusinessPrisma({ userId: 1, businessName: 'Test Biz', adAccentColor: '#FFAA00' });
        const updated = await businessService.updateBusinessProfile(prisma, {
            userId: 1,
            updates: { adAccentColor: '' }
        });
        expect(updated.adAccentColor).toBeNull();
    });

    test('unrelated whitelisted field still works alongside adAccentColor', async () => {
        const prisma = makeFakeBusinessPrisma({ userId: 1, businessName: 'Old Name', adAccentColor: null });
        const updated = await businessService.updateBusinessProfile(prisma, {
            userId: 1,
            updates: { businessName: 'New Name', adAccentColor: '#123ABC' }
        });
        expect(updated.businessName).toBe('New Name');
        expect(updated.adAccentColor).toBe('#123ABC');
    });
});
