/**
 * BusinessOrder money representation — the enforcement that travels in code.
 *
 * The database constraints in prisma/sql/ only exist where that SQL has been
 * applied; production's `prisma db push` creates none. These tests therefore
 * cover the layer that protects production, plus a real-Postgres round trip so
 * the reader is proven against actual Prisma Decimals rather than stand-ins.
 */
const c = require('../src/lib/businessOrderCurrency');
const { CODES, parseGhsAmount, readOrderAmount } = c;

describe('parseGhsAmount — exact cedis from the wire', () => {
    test.each([
        ['1500', '1500.00'],
        ['1500.5', '1500.50'],
        ['0', '0.00'],
        ['0.00', '0.00'],
        ['007.5', '7.50'],
        ['  25.00  ', '25.00'],
        ['999999999999.99', '999999999999.99'],
    ])('%p canonicalises to %p', (raw, expected) => {
        expect(parseGhsAmount(raw)).toBe(expected);
    });

    test.each([
        ['25.005', CODES.SUB_PESEWA, 'sub-pesewa must be refused, never rounded'],
        ['-1.00', CODES.NEGATIVE, 'negative'],
        ['1e3', CODES.MALFORMED, 'exponent'],
        ['1,500.00', CODES.MALFORMED, 'thousands separator'],
        ['GHS 25.00', CODES.MALFORMED, 'currency symbol'],
        ['25 .00', CODES.MALFORMED, 'inner space'],
        ['', CODES.MALFORMED, 'empty'],
    ])('refuses %p with %p (%s)', (raw, code) => {
        expect(() => parseGhsAmount(raw)).toThrow(expect.objectContaining({ code }));
    });

    test('a JS number is refused outright, because exactness may already be gone', () => {
        expect(() => parseGhsAmount(25)).toThrow(expect.objectContaining({ code: CODES.NOT_A_STRING }));
        expect(() => parseGhsAmount(0.1 + 0.2)).toThrow(expect.objectContaining({ code: CODES.NOT_A_STRING }));
    });

    test('zero can be forbidden for operations that must move value', () => {
        expect(() => parseGhsAmount('0.00', { allowZero: false }))
            .toThrow(expect.objectContaining({ code: CODES.ZERO }));
    });
});

describe('readOrderAmount — one interpretation, no guessing', () => {
    const dec = (dp, text) => ({ toFixed: () => text, dp });

    test('a legacy untagged row is USDC by history, and says so', () => {
        const r = readOrderAmount({ id: 'o1', currency: null, amountUsdc: dec(8, '3.00000000'), amountGhs: null });
        expect(r).toEqual({ currency: 'USDC', amount: '3.00000000', legacy: true });
    });

    test('a native GHS order reads as exact cedis and never as dollars', () => {
        const r = readOrderAmount({ id: 'o2', currency: 'GHS', amountUsdc: null, amountGhs: dec(2, '25.00') });
        expect(r).toEqual({ currency: 'GHS', amount: '25.00', legacy: false });
    });

    test('a corrupt row carrying both amounts is refused, not resolved by preference', () => {
        expect(() => readOrderAmount({ id: 'o3', currency: 'GHS', amountUsdc: '1', amountGhs: '2' }))
            .toThrow(expect.objectContaining({ code: CODES.CORRUPT }));
        expect(() => readOrderAmount({ id: 'o4', currency: null, amountUsdc: '1', amountGhs: '2' }))
            .toThrow(expect.objectContaining({ code: CODES.CORRUPT }));
    });

    test('a row with no amount is refused: it would vanish from every total', () => {
        expect(() => readOrderAmount({ id: 'o5', currency: null, amountUsdc: null, amountGhs: null }))
            .toThrow(expect.objectContaining({ code: CODES.CORRUPT }));
    });

    test('a currency tag or amount mismatch is refused rather than coerced', () => {
        expect(() => readOrderAmount({ id: 'o6', currency: 'GHS', amountUsdc: '5', amountGhs: null }))
            .toThrow(expect.objectContaining({ code: CODES.CORRUPT }));
        expect(() => readOrderAmount({ id: 'o7', currency: 'USDC', amountUsdc: null, amountGhs: '5.00' }))
            .toThrow(expect.objectContaining({ code: CODES.CORRUPT }));
    });

    test('an unsupported currency is refused', () => {
        expect(() => readOrderAmount({ id: 'o8', currency: 'EUR', amountUsdc: '1', amountGhs: null }))
            .toThrow(expect.objectContaining({ code: CODES.UNKNOWN }));
    });
});

// ── Real PostgreSQL round trip ───────────────────────────────────────────────
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeDb = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[order-currency] TEST_DATABASE_URL not set — DB round trip skipped.');

describeDb('readOrderAmount against real Prisma Decimals', () => {
    let prisma; let userId; let profileId;
    const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `oc_${u}`, email: `oc_${u}@test.local`, password: 'x' },
        });
        userId = user.id;
        const profile = await prisma.businessProfile.create({
            data: { userId, bizId: `BIZ${u.slice(-8)}`, businessName: 'Currency Test' },
        });
        profileId = profile.id;
    }, 30000);

    afterAll(async () => {
        if (prisma) {
            await prisma.businessOrder.deleteMany({ where: { businessProfileId: profileId } }).catch(() => {});
            await prisma.$disconnect();
        }
    });

    const make = (over) => prisma.businessOrder.create({
        data: {
            businessProfileId: profileId,
            customerId: userId,
            orderRef: `REF${uniq()}`,
            title: 't',
            ...over,
        },
    });

    test('a stored GHS order reads back as exact cedis at 2dp', async () => {
        const row = await make({ currency: 'GHS', amountGhs: '25.00', amountUsdc: null });
        const r = readOrderAmount(row);
        expect(r).toEqual({ currency: 'GHS', amount: '25.00', legacy: false });
        expect(r.amount).toBe('25.00');
    });

    test('a legacy row created without a currency reads as USDC and is marked legacy', async () => {
        const row = await make({ amountUsdc: '3.00000000' });
        const r = readOrderAmount(row);
        expect(r.currency).toBe('USDC');
        expect(r.legacy).toBe(true);
        expect(r.amount).toBe('3.00000000');
    });

    test('the two representations never collapse into one number', async () => {
        const ghs = readOrderAmount(await make({ currency: 'GHS', amountGhs: '25.00', amountUsdc: null }));
        const usdc = readOrderAmount(await make({ currency: 'USDC', amountUsdc: '25.00000000', amountGhs: null }));
        expect(ghs.amount).toBe('25.00');
        expect(usdc.amount).toBe('25.00000000');
        expect(ghs.currency).not.toBe(usdc.currency);
    });
});
