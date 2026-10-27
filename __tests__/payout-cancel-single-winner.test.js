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
        for (const [from, to] of [['GHS', 'USD'], ['USD', 'GHS'], ['GHS', 'NGN']]) {
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

        test('ELIGIBILITY REGRESSION: a COMPLETED vault cannot be cancelled (funds are spent on the goal)', async () => {
            const owner = await mkUser(24);
            seeded.userIds.push(owner.id);
            const vault = await prisma.sharedVault.create({
                data: {
                    name: `${MARK} done`, targetAmountUsdc: 100, creatorId: owner.id,
                    status: 'COMPLETED', completedAt: new Date(),
                    members: { create: [{ userId: owner.id, role: 'OWNER', contributedUsdc: 100 }] },
                },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = owner.id;
            const res = await request(app).delete(`/api/shared-vaults/${vault.id}`);
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('VAULT_NOT_CANCELLABLE');
            // No refund was fabricated for the completed vault.
            const u = await prisma.user.findUnique({ where: { id: owner.id } });
            expect(parseFloat(u.availableBalance)).toBeCloseTo(0, 6);
            expect(parseFloat(u.escrowLockedBalance)).toBeCloseTo(0, 6);
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id } });
            expect(v.status).toBe('COMPLETED');
            expect(v.cancelledAt).toBeNull();
        });

        test('RACE REGRESSION: deposit into a CANCELLED vault → 409 VAULT_NOT_ACTIVE, debit fully rolled back', async () => {
            const owner = await mkUser(25);
            const member = await mkUser(26, { available: 100 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: {
                    name: `${MARK} closed`, targetAmountUsdc: 1000, creatorId: owner.id,
                    status: 'CANCELLED', cancelledAt: new Date(),
                    members: { create: [{ userId: owner.id, role: 'OWNER', contributedUsdc: 0 }, { userId: member.id, contributedUsdc: 0 }] },
                },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const res = await request(app).post(`/api/shared-vaults/${vault.id}/deposit`)
                .set('idempotency-key', `${MARK}-dep-closed`).send({ amountUsdc: 30 });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('VAULT_NOT_ACTIVE');

            // The conditional debit (which wins BEFORE the vault predicate
            // refuses) must be ROLLED BACK with the transaction — the
            // user's balance is untouched and nothing landed in the vault.
            const u = await prisma.user.findUnique({ where: { id: member.id } });
            expect(parseFloat(u.availableBalance)).toBeCloseTo(100, 6);
            expect(parseFloat(u.escrowLockedBalance)).toBeCloseTo(0, 6);
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id } });
            expect(parseFloat(v.currentAmountUsdc)).toBeCloseTo(0, 6);
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // 3 + 4: susu payout single-winner + payout-pair rate honesty
    // ────────────────────────────────────────────────────────────────────
    describe('Cross-border susu payout — single-winner + fresh payout-pair rate', () => {
        const setupCycle = async (n, payoutUserId, baseCurrency = 'GHS', payoutAmount = 100) => {
            const group = await prisma.susuGroup.create({
                data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' },
            });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({
                data: { susuGroupId: group.id, baseCurrency, memberCountries: [], createdBy: payoutUserId },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount, payoutUserId, status: 'COLLECTING_GRACE' },
            });
            // FUNDING PROOF (review fix): the payout now requires the
            // cycle's PAID contributions to cover payoutAmount, so the
            // seed funds the pool with one real PAID contribution.
            const member = await prisma.susuMember.create({
                data: { susuGroupId: group.id, userId: payoutUserId, cycleSlot: 1, trustScore: 1 },
            });
            await prisma.susuContribution.create({
                data: { cycleId: cycle.id, memberId: member.id, userId: payoutUserId, amountUsdc: 100, status: 'PAID' },
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

        // ────────────────────────────────────────────────────────────────
    // 4b: CURRENCY-CONTRACT BOUNDARY (review closeout) — settlementScaleFor
    // defaults unknown/absent currencies to fiat precision; it does NOT
    // reject them. A legacy/malformed config row (DB-origin baseCurrency
    // outside the supported contract) must be refused at the boundary
    // with ZERO financial mutation — never silently settled at 2dp.
    // ────────────────────────────────────────────────────────────────
    test('payout with an UNSUPPORTED DB-origin baseCurrency is refused with no mutation', async () => {
        const user = await mkUser(50);
        seeded.userIds.push(user.id);
        await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
        const cycle = await setupCycle(5, user.id, 'XYZ'); // unsupported stored base currency

        mockAuthUserId = user.id;
        const res = await request(app).post('/api/cross-border-susu/payout')
            .set('idempotency-key', `${MARK}-badbase`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UNSUPPORTED_BASE_CURRENCY');

        const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
        expect(parseFloat(wallet.balance)).toBeCloseTo(0, 6); // NOTHING credited
        const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        expect(row.status).toBe('COLLECTING_GRACE'); // never transitioned
        expect(row.paidOutAt).toBeNull();
        const snapshots = await prisma.crossBorderFxSnapshot.count({ where: { cycleId: cycle.id, userId: user.id } });
        expect(snapshots).toBe(0); // no FX snapshot written
    });

    // ────────────────────────────────────────────────────────────────
    // DUST-SETTLEMENT GUARD (owner policy on #369): a live rate and a real
    // payout amount can still quantize to 0.00 minor units — a payout that
    // cannot exist. The leg refuses with an honest DUST_SETTLEMENT verdict
    // BEFORE the single-winner transition; the cycle stays collectable and
    // NOTHING is credited. The old behavior conflated this with rate
    // unavailability (or settled it as zero-value PAID_OUT).
    // ────────────────────────────────────────────────────────────────
    test('payout that would settle to 0.00 → honest 400 DUST_SETTLEMENT, cycle never transitions', async () => {
        await upsertFxRate('GHS', 'USD', 0.08, new Date());
        const user = await mkUser(52);
        seeded.userIds.push(user.id);
        await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
        // 0.01 GHS * 0.08 = 0.0008 USD → quantizes to 0.00 at fiat 2dp.
        const cycle = await setupCycle(7, user.id, 'GHS', 0.01);

        mockAuthUserId = user.id;
        const res = await request(app).post('/api/cross-border-susu/payout')
            .set('idempotency-key', `${MARK}-dust`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DUST_SETTLEMENT');
        expect(res.body.message).toContain('0.00 USD');

        // Nothing moved: no credit, no transition, no snapshot.
        const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
        expect(parseFloat(wallet.balance)).toBeCloseTo(0, 6);
        const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        expect(row.status).toBe('COLLECTING_GRACE'); // payout refused, cycle intact
        expect(row.paidOutAt).toBeNull();
        const snaps = await prisma.crossBorderFxSnapshot.count({ where: { cycleId: cycle.id, userId: user.id } });
        expect(snaps).toBe(0);
    });

    test('contribution with an UNSUPPORTED DB-origin baseCurrency is refused with no debit', async () => {
        const user = await mkUser(51);
        seeded.userIds.push(user.id);
        const cycle = await setupCycle(6, user.id, 'XYZ'); // unsupported stored base currency
        await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'GHS', balance: 1000 } });

        const member = await prisma.susuMember.findFirst({ where: { susuGroupId: cycle.susuGroupId } });
        mockAuthUserId = user.id;
        const res = await request(app).post('/api/cross-border-susu/contribute')
            .set('idempotency-key', `${MARK}-badbase-c`).send({ susuGroupId: cycle.susuGroupId, cycleId: cycle.id, memberId: member.id, localAmount: '100', localCurrency: 'GHS' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UNSUPPORTED_BASE_CURRENCY');

        const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'GHS' } } });
        expect(parseFloat(wallet.balance)).toBeCloseTo(1000, 6); // never debited
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
    // 3b/4b: payout ELIGIBILITY + FUNDING PROOF regressions (review fix)
    // ────────────────────────────────────────────────────────────────────
    describe('Cross-border susu payout — explicit eligible states + funding proof', () => {
        const setupBare = async (payoutUserId, status) => {
            const group = await prisma.susuGroup.create({
                data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' },
            });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({
                data: { susuGroupId: group.id, baseCurrency: 'GHS', memberCountries: [], createdBy: payoutUserId },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount: 100, payoutUserId, status },
            });
            seeded.cycleIds.push(cycle.id);
            return cycle;
        };

        test('PENDING cycle (never started) → honest 409 CYCLE_NOT_PAYOUT_ELIGIBLE, no credit', async () => {
            await upsertFxRate('GHS', 'USD', 0.08, new Date());
            const user = await mkUser(20);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupBare(user.id, 'PENDING');
            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-pend`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CYCLE_NOT_PAYOUT_ELIGIBLE');
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBe(0);
        });

        test('DEFAULTED cycle (already resolved by the penalty ladder) → 409 CYCLE_NOT_PAYOUT_ELIGIBLE', async () => {
            const user = await mkUser(21);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupBare(user.id, 'DEFAULTED');
            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-def`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CYCLE_NOT_PAYOUT_ELIGIBLE');
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBe(0);
        });

        test('COLLECTING cycle with NO contributions → honest 409 CYCLE_NOT_FUNDED (never fabricates money)', async () => {
            const user = await mkUser(22);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupBare(user.id, 'COLLECTING'); // eligible status, EMPTY pool
            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-nf`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CYCLE_NOT_FUNDED');
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBe(0);
            const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
            expect(row.status).toBe('COLLECTING'); // claim rolled back — no half-payout state
        });

        test('COLLECTING cycle PARTIALLY funded (contributions < payoutAmount) → 409 CYCLE_NOT_FUNDED', async () => {
            const user = await mkUser(23);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const cycle = await setupBare(user.id, 'COLLECTING');
            const member = await prisma.susuMember.create({
                data: { susuGroupId: cycle.susuGroupId, userId: user.id, cycleSlot: 1, trustScore: 1 },
            });
            await prisma.susuContribution.create({
                data: { cycleId: cycle.id, memberId: member.id, userId: user.id, amountUsdc: 40, status: 'PAID' }, // 40 < 100
            });
            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-pf`).send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CYCLE_NOT_FUNDED');
            const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
            expect(row.status).toBe('COLLECTING');
            expect(row.paidOutAt).toBeNull();
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

    // ── SETTLEMENT SCALE (Blocker B) ────────────────────────────────────────
    //
    // The cross-border money paths must settle computed conversions ONCE at
    // the destination currency's scale, and the SAME settled Decimal must
    // be what the DB row persists, the wallet moves and the response
    // serializes. These regressions use deliberately awkward amounts and
    // rates (sub-minor-unit products, 14-digit rates, dust payouts) to pin
    // the boundary and the wire representation.
    describe('Cross-border settlement scale — awkward amounts settle identically everywhere', () => {
        const setupGroup = async (user, { payoutAmount, baseCurrency = 'GHS' } = {}) => {
            const group = await prisma.susuGroup.create({
                data: { contributionUsdc: 10, totalCycles: 1, contractRequiredCount: 1, startDate: new Date(), rotationSnapshot: [], frequency: 'WEEKLY' },
            });
            seeded.groupIds.push(group.id);
            await prisma.crossBorderSusuConfig.create({
                data: { susuGroupId: group.id, baseCurrency, memberCountries: [], createdBy: user.id },
            });
            const member = await prisma.susuMember.create({
                data: { susuGroupId: group.id, userId: user.id, cycleSlot: 1, trustScore: 1 },
            });
            const cycle = await prisma.susuCycle.create({
                data: { susuGroupId: group.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount, payoutUserId: user.id, status: 'COLLECTING' },
            });
            seeded.cycleIds.push(cycle.id);
            return { group, member, cycle };
        };

        test('a 14-digit rate contribution: response wire string === persisted contribution === persisted FX snapshot (bit-for-bit)', async () => {
            // 12.34349999999999 is 17 significant digits — a JS double cannot
            // represent it; only exact Decimal arithmetic survives the
            // round trip. The fee-adjusted effective rate settles FIRST to
            // the snapshot column scale (12.34349999999999 * 0.995 =
            // 12.28178249999999... -> 12.28178250), then 10.01 USD *
            // 12.28178250 = 122.941049... settles to 122.94 GHS (HALF_UP).
            await upsertFxRate('USD', 'GHS', '12.34349999999999', new Date());
            const user = await mkUser(30);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 100 } });
            const { group, member, cycle } = await setupGroup(user, { payoutAmount: 10 });

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/contribute')
                .set('idempotency-key', `${MARK}-scale-1`)
                .send({ susuGroupId: group.id, cycleId: cycle.id, memberId: member.id, localAmount: '10.01', localCurrency: 'USD' });
            expect(res.status).toBe(200);
            expect(res.body.fxSnapshot.baseAmount).toBe('122.94');

            // The SAME settled value the response serialized is what the
            // database actually stored (Postgres would otherwise have
            // silently rounded an unquantized write).
            const contribution = await prisma.susuContribution.findFirst({ where: { cycleId: cycle.id, userId: user.id } });
            expect(contribution.amountUsdc.toString()).toBe('122.94');
            const snapshot = await prisma.crossBorderFxSnapshot.findFirst({ where: { cycleId: cycle.id, userId: user.id } });
            expect(snapshot.baseAmount.toString()).toBe('122.94');
            // Snapshot rate is the SETTLED effective rate actually applied
            // (12.34349999999999 * 0.995 = 12.2817824999999... → 12.28178250;
            // Postgres numeric normalizes the trailing zero on read-back).
            expect(snapshot.rate.toString()).toBe('12.2817825');
            // The wallet was debited the exact requested local amount.
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(wallet.balance.toString()).toBe('89.99');
        });

        test('a contribution with sub-minor-unit precision is REFUSED — no silent rounding of a debit', async () => {
            await upsertFxRate('USD', 'GHS', 12.5, new Date());
            const user = await mkUser(31);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 100 } });
            const { group, member, cycle } = await setupGroup(user, { payoutAmount: 10 });

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/contribute')
                .set('idempotency-key', `${MARK}-scale-2`)
                .send({ susuGroupId: group.id, cycleId: cycle.id, memberId: member.id, localAmount: '10.000000001', localCurrency: 'USD' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('AMOUNT_PRECISION_EXCEEDED');

            // Nothing moved: wallet untouched, no contribution, no snapshot.
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(wallet.balance.toString()).toBe('100');
            expect(await prisma.susuContribution.count({ where: { cycleId: cycle.id, userId: user.id } })).toBe(0);
            expect(await prisma.crossBorderFxSnapshot.count({ where: { cycleId: cycle.id, userId: user.id } })).toBe(0);
        });

        test('group creation refuses an over-precision / zero / astronomical base contribution before any durable write', async () => {
            const user = await mkUser(32);
            seeded.userIds.push(user.id);
            mockAuthUserId = user.id;
            const base = { name: 'scale-group', contributionAmount: null, baseCurrency: 'GHS', frequency: 'WEEKLY', totalCycles: 1, memberCountries: [{ country: 'GH' }, { country: 'NG' }] };
            const mkBody = (amount) => ({ ...base, contributionAmount: amount });

            const over = await request(app).post('/api/cross-border-susu').send(mkBody('10.000000001'));
            expect(over.status).toBe(400);
            expect(over.body.code).toBe('AMOUNT_PRECISION_EXCEEDED');

            const zero = await request(app).post('/api/cross-border-susu').send(mkBody('0'));
            expect(zero.status).toBe(400);
            expect(zero.body.code).toBe('INVALID_AMOUNT');

            const huge = await request(app).post('/api/cross-border-susu').send(mkBody('1e409'));
            expect(huge.status).toBe(400);
            expect(huge.body.code).toBe('INVALID_AMOUNT');

            // All three refusals happened BEFORE any durable write.
            const groupsForUser = await prisma.crossBorderSusuConfig.count({ where: { createdBy: user.id } });
            expect(groupsForUser).toBe(0);
        });

        test('an awkward payout: wallet credit === snapshot row === response string, settled at the TARGET currency scale', async () => {
            // 33.33333333 GHS * 1234.56789123 NGN/GHS = 41152.2626736...
            // settles to 41152.26 NGN (HALF_UP at the 3rd decimal) — an
            // exact-Decimal product, not a double approximation.
            await upsertFxRate('GHS', 'NGN', '1234.56789123', new Date());
            const user = await mkUser(33);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'NGN', balance: 0 } });
            const { cycle } = await setupGroup(user, { payoutAmount: '33.33333333' });
            // Fund the pool exactly (funding proof requires PAID backing).
            const member = await prisma.susuMember.findFirst({ where: { susuGroupId: cycle.susuGroupId, userId: user.id } });
            await prisma.susuContribution.create({
                data: { cycleId: cycle.id, memberId: member.id, userId: user.id, amountUsdc: '33.33333333', status: 'PAID' },
            });
            await prisma.susuCycle.update({ where: { id: cycle.id }, data: { status: 'COLLECTING_GRACE' } });

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-scale-4`)
                .send({ cycleId: cycle.id, targetCurrency: 'NGN' });
            expect(res.status).toBe(200);
            expect(res.body.payout.targetAmount).toBe('41152.26');
            expect(res.body.payout.targetAmount).not.toMatch(/e/i); // never scientific notation

            // The SAME settled value was credited, persisted and returned.
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'NGN' } } });
            expect(wallet.balance.toString()).toBe('41152.26');
            const snapshot = await prisma.crossBorderFxSnapshot.findFirst({ where: { cycleId: cycle.id, userId: user.id } });
            expect(snapshot.baseAmount.toString()).toBe('41152.26');
            expect(snapshot.rate.toString()).toBe('1234.56789123');
        });

        // DUST-SETTLEMENT GUARD supersedes the original pinned behavior
        // here (owner policy on #369): a payout below the target currency's
        // settlement precision no longer COMPLETES as a zero-value PAID_OUT
        // — it is refused with 400 DUST_SETTLEMENT before the transition.
        // Refusing subsumes the original serialization guarantee: a payout
        // that never executes can never credit an exponential value.
        test('a dust payout is refused outright — never settles, never credits scientific notation', async () => {
            await upsertFxRate('GHS', 'USD', 0.08, new Date());
            const user = await mkUser(34);
            seeded.userIds.push(user.id);
            await prisma.currencyWallet.create({ data: { userId: user.id, currency: 'USD', balance: 0 } });
            const { cycle } = await setupGroup(user, { payoutAmount: '0.00000001' });
            const member = await prisma.susuMember.findFirst({ where: { susuGroupId: cycle.susuGroupId, userId: user.id } });
            await prisma.susuContribution.create({
                data: { cycleId: cycle.id, memberId: member.id, userId: user.id, amountUsdc: '0.00000001', status: 'PAID' },
            });
            await prisma.susuCycle.update({ where: { id: cycle.id }, data: { status: 'COLLECTING_GRACE' } });

            mockAuthUserId = user.id;
            const res = await request(app).post('/api/cross-border-susu/payout')
                .set('idempotency-key', `${MARK}-scale-5`)
                .send({ cycleId: cycle.id, targetCurrency: 'USD' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('DUST_SETTLEMENT');
            // 0.00000001 GHS * 0.08 = 8e-10 USD — below USD settlement
            // precision, so it is dust: no credit, no snapshot, no
            // transition. The cycle stays collectable.
            const wallet = await prisma.currencyWallet.findUnique({ where: { userId_currency: { userId: user.id, currency: 'USD' } } });
            expect(parseFloat(wallet.balance)).toBeCloseTo(0, 6);
            const snapshot = await prisma.crossBorderFxSnapshot.findFirst({ where: { cycleId: cycle.id, userId: user.id } });
            expect(snapshot).toBeNull();
            const row = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
            expect(row.status).toBe('COLLECTING_GRACE');
        });
    });

    // ── SETTLEMENT SCALE (Blocker B) — shared vault ────────────────────────
    //
    // The vault completion threshold and the cancel refunds previously ran
    // through parseFloat: a Decimal(20, 8) row demoted to a JS double.
    // These regressions pin the exact-Decimal behavior at the boundaries
    // where a double provably differs (20-significant-digit values, 8-dp
    // deposits, threshold-at-exact-target).
    describe('Shared vault — settlement scale on deposit, completion and refund', () => {
        test('an exact 8-dp deposit survives the request/persistence/response cycle bit-for-bit', async () => {
            const owner = await mkUser(40);
            const member = await mkUser(41, { available: 1 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: { name: `${MARK} scale`, targetAmountUsdc: 1000, creatorId: owner.id, members: { create: [{ userId: member.id, role: 'CONTRIBUTOR' }] } },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const res = await request(app).post(`/api/shared-vaults/${vault.id}/deposit`)
                .set('idempotency-key', `${MARK}-scale-dep-1`)
                .send({ amountUsdc: '0.12345678' });
            expect(res.status).toBe(200);

            // Response carries exact fixed-notation strings.
            expect(res.body.data.myContribution).toBe('0.12345678');
            expect(res.body.data.newVaultTotal).toBe('0.12345678');

            // The DB moved the exact Decimal, not a double.
            const u = await prisma.user.findUnique({ where: { id: member.id } });
            expect(u.availableBalance.toString()).toBe('0.87654322');
            expect(u.escrowLockedBalance.toString()).toBe('0.12345678');
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id }, include: { members: true } });
            expect(v.currentAmountUsdc.toString()).toBe('0.12345678');
            expect(v.members[0].contributedUsdc.toString()).toBe('0.12345678');
        });

        test('an over-precision deposit is REFUSED — nothing moves', async () => {
            const owner = await mkUser(42);
            const member = await mkUser(43, { available: 1 });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: { name: `${MARK} over`, targetAmountUsdc: 1000, creatorId: owner.id, members: { create: [{ userId: member.id, role: 'CONTRIBUTOR' }] } },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const res = await request(app).post(`/api/shared-vaults/${vault.id}/deposit`)
                .set('idempotency-key', `${MARK}-scale-dep-2`)
                .send({ amountUsdc: '0.000000001' }); // 9 dp — beyond USDC scale
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('AMOUNT_PRECISION_EXCEEDED');

            const u = await prisma.user.findUnique({ where: { id: member.id } });
            expect(u.availableBalance.toString()).toBe('1');
            expect(u.escrowLockedBalance.toString()).toBe('0');
            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id }, include: { members: true } });
            expect(v.currentAmountUsdc.toString()).toBe('0');
            expect(v.members[0].contributedUsdc.toString()).toBe('0');
        });

        test('completion flips on an EXACT Decimal threshold (8-dp target reached exactly)', async () => {
            const owner = await mkUser(44);
            const member = await mkUser(45, { available: '123.45678912' });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: { name: `${MARK} thr`, targetAmountUsdc: '123.45678912', creatorId: owner.id, members: { create: [{ userId: member.id, role: 'CONTRIBUTOR' }] } },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = member.id;
            const res = await request(app).post(`/api/shared-vaults/${vault.id}/deposit`)
                .set('idempotency-key', `${MARK}-scale-dep-3`)
                .send({ amountUsdc: '123.45678912' });
            expect(res.status).toBe(200);

            const v = await prisma.sharedVault.findUnique({ where: { id: vault.id } });
            // currentAmount == target EXACTLY (gte on exact Decimals).
            expect(v.status).toBe('COMPLETED');
            expect(v.completedAt).not.toBeNull();
            expect(v.currentAmountUsdc.toString()).toBe('123.45678912');
        });

        test('a 20-significant-digit contribution refunds the EXACT deposited amount (a double provably differs)', async () => {
            // 12345678901.12345678 needs all 20 digits of Decimal(20, 8);
            // parseFloat renders it 12345678901.12345695 — a DIFFERENT
            // number. The refund must move the deposited value exactly.
            const contributed = '12345678901.12345678';
            const owner = await mkUser(46, { locked: contributed });
            const member = await mkUser(47, { locked: contributed });
            seeded.userIds.push(owner.id, member.id);
            const vault = await prisma.sharedVault.create({
                data: {
                    name: `${MARK} refund`, targetAmountUsdc: '99999999999', creatorId: owner.id,
                    members: { create: [
                        { userId: owner.id, role: 'OWNER', contributedUsdc: contributed },
                        { userId: member.id, contributedUsdc: contributed },
                    ] },
                },
            });
            seeded.vaultIds.push(vault.id);

            mockAuthUserId = owner.id;
            const res = await request(app).delete(`/api/shared-vaults/${vault.id}`);
            expect(res.status).toBe(200);

            const ownerRow = await prisma.user.findUnique({ where: { id: owner.id } });
            const memberRow = await prisma.user.findUnique({ where: { id: member.id } });
            // EXACT refund — the persisted Decimal, not a double of it.
            expect(ownerRow.availableBalance.toString()).toBe(contributed);
            expect(ownerRow.escrowLockedBalance.toString()).toBe('0');
            expect(memberRow.availableBalance.toString()).toBe(contributed);
            expect(memberRow.escrowLockedBalance.toString()).toBe('0');

            // The ledger lines carry the exact amounts too (double-entry:
            // debit the released restriction, credit the liability — each
            // line exactly the deposited Decimal).
            const refundLines = await prisma.journalEntry.findMany({
                where: { entryType: 'SHARED_VAULT_REFUND', relatedEntityId: vault.id },
                select: { debit: true, credit: true },
            });
            expect(refundLines.length).toBe(4); // 2 lines per refunded member
            // Double-entry: each posting balances — one debit line and one
            // credit line, each carrying the EXACT deposited Decimal (a
            // parseFloat refund would have persisted 12345678901.12345695).
            const movement = (e) => (e.debit.gt(0) ? e.debit : e.credit);
            expect(refundLines.every(e => movement(e).toString() === contributed)).toBe(true);
            const balanced = refundLines.reduce((sum, e) => sum.plus(e.debit).minus(e.credit), new (require('@prisma/client').Prisma).Decimal(0));
            expect(balanced.isZero()).toBe(true);
        });
    });
});
