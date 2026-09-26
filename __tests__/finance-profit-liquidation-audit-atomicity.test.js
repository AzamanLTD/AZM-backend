const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[finance-profit-liquidation-audit-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('profit liquidation audit atomicity (real PostgreSQL)', () => {
    let prisma, financeService, adminId;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        financeService = require('../services/finance.service');
        const admin = await prisma.user.create({
            data: { username: `liq_admin_${Date.now()}`, email: `liq_admin_${Date.now()}@test.local`, password: 'test_password', role: 'ADMIN' }
        });
        adminId = admin.id;
    });

    beforeEach(async () => {
        await prisma.auditLog.deleteMany();
        await prisma.adminProfitLog.deleteMany();
        await prisma.systemProfitFees.deleteMany();
        await prisma.systemFiatPool.deleteMany();
        await prisma.systemProfitFees.create({ data: { id: 1, balance: 100 } });
        await prisma.systemFiatPool.create({ data: { id: 1, balance: 10 } });
    });

    afterEach(async () => {
        await prisma.auditLog.deleteMany();
        await prisma.adminProfitLog.deleteMany();
        await prisma.systemProfitFees.deleteMany();
        await prisma.systemFiatPool.deleteMany();
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS _azm_fail_liquidation_audit ON \"AuditLog\"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS _azm_fail_liquidation_audit()');
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
            await prisma.user.delete({ where: { id: adminId } }).catch(() => {});
            await prisma.$disconnect();
        }
    });

    const balances = async () => {
        const [profit, fiat] = await Promise.all([
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }),
            prisma.systemFiatPool.findUnique({ where: { id: 1 } }),
        ]);
        return { profit: Number(profit.balance), fiat: Number(fiat.balance) };
    };

    const auditContext = {
        actorId: () => adminId,
        actorName: 'Liquidation Admin',
        ipAddress: '127.0.0.1',
    };

    test('successful liquidation commits exactly one financial log and one audit row', async () => {
        const result = await financeService.liquidateProfits(prisma, 25, adminId, {
            actorId: auditContext.actorId(), actorName: auditContext.actorName, ipAddress: auditContext.ipAddress
        });

        const state = await balances();
        expect(state.profit).toBeCloseTo(75, 6);
        expect(state.fiat).toBeCloseTo(35, 6);
        // r39: the service returns an EXACT Decimal.
        expect(result.amountLiquidated.toFixed(8)).toBe('25.00000000');

        const logs = await prisma.adminProfitLog.findMany({ where: { source: 'ARBITRAGE_SPREAD' } });
        const audits = await prisma.auditLog.findMany({ where: { action: 'LIQUIDATE_PROFITS', actorId: adminId } });
        expect(logs).toHaveLength(1);
        expect(Number(logs[0].amountUsdc)).toBeCloseTo(25, 6);
        expect(audits).toHaveLength(1);
        expect(audits[0].actorName).toBe('Liquidation Admin');
        expect(audits[0].targetType).toBe('SYSTEM');
        expect(audits[0].metadata).toEqual(expect.objectContaining({ amountUsdc: 25, amountLiquidated: 25, relatedTxId: logs[0].relatedTxId })); // r39: audit JSON round-trips the number
        expect(audits[0].ipAddress).toBe('127.0.0.1');
    });

    test('audit failure rolls back profit debit, fiat credit, and AdminProfitLog', async () => {
        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION _azm_fail_liquidation_audit() RETURNS trigger AS
            $$ BEGIN RAISE EXCEPTION 'forced liquidation audit failure'; END $$ LANGUAGE plpgsql;
        `);
        await prisma.$executeRawUnsafe(
            'CREATE TRIGGER _azm_fail_liquidation_audit BEFORE INSERT ON \"AuditLog\" FOR EACH ROW EXECUTE FUNCTION _azm_fail_liquidation_audit()'
        );

        await expect(financeService.liquidateProfits(prisma, 25, adminId, {
            actorId: adminId, actorName: auditContext.actorName, ipAddress: auditContext.ipAddress
        })).rejects.toThrow('forced liquidation audit failure');

        const state = await balances();
        expect(state.profit).toBeCloseTo(100, 6);
        expect(state.fiat).toBeCloseTo(10, 6);
        expect(await prisma.adminProfitLog.count()).toBe(0);
        expect(await prisma.auditLog.count({ where: { action: 'LIQUIDATE_PROFITS' } })).toBe(0);
    });

    test('concurrent liquidations are still one-winner and each committed liquidation has one audit', async () => {
        const call = () => financeService.liquidateProfits(prisma, 60, adminId, {
            actorId: adminId, actorName: auditContext.actorName, ipAddress: auditContext.ipAddress
        }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }));

        const outcomes = await Promise.all([call(), call()]);
        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok && o.error?.code === 'INSUFFICIENT_PROFIT_BALANCE')).toHaveLength(1);

        const state = await balances();
        expect(state.profit).toBeCloseTo(40, 6);
        expect(state.fiat).toBeCloseTo(70, 6);
        expect(await prisma.adminProfitLog.count({ where: { source: 'ARBITRAGE_SPREAD' } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { action: 'LIQUIDATE_PROFITS', actorId: adminId } })).toBe(1);
    });
});
