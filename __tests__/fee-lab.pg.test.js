'use strict';

// =============================================================================
// FEE LAB (real PostgreSQL).
//   F1. Every volume query in the catalog runs; a paid stay shows up in the
//       escrow volume with its bucket.
//   F2. Publishing writes the exact values where the app reads them: the
//       escrow fee fraction (4 decimals), a JSON map entry with the others
//       kept, both audit trails; the next stay is priced with the new fee.
//   F3. A published refund rule is what a refund then uses: with "the
//       business cancels → keep", a hotel cancellation keeps the fee.
//   F4. A stale publish (someone changed the value) writes nothing.
// =============================================================================

const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('fee lab (PostgreSQL)', () => {
    let prisma;
    let feeLab;
    let stay;
    let lifecycle;
    const NOW = () => new Date();

    const truncate = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "User", "BusinessProfile", "HotelRoom", "Reservation", "Ticket", "SmartEscrow", '
        + '"SystemProfitFees", "AdminProfitLog", "FinancialOperation", "AdminMoneySettingRevision", '
        + '"AdminSettingsAuditLog", "AuditLog" RESTART IDENTITY CASCADE'
    );
    // The settings row is shared with other suites: reset the fields these
    // tests change to their schema defaults, never delete the row.
    const DEFAULTS = { smartEscrowFeePct: '0.005', withdrawalFeeByRiskTier: { STANDARD: 0.02, TRUSTED: 0.005, HIGH_RISK: 0.05 } };
    const settings = () => prisma.globalSettings.upsert({ where: { id: 1 }, update: DEFAULTS, create: { id: 1, ...DEFAULTS } });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        feeLab = require('../services/feeLabService');
        stay = require('../services/stayPaymentService');
        lifecycle = require('../services/reservationLifecycleService');
    });
    afterAll(async () => { await prisma.$disconnect(); });
    beforeEach(async () => { await truncate(); await settings(); }, 15000);
    afterEach(async () => { await truncate(); await settings(); }, 15000);

    const day = (offset) => {
        const n = new Date();
        return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offset)).toISOString().slice(0, 10);
    };
    async function seedHotel() {
        const { owner, biz } = await seedBusiness(prisma, { owner: { availableBalance: 0 } });
        await prisma.businessProfile.update({ where: { id: biz.id }, data: { category: 'HOSPITALITY' } });
        const room = await prisma.hotelRoom.create({
            data: { businessProfileId: biz.id, roomNumber: '101', roomType: 'DELUXE', capacity: 2, basePriceUsdc: 50, amenities: [], imageUrls: [] },
        });
        return { owner, biz, room };
    }
    const payStay = async (ctx, guest, key, inDay = 7, outDay = 9) => {
        const p = await stay.priceStay(prisma, { bizId: ctx.biz.bizId, roomId: ctx.room.id, checkInDate: day(inDay), checkOutDate: day(outDay), partySize: 2 });
        return stay.bookPaidStay(prisma, {
            bizId: ctx.biz.bizId, roomId: ctx.room.id, customerId: guest.id, checkInDate: day(inDay), checkOutDate: day(outDay),
            partySize: 2, expectedTotalUsdc: p.totalUsdc.toFixed(6), clientRequestKey: key,
        });
    };
    const admin = async () => seedUser(prisma, { role: 'ADMIN' });
    const live = (catalog, key) => catalog.flatMap((p) => p.params).find((x) => x.key === key).live;

    test('F1: every volume query runs; a paid stay is in the escrow volume', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const out = await payStay(ctx, guest, 'f1');
        const overview = await feeLab.getOverview(prisma, { period: '30d' });
        expect(overview.volumeErrors).toEqual({});
        const escrow = overview.volumes['escrow.fee'];
        expect(escrow.count).toBe(1);
        expect(escrow.volumeUsdc).toBeCloseTo(out.payment.amountUsdc, 6);
        // $100 sits in the [100, 250) bucket.
        expect(escrow.buckets).toEqual([expect.objectContaining({ count: 1, upToUsdc: 250 })]);
        expect(overview.actuals.SMART_ESCROW_FEE.revenueUsdc).toBeCloseTo(out.payment.feeUsdc, 6);
        // Segmented sources answer with segments, even when empty.
        expect(overview.volumes['p2p.fee']).toEqual(expect.objectContaining({ count: 0, segments: {} }));
    });

    test('F2: publishing writes exact values; the next stay uses the new fee', async () => {
        const who = await admin();
        const before = await feeLab.readCatalog(prisma);
        expect(live(before, 'fee.escrow.pct')).toBe(50);
        await feeLab.publish(prisma, {
            changes: [
                { key: 'fee.escrow.pct', from: 50, to: 75 },
                { key: 'fee.withdrawMomo.TRUSTED', from: 50, to: 25 },
            ],
            reason: 'Board pricing review', adminId: who.id, adminName: 'finance',
        });
        const gs = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        expect(gs.smartEscrowFeePct.toString()).toBe('0.0075');
        expect(gs.withdrawalFeeByRiskTier).toEqual({ STANDARD: 0.02, TRUSTED: 0.0025, HIGH_RISK: 0.05 });
        expect(await prisma.adminSettingsAuditLog.count({ where: { targetType: 'FEE_LAB' } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { action: 'PUBLISH_FEES' } })).toBe(1);
        const history = await feeLab.history(prisma);
        expect(history[0]).toEqual(expect.objectContaining({ reason: 'Board pricing review', adminId: who.id }));

        const ctx = await seedHotel();
        const p = await stay.priceStay(prisma, { bizId: ctx.biz.bizId, roomId: ctx.room.id, checkInDate: day(7), checkOutDate: day(9), partySize: 2 });
        expect(p.feeUsdc).toBeCloseTo(p.amountUsdc * 0.0075, 6);
    });

    test('F3: a published "keep the fee" is what a hotel cancellation then does', async () => {
        const who = await admin();
        await feeLab.publish(prisma, {
            changes: [{ key: 'feeRefund.BUSINESS_CANCELLED', from: 'REFUND', to: 'KEEP' }],
            reason: 'Testing the keep rule', adminId: who.id,
        });
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const out = await payStay(ctx, guest, 'f3');
        await lifecycle.businessCancelReservation(prisma, { reservationId: out.reservation.id, businessProfileId: ctx.biz.id, reason: 'Closed' });
        const g = await prisma.user.findUnique({ where: { id: guest.id } });
        expect(Number(g.availableBalance)).toBeCloseTo(500 - out.payment.feeUsdc, 6);
    });

    test('F4: a stale publish writes nothing', async () => {
        const who = await admin();
        await prisma.globalSettings.update({ where: { id: 1 }, data: { smartEscrowFeePct: '0.006' } });
        await expect(feeLab.publish(prisma, {
            changes: [{ key: 'fee.escrow.pct', from: 50, to: 75 }],
            reason: 'Loaded before the change', adminId: who.id,
        })).rejects.toMatchObject({ code: 'FEE_CHANGED_MEANWHILE' });
        const gs = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        expect(gs.smartEscrowFeePct.toString()).toBe('0.006');
        expect(await prisma.adminSettingsAuditLog.count()).toBe(0);
        expect(await prisma.auditLog.count()).toBe(0);
    });
});
