const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[finance-profit-liquidation-audit-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('profit liquidation audit atomicity (real PostgreSQL)', () => {
    let prisma, financeService, adminId;
    let fiatLiquidityActivation;
    let priorSettingsMode = null;
    let priorLatch;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        financeService = require('../services/finance.service');
        fiatLiquidityActivation = require('../src/services/fiatLiquidityActivationService');
        const admin = await prisma.user.create({
            data: { username: `liq_admin_${Date.now()}`, email: `liq_admin_${Date.now()}@test.local`, password: 'test_password', role: 'ADMIN' }
        });
        adminId = admin.id;

        // §P.5-D FIXTURE ISOLATION. This suite asserts LEGACY USDC liquidation
        // arithmetic (the pool is incremented by the liquidated amount), but it
        // never established the regime: the effective mode is (Boolean OR latch),
        // so a latch left behind by an earlier suite silently turned every
        // liquidation into a treasury opening that does not touch the pool.
        // Capture what we found so the shared singleton can be put back exactly.
        priorSettingsMode = await prisma.globalSettings.findUnique({
            where: { id: 1 }, select: { fiatLiquidityAuthorityEnabled: true },
        });
        const priorState = await prisma.fiatLiquidityState.findUnique({
            where: { id: 1 }, select: { authorityActivatedAt: true },
        });
        priorLatch = priorState ? priorState.authorityActivatedAt : undefined; // undefined = row absent
    });

    beforeEach(async () => {
        await prisma.auditLog.deleteMany();
        await prisma.adminProfitLog.deleteMany();
        await prisma.systemProfitFees.deleteMany();
        await prisma.systemFiatPool.deleteMany();
        await prisma.systemProfitFees.create({ data: { id: 1, balance: 100 } });
        await prisma.systemFiatPool.create({ data: { id: 1, balance: 10 } });

        // Explicit LEGACY USDC mode: Boolean false AND no latch. Both components
        // are set, because the regime is their OR — clearing only one leaves the
        // suite dependent on whatever ran before it.
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: false },
            create: { id: 1, fiatLiquidityAuthorityEnabled: false },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { authorityActivatedAt: null },
            create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, updatedAt: new Date() },
        });

        // Prove it through the production reader rather than assuming the writes
        // did what they look like they do.
        const mode = await fiatLiquidityActivation.readMode(prisma);
        expect(mode.active).toBe(false);
        expect(mode.flagged).toBe(false);
        expect(mode.latched).toBe(false);
        expect(mode.authorityUnit).toBe('USDC');
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

            // Put the shared mode back exactly as found. Only the two fields this
            // suite touched are restored; unrelated GlobalSettings values and the
            // rest of the liquidity state are left alone.
            if (priorSettingsMode) {
                await prisma.globalSettings.update({
                    where: { id: 1 },
                    data: { fiatLiquidityAuthorityEnabled: priorSettingsMode.fiatLiquidityAuthorityEnabled === true },
                }).catch(() => {});
            }
            if (priorLatch === undefined) {
                // The row did not exist before this suite; remove only what we made.
                await prisma.fiatLiquidityState.deleteMany({ where: { id: 1 } }).catch(() => {});
            } else {
                await prisma.fiatLiquidityState.update({
                    where: { id: 1 }, data: { authorityActivatedAt: priorLatch },
                }).catch(() => {});
            }

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
