// __tests__/payout-cancel-single-winner.test.js
// =============================================================================
// Financial-integrity proof suite (real PostgreSQL):
//
//   1. SHARED-VAULT CANCEL — single-winner semantics. The guarded
//      `status → CANCELLED` transition flips FIRST inside one transaction
//      atomic with the refunds. A replayed or concurrent cancel finds zero
//      updated rows and is refused 409 — contributors are never refunded
//      twice for one vault.
//   2. SHARED-VAULT DEPOSIT — repairs the legacy `prisma.wallet` reference
//      (a model that does NOT exist in the schema; the flow could never
//      work) to the REAL money authority (User.availableBalance), with a
//      single-winner conditional debit, escrow-restriction movement and a
//      §P.4 ledger posting.
//   3. SUSU PAYOUT — single-winner `status → PAID_OUT` transition atomic
//      with the wallet credit: a replayed or concurrent payout can never
//      double-credit the recipient.
//   4. SUSU PAYOUT RATE HONESTY — the payout leg converts base → target at
//      payout time; it now requires a FRESH, persisted, non-demo FxRate
//      observation (stale → 503 RATE_STALE, missing → 503
//      RATE_UNAVAILABLE, hardcoded demo fallback never used for money).
//   5. SUSU CONTRIBUTE — single-winner conditional debit on the
//      currency wallet: concurrent contributions can never spend the same
//      stale balance twice (no negative balance can be created).
// =============================================================================

jest.mock('../middleware/authMiddleware', () => ({
    protect: function protectGuard(req, res, next) {
        if (mockAuthUserId === null) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }
        req.user = { id: mockAuthUserId, role: 'USER' };
        next();
    },
    adminOnly: function adminOnlyGuard(_req, _res, next) { next(); },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: function protectActiveGuard(req, res, next) {
        if (mockAuthUserId === null) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }
        req.user = req.user || { id: mockAuthUserId, role: 'USER' };
        next();
    },
}));

var mockAuthUserId = null;

const { PrismaClient } = require('@prisma/client');

let hasDb = false;
try {
    const prisma = new PrismaClient();
    hasDb = true;
    prisma.$disconnect();
} catch (_e) {
    hasDb = false;
}

const MARK = `swp-${Date.now()}`;

(hasDb ? describe : describe.skip)('Payout and shared-vault cancel — single-winner integrity (real PostgreSQL)', () => {
    jest.setTimeout(30000);

    const express = require('express');
    const request = require('supertest');

    function buildApp(prisma) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { warn: jest.fn(), error: jest.fn() });
        app.use('/api/shared-vaults', require('../routes/sharedVaultRoutes'));
        app.use('/api/cross-border-susu', require('../routes/crossBorderSusuRoutes'));
        return app;
    }

    let prisma;
    let app;
    let originalSettings;
    const originalFxPairs = {}; // from → to → pre-existing row (or null)
    const seeded = { userIds: [], vaultIds: [], groupIds: [], cycleIds: [] };

    const setFreshRate = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
            create: { id: 1, liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
        });

    const upsertFxRate = (from, to, rate, fetchedAt) =>
        prisma.fxRate.upsert({
            where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
            update: { rate, fetchedAt },
            create: { fromCurrency: from, toCurrency: to, rate, fetchedAt, source: 'TEST' },
        });

    const mkUser = async (i, opts = {}) =>
        prisma.user.create({
            data: {
                username: `${MARK}-u${i}`,
                email: `${MARK}-u${i}@test.local`,
                password: 'x',
                availableBalance: opts.available ?? 0,
                escrowLockedBalance: opts.locked ?? 0,
            },
        });

    beforeAll(async () => {
        prisma = new PrismaClient();
        app = buildApp(prisma);
        originalSettings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        await setFreshRate();
        // Snapshot every FX pair this suite touches so afterAll can restore
        // the exact pre-existing state (row values OR absence).
        for (const [from, to] of [['GHS', 'USD'], ['USD', 'GHS']]) {
            originalFxPairs[`${from}:${to}`] = await prisma.fxRate.findUnique({
                where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
            });
        }
    });

    afterAll(async () => {
        if (prisma) {
            // Order matters: SusuCycle.payoutUserId and SusuGroup rows
            // reference the seeded users, so cycles, configs and vaults must
            // be deleted BEFORE the users or the FK constraints reject the
            // cleanup (seen on a fully-migrated CI database).
            await prisma.susuCycle.deleteMany({ where: { id: { in: seeded.cycleIds } } });
            await prisma.crossBorderFxSnapshot.deleteMany({ where: { userId: { in: seeded.userIds } } });
            await prisma.crossBorderSusuConfig.deleteMany({ where: { susuGroupId: { in: seeded.groupIds } } });
            await prisma.sharedVault.deleteMany({ where: { id: { in: seeded.vaultIds } } });
            await prisma.susuGroup.deleteMany({ where: { id: { in: seeded.groupIds } } });
            await prisma.user.deleteMany({ where: { username: { startsWith: `${MARK}-` } } });
            // Restore whatever rate state the DB had before this suite.
            if (originalSettings) {
                await prisma.globalSettings.update({ where: { id: 1 }, data: originalSettings });
            }
            for (const [pair, row] of Object.entries(originalFxPairs)) {
                const [from, to] = pair.split(':');
                if (row) {
                    await prisma.fxRate.update({
                        where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
                        data: { rate: row.rate, fetchedAt: row.fetchedAt, source: row.source, isDemoSeed: row.isDemoSeed },
                    }).catch(() => {});
                } else {
                    await prisma.fxRate.deleteMany({
                        where: { fromCurrency: from, toCurrency: to },
                    }).catch(() => {});
                }
            }
            await prisma.$disconnect();
        }
    });

    // ────────────────────────────────────────────────────────────────────
    // 1 + 2: shared-vault deposit/cancel against the REAL money authority
    // ────────────────────────────────────────────────────────────────────
    describe('Shared vault — deposit repair + single-winner cancel', () => {
        test('deposit debits User.availableBalance (the real authority), moves escrow, posts the ledger', async () => {
            const owner = await mkUser(1);
            const member = await mkUser(2, { available: 100 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: { name: `${MARK} vault`, targetAmountUsdc: 1000, creatorId: owner.id, members: { create: [{ userId: member.id, role: 'CONTRIBUTOR' }] } },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const res = await request(app).post(`/api/shared-vaults/${vault.id}/deposit`)
                .set('idempotency-key', `${MARK}-dep-1`).send({ amountUsdc: 30 });

            expect(res.status).toBe(200);
            const u = await prisma.user.findUnique({ where: { id: member.id } });
            expect(parseFloat(u.availableBalance)).toBeCloseTo(70, 6);
            expect(parseFloat(u.escrowLockedBalance)).toBeCloseTo(30, 6);
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id }, include: { members: true } });
            expect(parseFloat(v.currentAmountUsdc)).toBeCloseTo(30, 6);
            expect(parseFloat(v.members[0].contributedUsdc)).toBeCloseTo(30, 6);
            const entries = await prisma.journalEntry.findMany({
                where: { entryType: 'SHARED_VAULT_DEPOSIT', relatedEntityId: vault.id },
            });
            // JournalEntry stores ONE ROW PER LINE (double-entry): the debit
            // and the credit line share one posting identity. Exactly ONE
            // posting, exactly two balanced lines.
            expect(new Set(entries.map((e) => e.ledgerTransactionId)).size).toBe(1);
            expect(entries.length).toBe(2);
        });

        test('two concurrent deposits of 40 against a 50 balance: exactly one wins, no negative balance', async () => {
            const owner = await mkUser(3);
            const member = await mkUser(4, { available: 50 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: { name: `${MARK} race`, targetAmountUsdc: 1000, creatorId: owner.id, members: { create: [{ userId: member.id }] } },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const [a, b] = await Promise.all([
                request(app).post(`/api/shared-vaults/${vault.id}/deposit`).set('idempotency-key', `${MARK}-race-a`).send({ amountUsdc: 40 }),
                request(app).post(`/api/shared-vaults/${vault.id}/deposit`).set('idempotency-key', `${MARK}-race-b`).send({ amountUsdc: 40 }),
            ]);
            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([200, 400]); // exactly one success, one insufficient

            const u = await prisma.user.findUnique({ where: { id: member.id } });
            const avail = parseFloat(u.availableBalance);
            const locked = parseFloat(u.escrowLockedBalance);
            expect(avail).toBeGreaterThanOrEqual(0);
            expect(avail + locked).toBeCloseTo(50, 6); // no money created or lost
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id } });
            expect(parseFloat(v.currentAmountUsdc)).toBeCloseTo(40, 6); // exactly one deposit
        });

        test('cancel is single-winner: refunds once, replay is 409, balances never move twice', async () => {
            const owner = await mkUser(5, { locked: 20 }); // deposited 20 → 20 locked
            const rich = await mkUser(6, { available: 70, locked: 30 });
            const zero = await mkUser(7);
            seeded.userIds.push(owner.id, rich.id, zero.id);
            const vault = await prisma.sharedVault.create({
                data: {
                    name: `${MARK} cancel`, targetAmountUsdc: 1000, creatorId: owner.id,
                    members: {
                        create: [
                            { userId: owner.id, role: 'OWNER', contributedUsdc: 20 },
                            { userId: rich.id, contributedUsdc: 30 },
                            { userId: zero.id, contributedUsdc: 0 },
                        ],
                    },
                },
            });
            seeded.vaultIds.push(vault.id);

            // Non-owner cannot cancel.
            mockAuthUserId = rich.id;
            const forbidden = await request(app).delete(`/api/shared-vaults/${vault.id}`);
            expect(forbidden.status).toBe(403);

            // Owner cancels: refunds release the escrow restrictions.
            mockAuthUserId = owner.id;
            const first = await request(app).delete(`/api/shared-vaults/${vault.id}`);
            expect(first.status).toBe(200);
            expect(first.body.message).toMatch(/Funds returned/i);

            const ownerRow = await prisma.user.findUnique({ where: { id: owner.id } });
            const richRow = await prisma.user.findUnique({ where: { id: rich.id } });
            const zeroRow = await prisma.user.findUnique({ where: { id: zero.id } });
            expect(parseFloat(ownerRow.availableBalance)).toBeCloseTo(20, 6);
            expect(parseFloat(ownerRow.escrowLockedBalance)).toBeCloseTo(0, 6);
            expect(parseFloat(richRow.availableBalance)).toBeCloseTo(100, 6);
            expect(parseFloat(richRow.escrowLockedBalance)).toBeCloseTo(0, 6);
            expect(parseFloat(zeroRow.availableBalance)).toBeCloseTo(0, 6); // contributed 0 → untouched

            const refundEntries = await prisma.journalEntry.findMany({
                where: { entryType: 'SHARED_VAULT_REFUND', relatedEntityId: vault.id },
            });
            // One posting per real contribution (2 lines each); the zero
            // contributor is skipped entirely.
            expect(new Set(refundEntries.map((e) => e.ledgerTransactionId)).size).toBe(2);

            // Replay: already cancelled — 409, and NO second refund.
            const replay = await request(app).delete(`/api/shared-vaults/${vault.id}`);
            expect(replay.status).toBe(409);
            expect(replay.body.code).toBe('VAULT_ALREADY_CANCELLED');
            const richAfterReplay = await prisma.user.findUnique({ where: { id: rich.id } });
            expect(parseFloat(richAfterReplay.availableBalance)).toBeCloseTo(100, 6);
        });

        test('two CONCURRENT cancels: exactly one 200 and one 409, refunds applied once', async () => {
            const owner = await mkUser(8);
            const member = await mkUser(9, { available: 0, locked: 25 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: {
                    name: `${MARK} cancelrace`, targetAmountUsdc: 1000, creatorId: owner.id,
                    members: { create: [{ userId: owner.id, role: 'OWNER', contributedUsdc: 0 }, { userId: member.id, contributedUsdc: 25 }] },
                },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = owner.id;
            const [a, b] = await Promise.all([
                request(app).delete(`/api/shared-vaults/${vault.id}`),
                request(app).delete(`/api/shared-vaults/${vault.id}`),
            ]);
            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([200, 409]);

            const m = await prisma.user.findUnique({ where: { id: member.id } });
            expect(parseFloat(m.availableBalance)).toBeCloseTo(25, 6); // refunded exactly once
            expect(parseFloat(m.escrowLockedBalance)).toBeCloseTo(0, 6);
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // 3 + 4: susu payout single-winner + payout-pair rate honesty
    // ────────────────────────────────────────────────────────────────────
    describe('Cross-border susu payout — single-winner + fresh payout-pair rate', () => {
        const setupCycle = async (n, payoutUserId, baseCurrency = 'GHS') => {
            const group = await prisma.susuGroup.create({
                data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' },
            });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({
                data: { susuGroupId: group.id, baseCurrency, memberCountries: [], createdBy: payoutUserId },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount: 100, payoutUserId, status: 'COLLECTING_GRACE' },
            });
            seeded.cycleIds.push(cycle.id);
            return cycle;
        };

        test('payout succeeds once, then replay with a DIFFERENT idempotency key is 409 and never double-credits', async () => {
            await upsertFxRate('GHS', 'USD', 0.08, new Date());
            const user = await mkUser(10);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupCycle(1, user.id);

            mockAuthUserId = user.id;
            const first = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-pay-1`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(first.status).toBe(200);

            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(8.0, 6); // 100 GHS * 0.08

            const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
            expect(row.status).toBe('PAID_OUT');
            expect(row.paidOutAt).not.toBeNull();

            // Replay attack: a second client with a different key must not
            // be able to double-credit the same cycle.
            const replay = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-pay-1b`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(replay.status).toBe(409);
            expect(replay.body.code).toBe('PAYOUT_ALREADY_COMPLETED');

            const walletAfter = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(walletAfter.balance)).toBeCloseTo(8.0, 6); // credited ONCE
            const snapshots = await prisma.crossBorderFxSnapshot.count({ where: { cycleId: cycle.id, userId: user.id } });
            expect(snapshots).toBe(1); // one payout snapshot, not two
        });

        test('two CONCURRENT payouts with different keys: exactly one 200 and one 409, credited once', async () => {
            const user = await mkUser(11);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupCycle(2, user.id);

            mockAuthUserId = user.id;
            const [a, b] = await Promise.all([
                request(app).post('/api/cross-border-susu/payout').set('idempotency-key', `${MARK}-conc-a`).send({ cycleId: cycle.id, targetCurrency: 'USD' }),
                request(app).post('/api/cross-border-susu/payout').set('idempotency-key', `${MARK}-conc-b`).send({ cycleId: cycle.id, targetCurrency: 'USD' }),
            ]);
            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([200, 409]);

            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(8.0, 6); // never double-credited
        });

        test('stale payout-pair observation → 503 RATE_STALE, no credit, cycle stays unsettled', async () => {
            await upsertFxRate('GHS', 'USD', 0.08, new Date(Date.now() - 3 * 3600_000));
            const user = await mkUser(12);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupCycle(3, user.id);

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-stale`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('RATE_STALE');

            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(0, 6);
            const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
            expect(row.status).not.toBe('PAID_OUT'); // retryable — the cycle converges once the feed recovers
        });

        test('missing payout-pair observation → 503 RATE_UNAVAILABLE (the hardcoded demo fallback is never used for money)', async () => {
            await prisma.fxRate.delete({ where: { fromCurrency_toCurrency: { fromCurrency: 'GHS', toCurrency: 'USD' } } });
            const user = await mkUser(13);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupCycle(4, user.id);

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-missing`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('RATE_UNAVAILABLE');
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(0, 6);
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // 5: susu contribute single-winner conditional debit
    // ────────────────────────────────────────────────────────────────────
    describe('Cross-border susu contribute — conditional single-winner debit', () => {
        test('contribution debits the currency wallet and records the base amount at a fresh rate', async () => {
            await upsertFxRate('USD', 'GHS', 12.5, new Date());
            const user = await mkUser(14);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 100 } });
            const group = await prisma.susuGroup.create({ data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' } });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({ data: { susuGroupId: group.id, baseCurrency: 'GHS', memberCountries: [], createdBy: user.id } });
            const member = await prisma.susuMember.create({
                data: { susuGroupId: group.id, userId: user.id, cycleSlot: 1, trustScore: 1 },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount: 10, payoutUserId: user.id, status: 'COLLECTING' },
            });
            seeded.cycleIds.push(cycle.id);

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/contribute')
                .set('idempotency-key', `${MARK}-contrib-1`)
                .send({ susuGroupId: group.id, cycleId: cycle.id, memberId: member.id, localAmount: 80, localCurrency: 'USD' });
            expect(res.status).toBe(200);

            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(20, 6);
            const contribution = await prisma.susuContribution.findFirst({ where: { cycleId: cycle.id, userId: user.id } });
            // 80 USD * 12.5 GHS/USD * (1 - 0.005 fee) = 995 GHS base.
            expect(parseFloat(contribution.amountUsdc)).toBeCloseTo(995, 4);
        });

        test('two CONCURRENT contributions of 80 against a 100 balance: exactly one wins, no negative balance', async () => {
            const user = await mkUser(15);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 100 } });
            const group = await prisma.susuGroup.create({ data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' } });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({ data: { susuGroupId: group.id, baseCurrency: 'GHS', memberCountries: [], createdBy: user.id } });
            const member = await prisma.susuMember.create({
                data: { susuGroupId: group.id, userId: user.id, cycleSlot: 1, trustScore: 1 },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount: 10, payoutUserId: user.id, status: 'COLLECTING' },
            });
            seeded.cycleIds.push(cycle.id);

            mockAuthUserId = user.id;
            const [a, b] = await Promise.all([
                request(app).post('/api/cross-border-susu/contribute').set('idempotency-key', `${MARK}-contrib-race-a`).send({ susuGroupId: group.id, cycleId: cycle.id, memberId: member.id, localAmount: 80, localCurrency: 'USD' }),
                request(app).post('/api/cross-border-susu/contribute').set('idempotency-key', `${MARK}-contrib-race-b`).send({ susuGroupId: group.id, cycleId: cycle.id, memberId: member.id, localAmount: 80, localCurrency: 'USD' }),
            ]);
            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([200, 400]); // one success, one insufficient

            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(20, 6); // debited exactly once
            const contributions = await prisma.susuContribution.count({ where: { cycleId: cycle.id, userId: user.id } });
            expect(contributions).toBe(1);
        });
    });
});
