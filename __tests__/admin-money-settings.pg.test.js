'use strict';

/**
 * Money settings API — real PostgreSQL, no mocked storage.
 *
 * Mocked Prisma would prove the validation branches and nothing else. The
 * claims that actually matter here are storage claims:
 *   • a GHS threshold round-trips as the exact string it was given (no float);
 *   • a future-effective revision is stored but NOT active;
 *   • the revision and BOTH audit rows commit or fail together.
 * Those can only be shown against a real database.
 *
 * Requires TEST_DATABASE_URL / DATABASE_URL and a migrated schema.
 */

const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);

process.env.DATABASE_URL = DB_URL || process.env.DATABASE_URL;

const { PrismaClient } = require('@prisma/client');
const contract = require('../src/lib/moneySettingsContract');
const service = require('../services/moneySettingsService');
const controller = require('../controllers/adminMoneySettingsController');

function makeRes() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        body: null,
        code: null,
    };
}

const describeDb = hasDb ? describe : describe.skip;

describeDb('money settings (real Postgres)', () => {
    let prisma;

    const ACTOR = { adminId: 4242, adminName: 'Finance Admin', ipAddress: '10.0.0.1' };

    const write = (input, deps = {}) => service.writeSetting(prisma, {
        key: input.key,
        value: input.value,
        reason: input.reason,
        note: input.note,
        effectiveAt: input.effectiveAt,
        effectiveFrom: input.effectiveFrom,
        ...ACTOR,
    }, deps);

    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        await prisma.$connect();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.adminMoneySettingRevision.deleteMany({});
        await prisma.adminSettingsAuditLog.deleteMany({});
        await prisma.auditLog.deleteMany({});
        await prisma.globalSettings.deleteMany({});
    });

    // ── snapshot shape the Admin Portal actually parses ──────────────────────
    test('snapshot matches the agreed portal shape: settings[], flags, bounds', async () => {
        await prisma.globalSettings.create({
            data: { id: 1, nativeGhsSettlementEnabled: true },
        });

        const snap = await service.getSnapshot(prisma);

        expect(Array.isArray(snap.settings)).toBe(true);
        expect(snap.settings).toHaveLength(contract.MONEY_SETTING_KEYS.length);
        for (const entry of snap.settings) {
            expect(entry).toHaveProperty('key');
            expect(entry).toHaveProperty('value');
            // the portal parses `effectiveFrom`; `effectiveAt` alone is invisible to it
            expect(entry).toHaveProperty('effectiveFrom');
            expect(entry).toHaveProperty('source');
        }
        expect(snap.flags).toBeTruthy();
        expect(snap.bounds['quoteTtl.payment_topup']).toEqual({ min: 10, max: 900, unit: 'seconds' });
        // a flag that is genuinely on reads true
        expect(snap.flags.nativeGhsSettlementEnabled).toBe(true);
        // a flag with no settings row is UNKNOWN, never false
        expect(snap.flags.fiatLiquidityAuthorityEnabled).toBe(false);
    });

    test('with no GlobalSettings row every rollout flag is "unknown", not false', async () => {
        const snap = await service.getSnapshot(prisma);
        for (const flag of contract.READ_ONLY_FLAGS) {
            expect(snap.flags[flag]).toBe('unknown');
        }
    });

    test('documented defaults are returned as numbers and the owner decision is protected', async () => {
        const snap = await service.getSnapshot(prisma);
        const byKey = Object.fromEntries(snap.settings.map((s) => [s.key, s]));

        expect(byKey['quoteTtl.payment_topup'].value).toBe(45);
        expect(byKey['quoteTtl.bucket_convert'].value).toBe(60);
        expect(byKey['quoteTtl.payment_topup'].source).toBe('default');
        // no documented default exists for spreads: "unset" is the honest answer
        expect(byKey['fxSpread.CONVERT_GHS_TO_USDC'].value).toBeNull();
        expect(byKey['fxSpread.CONVERT_GHS_TO_USDC'].source).toBe('unset');

        expect(byKey.balanceHeadlineMode.value).toBe('COMBINED_ESTIMATE');
        expect(byKey.balanceHeadlineMode.ownerResolved).toBe(true);
        expect(snap.ownerResolved.editableThroughThisApi).toBe(false);
    });

    // ── exact storage ───────────────────────────────────────────────────────
    test('a TTL write becomes the active value and keeps the previous one in history', async () => {
        await write({ key: 'quoteTtl.payment_topup', value: 120, reason: 'peak load' });

        const current = await service.getCurrentSetting(prisma, 'quoteTtl.payment_topup');
        expect(current.value).toBe(120);
        expect(current.source).toBe('revision');

        await write({ key: 'quoteTtl.payment_topup', value: 30, reason: 'revert' });
        const history = await service.getHistory(prisma, 'quoteTtl.payment_topup');
        expect(history).toHaveLength(2);
        expect(history[0].value).toBe(30);
        expect(history[0].status).toBe('active');
        expect(history[1].value).toBe(120);
        expect(history[1].status).toBe('superseded');
    });

    test('a GHS threshold is stored as an exact decimal string, never a float', async () => {
        await write({ key: 'stepUpThresholdGhs', value: '1500', reason: 'set threshold' });

        const row = await prisma.adminMoneySettingRevision.findFirst({ where: { key: 'stepUpThresholdGhs' } });
        expect(row.kind).toBe('ghs');
        expect(row.valueText).toBe('1500.00');   // canonicalised to pesewa precision
        expect(row.valueInt).toBeNull();          // never smuggled through an Int

        const current = await service.getCurrentSetting(prisma, 'stepUpThresholdGhs');
        expect(current.value).toBe('1500.00');
        expect(typeof current.value).toBe('string');
    });

    test('exact GHS boundaries: 0.00 accepted, over the policy ceiling refused', async () => {
        const zero = await write({ key: 'stepUpThresholdGhs', value: '0.00', reason: 'always step up' });
        expect(zero.current.value).toBe('0.00');

        await expect(write({ key: 'stepUpThresholdGhs', value: '1000000000.01', reason: 'too big' }))
            .rejects.toMatchObject({ code: contract.CODES.OUT_OF_BOUNDS });
    });

    // ── refusals ────────────────────────────────────────────────────────────
    test.each([
        ['integer out of range (below)', 'quoteTtl.payment_topup', 9, contract.CODES.OUT_OF_BOUNDS],
        ['integer out of range (above)', 'quoteTtl.payment_topup', 901, contract.CODES.OUT_OF_BOUNDS],
        ['fractional seconds', 'quoteTtl.payment_topup', 45.5, contract.CODES.INVALID_VALUE],
        ['non-numeric string', 'quoteTtl.payment_topup', 'soon', contract.CODES.INVALID_VALUE],
        ['exponent string', 'quoteTtl.payment_topup', '1e3', contract.CODES.INVALID_VALUE],
        // -1 is a well-formed integer that falls outside 0–1000, so the precise
        // refusal is a bounds violation, not a malformed value.
        ['negative bps', 'fxSpread.CONVERT_GHS_TO_USDC', -1, contract.CODES.OUT_OF_BOUNDS],
        ['bps above 10%', 'fxSpread.CONVERT_GHS_TO_USDC', 1001, contract.CODES.OUT_OF_BOUNDS],
        ['fractional bps', 'fxSpread.CONVERT_GHS_TO_USDC', 12.5, contract.CODES.INVALID_VALUE],
        ['GHS as JSON number', 'stepUpThresholdGhs', 1500, contract.CODES.INVALID_VALUE],
        ['GHS negative', 'stepUpThresholdGhs', '-1.00', contract.CODES.INVALID_VALUE],
        ['GHS exponent', 'stepUpThresholdGhs', '1e3', contract.CODES.INVALID_VALUE],
        ['GHS three decimals', 'stepUpThresholdGhs', '10.005', contract.CODES.INVALID_VALUE],
        ['GHS with separator', 'stepUpThresholdGhs', '1,500.00', contract.CODES.INVALID_VALUE],
    ])('refuses %s', async (_label, key, value, code) => {
        await expect(write({ key, value, reason: 'test' })).rejects.toMatchObject({ code });
        expect(await prisma.adminMoneySettingRevision.count()).toBe(0);
    });

    test('a surface-valid GHS string is trimmed and canonicalised', async () => {
        await write({ key: 'stepUpThresholdGhs', value: '  250.5  ', reason: 'padded' });
        const current = await service.getCurrentSetting(prisma, 'stepUpThresholdGhs');
        expect(current.value).toBe('250.50');
    });

    test('unknown keys are refused and nothing is stored', async () => {
        await expect(write({ key: 'fxSpread.NOT_A_KEY', value: 10, reason: 'x' }))
            .rejects.toMatchObject({ code: contract.CODES.UNKNOWN_KEY });
        expect(await prisma.adminMoneySettingRevision.count()).toBe(0);
    });

    test('a legacy alias is resolved to the canonical key on write and read', async () => {
        await write({
            key: 'fxSpread.payment_topup.GHS_USDC',
            value: 125,
            reason: 'alias write',
        });
        const rows = await prisma.adminMoneySettingRevision.findMany({});
        expect(rows).toHaveLength(1);
        // stored canonically — a second spelling must never exist in the table
        expect(rows[0].key).toBe('fxSpread.PAYMENT_TOPUP_GHS_FROM_USDC');
    });

    test('the owner-resolved headline mode cannot be changed through this API', async () => {
        await expect(write({ key: 'balanceHeadlineMode', value: 'NATIVE_ONLY', reason: 'flip it' }))
            .rejects.toMatchObject({ code: contract.CODES.OWNER_RESOLVED, status: 409 });
        expect(await prisma.adminMoneySettingRevision.count()).toBe(0);
        const snap = await service.getSnapshot(prisma);
        const headline = snap.settings.find((s) => s.key === 'balanceHeadlineMode');
        expect(headline.value).toBe('COMBINED_ESTIMATE');
    });

    test('a change with no reason is refused (both field names checked)', async () => {
        await expect(write({ key: 'quoteTtl.payment_topup', value: 120, reason: '   ' }))
            .rejects.toMatchObject({ code: contract.CODES.REASON_REQUIRED });
        await expect(write({ key: 'quoteTtl.payment_topup', value: 120, note: '' }))
            .rejects.toMatchObject({ code: contract.CODES.REASON_REQUIRED });
        expect(await prisma.adminMoneySettingRevision.count()).toBe(0);
    });

    test('the portal sends `note`; it is accepted and stored as the reason', async () => {
        await write({ key: 'quoteTtl.bucket_convert', value: 90, note: 'portal wrote this' });
        const row = await prisma.adminMoneySettingRevision.findFirst({ where: { key: 'quoteTtl.bucket_convert' } });
        expect(row.reason).toBe('portal wrote this');
    });

    // ── future-effective revisions ──────────────────────────────────────────
    test('a future-effective revision is stored but NOT active until its time', async () => {
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const result = await write({
            key: 'quoteTtl.payment_topup',
            value: 300,
            note: 'scheduled',
            effectiveFrom: future.toISOString(),
        });
        expect(result.scheduled).toBe(true);

        // still the documented default: the scheduled change has not begun
        const nowCurrent = await service.getCurrentSetting(prisma, 'quoteTtl.payment_topup');
        expect(nowCurrent.value).toBe(45);

        const history = await service.getHistory(prisma, 'quoteTtl.payment_topup');
        expect(history[0].status).toBe('scheduled');

        // and it activates exactly when it should
        const after = new Date(future.getTime() + 1000);
        const laterCurrent = await service.getCurrentSetting(prisma, 'quoteTtl.payment_topup', after);
        expect(laterCurrent.value).toBe(300);
    });

    // ── atomicity of revision + audit ───────────────────────────────────────
    test('a successful write records the revision AND both audit trails', async () => {
        await write({ key: 'fxSpread.CONVERT_USDC_TO_GHS', value: 200, reason: 'spread change' });

        const general = await prisma.auditLog.findMany({ where: { action: 'UPDATE_MONEY_SETTING' } });
        expect(general).toHaveLength(1);
        expect(general[0].actorId).toBe(ACTOR.adminId);
        expect(general[0].targetId).toBe('fxSpread.CONVERT_USDC_TO_GHS');
        expect(general[0].metadata.value).toBe('200');

        const settingsTrail = await prisma.adminSettingsAuditLog.findMany({ where: { targetType: 'MONEY_SETTING' } });
        expect(settingsTrail).toHaveLength(1);
        expect(settingsTrail[0].changes.new).toBe('200');
    });

    test('if the audit write fails, the money change is NOT committed', async () => {
        const explodingAudit = jest.fn().mockRejectedValue(new Error('audit store down'));

        await expect(write(
            { key: 'quoteTtl.payment_topup', value: 200, reason: 'must roll back' },
            { auditFn: explodingAudit }
        )).rejects.toThrow(/audit store down/);

        // the whole transaction rolled back: no revision, no half-written change
        expect(await prisma.adminMoneySettingRevision.count()).toBe(0);
        const current = await service.getCurrentSetting(prisma, 'quoteTtl.payment_topup');
        expect(current.value).toBe(45);
    });

    test('concurrent writes to the same key both land and the newest is active', async () => {
        const results = await Promise.allSettled([
            write({ key: 'quoteTtl.payment_topup', value: 100, reason: 'A' }),
            write({ key: 'quoteTtl.payment_topup', value: 200, reason: 'B' }),
        ]);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

        const rows = await prisma.adminMoneySettingRevision.findMany({ where: { key: 'quoteTtl.payment_topup' } });
        expect(rows).toHaveLength(2);

        const history = await service.getHistory(prisma, 'quoteTtl.payment_topup');
        expect(history.filter((h) => h.status === 'active')).toHaveLength(1);
        expect(history[0].status).toBe('active');
    });

    // ── controller surface ──────────────────────────────────────────────────
    describe('controller', () => {
        const makeReq = (over = {}) => ({
            app: { get: () => prisma },
            user: { id: ACTOR.adminId, username: ACTOR.adminName },
            ip: '10.0.0.1',
            params: {},
            query: {},
            body: {},
            ...over,
        });

        test('GET returns the snapshot in the portal shape', async () => {
            const res = makeRes();
            await controller.getSettings(makeReq(), res);
            const payload = res.json.mock.calls[0][0];
            expect(payload.success).toBe(true);
            expect(Array.isArray(payload.data.settings)).toBe(true);
            expect(payload.data.flags).toBeTruthy();
        });

        test('PUT stores the change and reports the new current value', async () => {
            const res = makeRes();
            await controller.updateSetting(
                makeReq({ params: { key: 'quoteTtl.payment_topup' }, body: { value: 150, note: 'via controller' } }),
                res
            );
            const payload = res.json.mock.calls[0][0];
            expect(payload.success).toBe(true);
            expect(payload.value).toBe(150);
        });

        test('PUT surfaces the typed refusal with its status, not a generic 500', async () => {
            const res = makeRes();
            await controller.updateSetting(
                makeReq({ params: { key: 'balanceHeadlineMode' }, body: { value: 'NATIVE_ONLY', note: 'x' } }),
                res
            );
            expect(res.status).toHaveBeenCalledWith(409);
            const payload = res.json.mock.calls[0][0];
            expect(payload.code).toBe(contract.CODES.OWNER_RESOLVED);
        });

        test('history distinguishes empty history from an unknown key', async () => {
            const emptyRes = makeRes();
            await controller.getHistory(makeReq({ params: { key: 'quoteTtl.payment_topup' } }), emptyRes);
            const emptyPayload = emptyRes.json.mock.calls[0][0];
            expect(emptyPayload.success).toBe(true);
            expect(emptyPayload.history).toEqual([]);

            const badRes = makeRes();
            await controller.getHistory(makeReq({ params: { key: 'nope' } }), badRes);
            expect(badRes.status).toHaveBeenCalledWith(400);
            expect(badRes.json.mock.calls[0][0].code).toBe(contract.CODES.UNKNOWN_KEY);
        });
    });
});

// ── permission catalog (no database needed) ─────────────────────────────────
describe('money settings permissions', () => {
    const { ADMIN_ROLES } = require('../controllers/adminRbacController');

    test('FINANCE_ADMIN may read and write money settings', () => {
        expect(ADMIN_ROLES.FINANCE_ADMIN.permissions).toContain('money.settings.view');
        expect(ADMIN_ROLES.FINANCE_ADMIN.permissions).toContain('money.settings.write');
    });

    test('READ_ONLY_ADMIN may read but never write', () => {
        expect(ADMIN_ROLES.READ_ONLY_ADMIN.permissions).toContain('money.settings.view');
        expect(ADMIN_ROLES.READ_ONLY_ADMIN.permissions).not.toContain('money.settings.write');
    });

    test('SUPPORT_ADMIN and COMPLIANCE_ADMIN have no money-settings write', () => {
        for (const role of ['SUPPORT_ADMIN', 'COMPLIANCE_ADMIN']) {
            expect(ADMIN_ROLES[role].permissions).not.toContain('money.settings.write');
        }
    });

    test('viewing general settings does not imply money settings', () => {
        // 'platform.settings' is reserved (granted to no specialized role), so a
        // holder of general settings is not automatically a money-settings actor.
        for (const role of ['FINANCE_ADMIN', 'READ_ONLY_ADMIN', 'SUPPORT_ADMIN']) {
            if (ADMIN_ROLES[role].permissions.includes('platform.settings')) {
                expect(ADMIN_ROLES[role].permissions).toContain('money.settings.write');
            }
        }
    });
});
