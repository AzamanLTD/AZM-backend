// =============================================================================
// Fee Lab (services/feeLabService.js, src/lib/feeLabCatalog.js).
//
// In-memory Prisma (helpers/transitPrismaFake tables):
//   • live values come from where the app reads them: GlobalSettings
//     fractions (bps), entries of its JSON maps, the published fee-refund
//     policy (or its default); modelled points show their model default
//   • the portal never sees SQL or internals
//   • publish writes the targets in one transaction with both audit trails,
//     and the published refund policy is what refunds then use
//   • unknown, duplicate, modelled-only, out-of-bounds and stale changes are
//     refused with nothing written
//   • the overview aggregates volumes per bucket and per segment
// Real PostgreSQL (every volume query runs, exact writes) is fee-lab.pg.test.js.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { Prisma } = require('@prisma/client');
const { table } = require('./helpers/transitPrismaFake');
const feeLab = require('../services/feeLabService');
const catalog = require('../src/lib/feeLabCatalog');
const { publishedFeeRefund, refundsFeeNow, REFUND_CAUSE } = require('../services/feeRefundPolicy');

const NOW = new Date('2026-11-28T12:00:00Z');

function makeDb() {
    const revisions = table([]);
    const sorted = revisions.findMany;
    revisions.findMany = jest.fn(async (args) => (await sorted(args)).slice().sort((a, b) => (
        b.effectiveAt - a.effectiveAt || b.createdAt - a.createdAt
    )));
    const db = {
        globalSettings: table([{
            id: 1,
            smartEscrowFeePct: new Prisma.Decimal('0.005'),
            businessInvoiceFeePct: new Prisma.Decimal('0.015'),
            p2pFeePct: new Prisma.Decimal('0.02'),
            susuProfitPct: new Prisma.Decimal('0.03'),
            withdrawalFeeByRiskTier: { STANDARD: 0.02, TRUSTED: 0.005, HIGH_RISK: 0.05 },
            feeByPaymentMethod: { ZELLE: 0.02, PAYPAL: 0.04 },
            liveUsdToGhs: new Prisma.Decimal('15'),
        }]),
        adminMoneySettingRevision: revisions,
        adminSettingsAuditLog: table([]),
        auditLog: table([]),
        adminProfitLog: { groupBy: jest.fn(async () => [{ source: 'SMART_ESCROW_FEE', _sum: { amountUsdc: new Prisma.Decimal('12.5') }, _count: { _all: 25 } }]) },
        $executeRaw: jest.fn(async () => 1),
        $queryRaw: jest.fn(async () => []),
    };
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}
const param = (cat, key) => cat.flatMap((p) => p.params).find((x) => x.key === key);

describe('live values', () => {
    test('from where the app reads them, in the catalog units', async () => {
        const cat = await feeLab.readCatalog(makeDb(), { now: NOW });
        expect(param(cat, 'fee.escrow.pct')).toEqual(expect.objectContaining({ live: 50, unit: 'bps', publishable: true, writesTo: 'GlobalSettings.smartEscrowFeePct' }));
        expect(param(cat, 'fee.invoice.pct').live).toBe(150);
        expect(param(cat, 'fee.susu.pct').live).toBe(300);
        expect(param(cat, 'fee.withdrawMomo.TRUSTED')).toEqual(expect.objectContaining({ live: 50, segment: 'TRUSTED', writesTo: 'GlobalSettings.withdrawalFeeByRiskTier.TRUSTED' }));
        expect(param(cat, 'fee.p2p.PAYPAL').live).toBe(400);
        expect(param(cat, 'fee.p2p.VENMO').live).toBe(null); // not in the stored map
        expect(param(cat, 'fee.p2p.default').live).toBe(200);
        // Refund rules: the defaults until one is published.
        expect(param(cat, 'feeRefund.BUSINESS_CANCELLED').live).toBe('REFUND');
        expect(param(cat, 'feeRefund.CUSTOMER_CANCELLED').live).toBe('KEEP');
        // Modelled points: their model default, never publishable.
        expect(param(cat, 'fee.transfer.pct')).toEqual(expect.objectContaining({ live: 0, publishable: false, writesTo: null }));
        expect(param(cat, 'fee.walletPlatform.pct').notPublishableReason).toMatch(/break these withdrawals/);
        expect(param(cat, 'fee.p2p.azamanShare')).toEqual(expect.objectContaining({ live: 6000, role: 'share', publishable: false }));
    });

    test('the portal never sees SQL or internals', async () => {
        const cat = await feeLab.readCatalog(makeDb(), { now: NOW });
        const text = JSON.stringify(cat);
        expect(text).not.toMatch(/SELECT|FROM "|"target"|"sql"/);
        expect(cat.find((p) => p.id === 'p2p.fee').hasVolume).toBe(true);
    });
});

describe('publishing', () => {
    const publish = (db, changes, extra = {}) => feeLab.publish(db, {
        changes, reason: 'Pricing review for the board', adminId: 7, adminName: 'finance', now: NOW, ...extra,
    });

    test('writes every target in one transaction, with both audit trails', async () => {
        const db = makeDb();
        const out = await publish(db, [
            { key: 'fee.escrow.pct', from: 50, to: 75 },
            { key: 'fee.withdrawMomo.STANDARD', from: 200, to: 150 },
            { key: 'fee.p2p.VENMO', from: null, to: 250 },
            { key: 'feeRefund.CUSTOMER_CANCELLED', from: 'KEEP', to: 'REFUND' },
        ]);
        const gsRow = db.globalSettings.rows[0];
        expect(gsRow.smartEscrowFeePct.toString()).toBe('0.0075');
        // The JSON map keeps its other entries.
        expect(gsRow.withdrawalFeeByRiskTier).toEqual({ STANDARD: 0.015, TRUSTED: 0.005, HIGH_RISK: 0.05 });
        expect(gsRow.feeByPaymentMethod).toEqual({ ZELLE: 0.02, PAYPAL: 0.04, VENMO: 0.025 });
        expect(db.adminMoneySettingRevision.rows).toEqual([expect.objectContaining({
            key: 'feeRefund.CUSTOMER_CANCELLED', kind: 'enum', valueEnum: 'REFUND', adminId: 7, reason: 'Pricing review for the board',
        })]);
        expect(db.$executeRaw).toHaveBeenCalled(); // the settings row lock
        expect(db.adminSettingsAuditLog.rows).toHaveLength(1);
        expect(db.adminSettingsAuditLog.rows[0]).toEqual(expect.objectContaining({ action: 'UPDATE_SETTINGS', targetType: 'FEE_LAB', targetId: out.publishId }));
        expect(db.adminSettingsAuditLog.rows[0].changes.items).toHaveLength(4);
        expect(db.auditLog.rows[0]).toEqual(expect.objectContaining({ action: 'PUBLISH_FEES', actorId: 7, targetId: out.publishId }));
        expect(out.published).toEqual([
            { key: 'fee.escrow.pct', from: 50, to: 75 },
            { key: 'fee.withdrawMomo.STANDARD', from: 200, to: 150 },
            { key: 'fee.p2p.VENMO', from: null, to: 250 },
            { key: 'feeRefund.CUSTOMER_CANCELLED', from: 'KEEP', to: 'REFUND' },
        ]);
        expect(param(out.catalog, 'fee.escrow.pct').live).toBe(75);
        expect(param(out.catalog, 'feeRefund.CUSTOMER_CANCELLED').live).toBe('REFUND');
    });

    test('a published refund rule is what refunds then use', async () => {
        const db = makeDb();
        expect(await publishedFeeRefund(db, NOW)).toBe(null);
        expect(await refundsFeeNow(db, REFUND_CAUSE.BUSINESS_CANCELLED, NOW)).toBe(true);
        await publish(db, [{ key: 'feeRefund.BUSINESS_CANCELLED', from: 'REFUND', to: 'KEEP' }]);
        expect(await publishedFeeRefund(db, NOW)).toEqual({ BUSINESS_CANCELLED: false });
        expect(await refundsFeeNow(db, REFUND_CAUSE.BUSINESS_CANCELLED, NOW)).toBe(false);
        expect(await refundsFeeNow(db, REFUND_CAUSE.CUSTOMER_CANCELLED, NOW)).toBe(false); // still the default
        // The newest one in effect wins; a future one does not apply yet.
        db.adminMoneySettingRevision.rows.push({ key: 'feeRefund.BUSINESS_CANCELLED', valueEnum: 'REFUND', effectiveAt: new Date(NOW.getTime() + 60000), createdAt: NOW });
        expect(await refundsFeeNow(db, REFUND_CAUSE.BUSINESS_CANCELLED, NOW)).toBe(false);
    });

    test.each([
        ['an unknown key', [{ key: 'fee.nope', from: 0, to: 1 }], 'FEE_LAB_UNKNOWN_KEY'],
        ['the same key twice', [{ key: 'fee.escrow.pct', from: 50, to: 60 }, { key: 'fee.escrow.pct', from: 50, to: 70 }], 'FEE_LAB_DUPLICATE_KEY'],
        ['a fee the app does not charge', [{ key: 'fee.transfer.pct', from: 0, to: 50 }], 'FEE_NOT_PUBLISHABLE'],
        ['a fee that would break withdrawals', [{ key: 'fee.walletPlatform.pct', from: 0, to: 50 }], 'FEE_NOT_PUBLISHABLE'],
        ['above the bound', [{ key: 'fee.escrow.pct', from: 50, to: 1001 }], 'FEE_LAB_OUT_OF_BOUNDS'],
        ['not whole basis points', [{ key: 'fee.escrow.pct', from: 50, to: 7.5 }], 'FEE_LAB_OUT_OF_BOUNDS'],
        ['not a policy', [{ key: 'feeRefund.NO_SHOW', from: 'KEEP', to: 'MAYBE' }], 'FEE_LAB_OUT_OF_BOUNDS'],
        ['nothing', [], 'FEE_LAB_NOTHING_TO_PUBLISH'],
        ['changed by someone else meanwhile', [{ key: 'fee.escrow.pct', from: 40, to: 75 }], 'FEE_CHANGED_MEANWHILE'],
    ])('refuses %s, writing nothing', async (_label, changes, code) => {
        const db = makeDb();
        await expect(publish(db, changes)).rejects.toMatchObject({ code });
        expect(db.globalSettings.rows[0].smartEscrowFeePct.toString()).toBe('0.005');
        expect(db.adminSettingsAuditLog.rows).toHaveLength(0);
        expect(db.auditLog.rows).toHaveLength(0);
        expect(db.adminMoneySettingRevision.rows).toHaveLength(0);
    });

    test('a reason and an admin are required', async () => {
        await expect(publish(makeDb(), [{ key: 'fee.escrow.pct', from: 50, to: 75 }], { reason: 'no' })).rejects.toMatchObject({ code: 'FEE_LAB_REASON_REQUIRED' });
        await expect(publish(makeDb(), [{ key: 'fee.escrow.pct', from: 50, to: 75 }], { adminId: undefined })).rejects.toMatchObject({ code: 'FEE_LAB_ACTOR_REQUIRED' });
    });

    test('the stale check names what changed', async () => {
        const err = await publish(makeDb(), [{ key: 'fee.escrow.pct', from: 40, to: 75 }]).catch((e) => e);
        expect(err.httpStatus).toBe(409);
        expect(err.detail).toEqual({ stale: [{ key: 'fee.escrow.pct', from: 40, live: 50 }] });
    });

    test('an audit failure aborts the publish', async () => {
        const db = makeDb();
        db.auditLog.create = jest.fn(async () => { throw new Error('audit down'); });
        await expect(publish(db, [{ key: 'fee.escrow.pct', from: 50, to: 75 }])).rejects.toThrow('audit down');
    });
});

describe('overview', () => {
    test('booked revenue, volumes per bucket and per segment', async () => {
        const db = makeDb();
        db.$queryRaw = jest.fn(async (strings, ...values) => {
            const inner = values.find((v) => v && typeof v.sql === 'string' && v.sql.includes('FROM'));
            if (inner && inner.sql.includes('"Trade"')) {
                return [
                    { seg: 'ZELLE', b: 5, n: 2, v: '120' },
                    { seg: 'PAYPAL', b: 5, n: 1, v: '80' },
                    { seg: 'PAYPAL', b: 7, n: 1, v: '300' },
                ];
            }
            if (inner && inner.sql.includes('"SmartEscrow"') && inner.sql.includes('"fundedAt"')) {
                return [{ seg: null, b: 3, n: 10, v: '150' }];
            }
            return [];
        });
        const out = await feeLab.getOverview(db, { period: '30d', now: NOW });
        expect(out.periodDays).toBe(30);
        expect(out.actuals).toEqual({ SMART_ESCROW_FEE: { revenueUsdc: 12.5, count: 25 } });
        expect(out.volumes['escrow.fee']).toEqual({ count: 10, volumeUsdc: 150, buckets: [{ bucket: 3, upToUsdc: 25, count: 10, volumeUsdc: 150 }] });
        expect(out.volumes['p2p.fee'].count).toBe(4);
        expect(out.volumes['p2p.fee'].volumeUsdc).toBe(500);
        expect(out.volumes['p2p.fee'].buckets).toEqual([
            { bucket: 5, upToUsdc: 100, count: 3, volumeUsdc: 200 },
            { bucket: 7, upToUsdc: 500, count: 1, volumeUsdc: 300 },
        ]);
        expect(out.volumes['p2p.fee'].segments.PAYPAL).toEqual({
            count: 2, volumeUsdc: 380,
            buckets: [{ bucket: 5, upToUsdc: 100, count: 1, volumeUsdc: 80 }, { bucket: 7, upToUsdc: 500, count: 1, volumeUsdc: 300 }],
        });
        expect(out.usdToGhs).toBe(15);
        expect(out.flows.map((f) => f.id)).toContain('MARKETPLACE');
    });

    test('one unreadable source is reported, not fatal', async () => {
        const db = makeDb();
        db.$queryRaw = jest.fn(async () => { throw new Error('relation does not exist'); });
        const out = await feeLab.getOverview(db, { period: '7d', now: NOW });
        expect(out.volumeErrors['escrow.fee']).toBe('Volume unavailable');
        expect(out.catalog.length).toBe(catalog.FEE_POINTS.length);
    });

    test('an unknown period is refused', async () => {
        await expect(feeLab.getOverview(makeDb(), { period: '1y', now: NOW })).rejects.toMatchObject({ code: 'FEE_LAB_PERIOD_INVALID' });
    });

    test('every point names a known flow and, if any, a known volume source', () => {
        const flows = new Set(catalog.FLOWS.map((f) => f.id));
        for (const p of catalog.FEE_POINTS) {
            expect(flows.has(p.flow)).toBe(true);
            if (p.volume) expect(catalog.VOLUME_SOURCES[p.volume]).toBeDefined();
        }
    });
});

describe('routes', () => {
    test('viewing needs fees.manage; publishing also needs a second factor', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/adminRoutes.js'), 'utf-8');
        expect(src).toContain("router.get('/fee-lab',          requireEffectivePermission('fees.manage'), adminFeeLabController.getOverview);");
        expect(src).toContain("router.post('/fee-lab/publish', requireEffectivePermission('fees.manage'), require2FA(), adminFeeLabController.publish);");
        // Admin routes all sit behind protect + adminOnly.
        expect(src.indexOf('router.use(adminOnly);')).toBeLessThan(src.indexOf("router.get('/fee-lab'"));
    });
});
