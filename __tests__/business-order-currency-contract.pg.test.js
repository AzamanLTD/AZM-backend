/**
 * BusinessOrder currency contract — enforced by the DATABASE, not by courtesy.
 *
 * The service layer will also validate, but a service check only protects callers
 * that go through that service. These tests bypass every service and talk to the
 * table, because the invariant that matters is "no row can be read as both GHS and
 * USDC", and that has to survive any future writer.
 */
const fs = require('fs');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[order-currency] TEST_DATABASE_URL not set — skipping.');

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', '2026-11-15-business-order-currency-contract.sql');

describeOrSkip('BusinessOrder currency contract (real PostgreSQL)', () => {
    let prisma;
    let businessProfileId;
    let customerId;
    let seq = 0;

    const applyContractSql = async () => {
        const raw = fs.readFileSync(SQL_FILE, 'utf8');
        // Strip comment lines FIRST: a comment may legitimately contain a
        // semicolon, and splitting before stripping produced
        // "unterminated quoted string". Comments are never SQL.
        const withoutComments = raw
            .split('\n')
            .filter((l) => !l.trim().startsWith('--'))
            .join('\n');
        const statements = withoutComments.split(';').map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
        return statements.length;
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        const u = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const user = await prisma.user.create({
            data: { username: `cur_${u}`, email: `cur_${u}@test.local`, password: 'x' },
        });
        customerId = user.id;
        const biz = await prisma.businessProfile.create({
            data: { userId: customerId, bizId: `BIZ${u}`.slice(0, 20), businessName: 'Currency Contract Test' },
        });
        businessProfileId = biz.id;
    }, 30000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
        await applyContractSql();
        await prisma.businessOrder.deleteMany({ where: { businessProfileId } });
    }, 20000);

    const order = (over = {}) => ({
        businessProfileId,
        customerId,
        orderRef: `REF-${Date.now()}-${seq += 1}`,
        title: 'Currency contract probe',
        ...over,
    });

    test('the contract SQL is re-runnable (idempotent), so a deploy can retry it', async () => {
        const first = await applyContractSql();
        const second = await applyContractSql();
        expect(second).toBe(first);
        expect(first).toBeGreaterThan(4);
    });

    test('a legacy row keeps its historical USDC meaning with no currency tag', async () => {
        const created = await prisma.businessOrder.create({ data: order({ amountUsdc: '12.50000000' }) });
        expect(created.currency).toBeNull();
        expect(created.amountGhs).toBeNull();
        expect(created.amountUsdc.toFixed(8)).toBe('12.50000000');
    });

    test('an explicit USDC order is accepted and tagged', async () => {
        const created = await prisma.businessOrder.create({ data: order({ currency: 'USDC', amountUsdc: '3.00000000' }) });
        expect(created.currency).toBe('USDC');
        expect(created.amountGhs).toBeNull();
    });

    test('a native GHS order stores exact 2dp cedis and NO USDC amount at all', async () => {
        const created = await prisma.businessOrder.create({
            data: order({ currency: 'GHS', amountGhs: '25.00', amountUsdc: null }),
        });
        expect(created.currency).toBe('GHS');
        expect(created.amountUsdc).toBeNull();          // never a fabricated 0
        expect(created.amountGhs.toFixed(2)).toBe('25.00');
    });

    test('a row cannot carry BOTH a GHS and a USDC amount', async () => {
        await expect(prisma.businessOrder.create({
            data: order({ currency: 'GHS', amountGhs: '25.00', amountUsdc: '2.00000000' }),
        })).rejects.toThrow();
        expect(await prisma.businessOrder.count({ where: { businessProfileId } })).toBe(0);
    });

    test('a GHS-tagged row without a GHS amount is refused', async () => {
        await expect(prisma.businessOrder.create({
            data: order({ currency: 'GHS', amountGhs: null, amountUsdc: '1.00000000' }),
        })).rejects.toThrow();
    });

    test('an unsupported currency is refused', async () => {
        await expect(prisma.businessOrder.create({
            data: order({ currency: 'EUR', amountUsdc: '1.00000000' }),
        })).rejects.toThrow();
    });

    test('an order carrying neither amount is refused (it would vanish from every total)', async () => {
        await expect(prisma.businessOrder.create({
            data: order({ currency: null, amountUsdc: null, amountGhs: null }),
        })).rejects.toThrow();
    });

    test('the DATABASE cannot refuse sub-pesewa precision — recorded so no one assumes it does', async () => {
        // Measured, not assumed: Postgres coerces to the column scale BEFORE any
        // CHECK evaluates, so '25.005' reaches the row as 25.01. A
        // round(amountGhs,2) CHECK passes trivially and is therefore not shipped.
        // This test pins the real behaviour and the real consequence: refusing
        // sub-pesewa input must happen in the service, on the decimal STRING,
        // before Postgres sees it.
        const created = await prisma.businessOrder.create({
            data: order({ currency: 'GHS', amountGhs: '25.005' }),
        });
        expect(created.amountGhs.toFixed(2)).toBe('25.01'); // silently rounded by the type
        await prisma.businessOrder.delete({ where: { id: created.id } });
    });
});
