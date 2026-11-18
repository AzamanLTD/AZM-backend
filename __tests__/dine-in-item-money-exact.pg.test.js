'use strict';

/**
 * Dine-in item money must be Decimal arithmetic, never JS float arithmetic.
 *
 * The sell path used to write `authoritativePrice * qty` into a
 * Decimal(20,8) column, so three 0.10 items stored 0.30000000000000004 and
 * every total derived from the item inherited the error. `finalizeTab` had the
 * same shape (Number(unitPrice) * quantity). These cases pin exactness on a
 * real PostgreSQL so a float cannot creep back in unnoticed.
 */

const { PrismaClient } = require('@prisma/client');

const DineInService = require('../services/marketplace/dineInService');

const prisma = new PrismaClient();
const svc = new DineInService(prisma, null);

let userId;
let businessProfileId;
let productId;

const dec8 = (v) => (v == null ? null : Number(v).toFixed(8));

beforeAll(async () => {
    const user = await prisma.user.create({
        data: {
            username: `dinein-money-${Date.now()}`,
            email: `dinein-money-${Date.now()}@example.test`,
            password: 'x',
        },
    });
    userId = user.id;

    const profile = await prisma.businessProfile.create({
        data: { userId, bizId: `biz-${Date.now()}`, businessName: 'Cedi Kitchen' },
    });
    businessProfileId = profile.id;

    const product = await prisma.businessProduct.create({
        data: {
            businessProfileId,
            name: 'Kelewele',
            priceUsdc: '0.10000000',
            slug: `kelewele-${Date.now()}`,
        },
    });
    productId = product.id;
});

afterAll(async () => {
    const tabs = await prisma.dineInTab.findMany({ where: { businessProfileId }, select: { id: true } });
    await prisma.dineInTabItem.deleteMany({ where: { dineInTabId: { in: tabs.map((t) => t.id) } } });
    await prisma.dineInTab.deleteMany({ where: { businessProfileId } });
    await prisma.businessProduct.deleteMany({ where: { businessProfileId } });
    await prisma.businessProfile.delete({ where: { id: businessProfileId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
});

const openTab = async () => prisma.dineInTab.create({
    data: { businessProfileId, customerId: userId },
});

describe('dine-in item money is exact (real PostgreSQL)', () => {
    test('three 0.10 items are exactly 0.30, not 0.30000000000000004', async () => {
        const tab = await openTab();

        const item = await svc.addItem({
            tabId: tab.id,
            productId,
            quantity: 3,
            addedBy: userId,
        });

        expect(dec8(item.unitPriceUsdc)).toBe('0.10000000');
        // The float path produced 0.30000000000000004 here.
        expect(dec8(item.lineTotalUsdc)).toBe('0.30000000');
    });

    test('a caller-supplied price is stored exactly, unmultiplied by floats', async () => {
        const tab = await openTab();

        const item = await svc.addItem({
            tabId: tab.id,
            name: 'Waakye',
            price: '0.10000000',
            quantity: 7,
            addedBy: userId,
        });

        expect(dec8(item.lineTotalUsdc)).toBe('0.70000000');
    });

    test('finalize totals the durable line totals exactly, with no float re-multiplication', async () => {
        const tab = await openTab();
        await svc.addItem({ tabId: tab.id, productId, quantity: 3, addedBy: userId });
        await svc.addItem({ tabId: tab.id, name: 'Waakye', price: '0.10000000', quantity: 7, addedBy: userId });

        const finalized = await svc.finalizeTab(tab.id, businessProfileId);

        // 0.30 + 0.70 exactly, and equal to the sum of the stored line totals.
        expect(dec8(finalized.subtotalUsdc)).toBe('1.00000000');
        expect(dec8(finalized.grandTotalUsdc)).toBe('1.00000000');

        const stored = await prisma.dineInTabItem.findMany({ where: { dineInTabId: tab.id } });
        const summed = stored.reduce((s, i) => s + Number(i.lineTotalUsdc), 0);
        expect(dec8(summed)).toBe('1.00000000');
    });

    test('the quantity cap still refuses nonsense', async () => {
        const tab = await openTab();
        await expect(
            svc.addItem({ tabId: tab.id, productId, quantity: 51, addedBy: userId })
        ).rejects.toThrow(/quantity must be an integer from 1 to 50/);
    });
});
