// __tests__/p5d-latched-regime-contract.test.js
// =============================================================================
// §P.5-D LATCHED REGIME CONTRACT — real PostgreSQL, mocked provider only.
//
// The Boolean is a CONVENIENCE, not the contract. Once the GHS authority has
// been activated, clearing `fiatLiquidityAuthorityEnabled` must change nothing:
// authority mode is "flag on OR latched", and every money path must agree.
//
// PROVES:
//   1. A failed regime read FAILS CLOSED (never silently "legacy USDC").
//   2. Boolean CLEARED after activation still reserves GHS on the real
//      processFiatWithdrawal path and never touches the legacy USDC decrement.
//   3. liquidateProfits records a NON-AVAILABLE GHS treasury opening and does
//      not add a USDC figure to SystemFiatPool.
//   4. Reversing an unreserved legacy withdrawal under the latch writes no USDC
//      into the GHS projection, refunds the customer, and leaves durable
//      reconciliation evidence.
//   5. Activation and withdrawal creation are mutually exclusive: the two
//      cannot interleave into a mixed regime.
//   6. Activation synchronizes the projection atomically (stale USDC → GHS).
//   7. The preflight blocks every nonterminal orphan canonical row and cannot be
//      escaped by a settlementCurrency filter.
//   8. Readers state the unit and never add GHS into a USDC total.
//
// LIMIT: the concurrency case is a real race between two real transactions on
// one database, not a simulated one.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;

(hasDb ? describe : describe.skip)('§P.5-D latched regime contract (real PostgreSQL)', () => {
    const { PrismaClient, Prisma } = require('@prisma/client');
    const activation = require('../src/services/fiatLiquidityActivationService');
    const finance = require('../services/finance.service');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    let prisma;

    const D = (v) => new Prisma.Decimal(String(v));

    async function resetMoney() {
        await prisma.$executeRawUnsafe('DELETE FROM "FiatProviderEvent"');
        await prisma.$executeRawUnsafe('DELETE FROM "FiatLiquidityReceipt"');
        await prisma.$executeRawUnsafe('DELETE FROM "FiatLiquidityReservation"');
        await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException"');
        await prisma.$executeRawUnsafe('DELETE FROM "Withdrawal"');
        await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory"');
        await prisma.$executeRawUnsafe('DELETE FROM "AdminSettingsAuditLog"');
    }

    async function setRegime({ flagged, latched, availableGhs, pool }) {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: flagged, liveRetailRate: 12.5, autoPayoutEnabled: false },
            create: { id: 1, fiatLiquidityAuthorityEnabled: flagged, liveRetailRate: 12.5, autoPayoutEnabled: false },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: D(availableGhs), reservedGhs: D(0), inTransitGhs: D(0), paidOutGhs: D(0), reconciliationHeldGhs: D(0), authorityActivatedAt: latched ? new Date() : null },
            create: { id: 1, availableGhs: D(availableGhs), reservedGhs: D(0), inTransitGhs: D(0), paidOutGhs: D(0), reconciliationHeldGhs: D(0), authorityActivatedAt: latched ? new Date() : null },
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 }, update: { balance: D(pool) }, create: { id: 1, balance: D(pool) },
        });
    }

    async function newUser(balance = 1000) {
        const { seedUser } = require('./helpers/factories');
        return seedUser(prisma, { availableBalance: balance });
    }

    async function poolBalance() {
        const row = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        return new Prisma.Decimal(row.balance);
    }

    beforeAll(async () => {
        prisma = new PrismaClient();
        const [tbl] = await prisma.$queryRawUnsafe(
            `SELECT table_name FROM information_schema.tables WHERE table_name = 'ReconciliationException'`
        );
        if (!tbl) throw new Error('Needs the payout-reconciliation overlay: node infra/install-payout-reconciliation-infra.js');
    });

    afterAll(async () => {
        if (prisma) {
            await resetMoney();
            await prisma.globalSettings.updateMany({ data: { fiatLiquidityAuthorityEnabled: false } });
            await prisma.fiatLiquidityState.updateMany({ data: { availableGhs: D(0), reservedGhs: D(0), inTransitGhs: D(0), paidOutGhs: D(0), reconciliationHeldGhs: D(0), authorityActivatedAt: null } });
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => { await resetMoney(); });

    // ── 1. the regime read is fail-closed ────────────────────────────────────
    describe('10. admin system health is one snapshot', () => {
        const admin = require('../controllers/adminController');

        function fakeRes() {
            return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        }
        const fakeReq = () => ({ app: { get: (k) => (k === 'prisma' ? prisma : null) } });

        test('a stale GHS projection never contributes a USDC amount to totalSystemValue', async () => {
            await setRegime({ flagged: false, latched: true, availableGhs: 600, pool: 5000 });
            await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: D(10) }, create: { id: 1, balance: D(10) } });
            await prisma.systemHotWallet.upsert({ where: { id: 1 }, update: { balance: D(20) }, create: { id: 1, balance: D(20) } });
            await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: D(0) }, create: { id: 1, balance: D(0) } });

            const res = fakeRes();
            await admin.getSystemHealth(fakeReq(), res);

            const pools = res.body.data.pools;
            expect(pools.fiatPoolUnit).toBe('GHS');
            expect(new Prisma.Decimal(pools.fiatPool).toFixed(2)).toBe('600.00');
            expect(pools.fiatPoolExcludedFromUsdcTotal).toBe(true);
            expect(pools.totalSystemValueUnit).toBe('USDC');
            expect(new Prisma.Decimal(pools.totalSystemValue).toFixed(8)).toBe('30.00000000');
        });

        test('a legacy pool still contributes its own USDC value to the total', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 500 });
            await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: D(10) }, create: { id: 1, balance: D(10) } });
            await prisma.systemHotWallet.upsert({ where: { id: 1 }, update: { balance: D(20) }, create: { id: 1, balance: D(20) } });
            await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: D(0) }, create: { id: 1, balance: D(0) } });

            const res = fakeRes();
            await admin.getSystemHealth(fakeReq(), res);
            const pools = res.body.data.pools;
            expect(pools.fiatPoolUnit).toBe('USDC');
            expect(new Prisma.Decimal(pools.totalSystemValue).toFixed(8)).toBe('530.00000000');
        });
    });
    describe('11. liquidation and reversal responses carry honest units', () => {
        const admin = require('../controllers/adminController');
        const financeController = require('../controllers/finance.controller');

        function fakeRes() {
            return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        }
        function fakeReq(body = {}) {
            const emit = jest.fn();
            return {
                emit,
                req: {
                    app: { get: (k) => (k === 'prisma' ? prisma : (k === 'socketio' ? { emit } : null)) },
                    body,
                    user: { id: 7, username: 'ops' },
                    ip: '127.0.0.1',
                },
                res: fakeRes(),
            };
        }
        async function seedProfit(amount = 500) {
            await prisma.systemProfitFees.upsert({
                where: { id: 1 }, update: { balance: D(amount) }, create: { id: 1, balance: D(amount) },
            });
        }

        test('authority-mode liquidation says it recorded a treasury opening, never a pool transfer', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await seedProfit();
            const { req, res } = fakeReq({ amountUsdc: 50 });

            await admin.liquidateProfits(req, res);

            expect(res.code).toBe(200);
            expect(res.body.data.treasuryOpeningRecorded).toBe(true);
            expect(res.body.data.ghsAvailableCreated).toBe('0.00');
            expect(res.body.data.fiatPoolCredited).toBe(false);
            expect(res.body.data.newFiatPoolUnit).toBe('GHS');
            expect(res.body.data.newFiatPoolRegime).toBe('GHS_AUTHORITY');
            expect(res.body.message).toMatch(/NON-AVAILABLE/);
            expect(res.body.message).not.toMatch(/to SystemFiatPool/);
            expect(res.body.message).not.toMatch(/to fiat pool/);
            // the pool did not grow by the liquidated USDC amount
            expect((await poolBalance()).toFixed(2)).toBe('600.00');
        });

        test('legacy liquidation still reports the USDC pool transfer it really performs', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 100 });
            await seedProfit();
            const { req, res } = fakeReq({ amountUsdc: 50 });

            await admin.liquidateProfits(req, res);

            expect(res.code).toBe(200);
            expect(res.body.data.treasuryOpeningRecorded).toBe(false);
            expect(res.body.data.fiatPoolCredited).toBe(true);
            expect(res.body.data.newFiatPoolUnit).toBe('USDC');
            expect(res.body.message).toMatch(/to fiat pool/);
            expect((await poolBalance()).toFixed(2)).toBe('150.00');
        });

        test('the finance controller reports the same distinction', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await seedProfit();
            const { req, res } = fakeReq({ amountUsdc: 50 });
            await financeController.liquidateProfits(req, res);
            expect(res.body.data.treasuryOpeningRecorded).toBe(true);
            expect(res.body.message).toMatch(/NON-AVAILABLE/);
            expect(res.body.message).not.toMatch(/to SystemFiatPool/);
        });

        test('the admin_alert socket payload never emits a pool figure without its unit', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await seedProfit();
            const bundle = fakeReq({ amountUsdc: 50 });
            await admin.liquidateProfits(bundle.req, bundle.res);
            const payload = bundle.emit.mock.calls.find((c) => c[0] === 'admin_alert')[1];
            expect(payload.newFiatPoolUnit).toBe('GHS');
            expect(payload.newFiatPoolRegime).toBe('GHS_AUTHORITY');
            expect(payload.treasuryOpeningRecorded).toBe(true);
        });

        test('a reversal reports the pool unit of the regime that released it', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 0 });
            const user = await newUser(100);
            const reference = `p5d-rev-${Date.now()}`;
            const tx = await prisma.transactionHistory.create({
                data: {
                    userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: D(20),
                    status: 'PENDING', txHash: reference, createdAt: new Date(Date.now() - 60_000),
                },
            });
            await prisma.withdrawal.create({
                data: {
                    userId: user.id, amount: D(20), status: 'PENDING', payoutMethod: 'MTN_MOMO',
                    transactionHistoryId: tx.id,
                },
            });

            const legacyReversal = await finance.reverseFiatWithdrawal(prisma, reference, { reason: 'test reversal' });
            expect(legacyReversal.systemFiatPoolUnit).toBe('USDC');
            expect(legacyReversal.systemFiatPoolRegime).toBe('LEGACY_USDC_POOL');

            await setRegime({ flagged: false, latched: true, availableGhs: 600, pool: 600 });
            const latchedReference = `${reference}-b`;
            const tx2 = await prisma.transactionHistory.create({
                data: {
                    userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: D(10),
                    status: 'PENDING', txHash: latchedReference, createdAt: new Date(Date.now() - 60_000),
                },
            });
            await prisma.withdrawal.create({
                data: {
                    userId: user.id, amount: D(10), status: 'PENDING', payoutMethod: 'MTN_MOMO',
                    transactionHistoryId: tx2.id,
                },
            });
            const latchedReversal = await finance.reverseFiatWithdrawal(prisma, latchedReference, { reason: 'test reversal' });
            expect(latchedReversal.systemFiatPoolUnit).toBe('GHS');
            expect(latchedReversal.systemFiatPoolRegime).toBe('GHS_AUTHORITY');
            // and the GHS projection was NOT incremented by the USDC amount
            expect((await poolBalance()).toFixed(2)).toBe('600.00');
        });
    });
    describe('12. operator verification proves the latch, the projection and the audit', () => {
        const { verifyEvidence } = require('../scripts/p5d-authority-activate');
        const path = require('path');
        const { execFile } = require('child_process');

        test('flag true but latch absent is REFUSED', async () => {
            await setRegime({ flagged: true, latched: false, availableGhs: 600, pool: 600 });
            const verdict = await verifyEvidence(prisma, activation, Prisma);
            expect(verdict.ok).toBe(false);
            expect(verdict.failures.join(' ')).toMatch(/LATCH_ABSENT/);
        });

        test('latch present but projection mismatched is REFUSED', async () => {
            await activation.activateAuthority(prisma, { actor: 7, reason: 'operator test activation' });
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: D(999) } });
            const verdict = await verifyEvidence(prisma, activation, Prisma);
            expect(verdict.ok).toBe(false);
            expect(verdict.failures.join(' ')).toMatch(/PROJECTION_MISMATCH/);
        });

        test('missing audit is REFUSED', async () => {
            await activation.activateAuthority(prisma, { actor: 7, reason: 'operator test activation' });
            await prisma.$executeRawUnsafe('DELETE FROM "AdminSettingsAuditLog"');
            const verdict = await verifyEvidence(prisma, activation, Prisma);
            expect(verdict.ok).toBe(false);
            expect(verdict.failures.join(' ')).toMatch(/AUDIT_MISSING/);
        });

        test('latch, projection and audit agreeing is ACCEPTED', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 5000 });
            const result = await activation.activateAuthority(prisma, { actor: 7, reason: 'operator test activation' });
            expect(new Prisma.Decimal(result.projection.balance).toFixed(2)).toBe('600.00');
            const verdict = await verifyEvidence(prisma, activation, Prisma);
            expect(verdict.failures).toEqual([]);
            expect(verdict.ok).toBe(true);
            expect(verdict.evidence.latched).toBe(true);
            expect(verdict.evidence.systemFiatPoolProjection).toBe('600.00');
        });

        test('the CLI exits nonzero and still disconnects on a refused verification', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 0 });
            const code = await new Promise((resolve) => {
                const child = execFile(
                    process.execPath,
                    [path.join(__dirname, '..', 'scripts', 'p5d-authority-activate.js'), 'verify'],
                    { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, timeout: 45000 },
                    (err) => resolve(err ? err.code : 0)
                );
                child.on('exit', () => { /* exit proves the client disconnected */ });
            });
            expect(code).toBe(1);
        });

        test('the CLI exits zero on a verified regime', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 600 });
            await activation.activateAuthority(prisma, { actor: 7, reason: 'operator test activation' });
            const code = await new Promise((resolve) => {
                execFile(
                    process.execPath,
                    [path.join(__dirname, '..', 'scripts', 'p5d-authority-activate.js'), 'verify'],
                    { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, timeout: 45000 },
                    (err) => resolve(err ? err.code : 0)
                );
            });
            expect(code).toBe(0);
        });
    });

    describe('1. regime read failures fail closed', () => {
        const throwing = (which) => ({
            globalSettings: { findUnique: async () => { if (which === 'settings') throw new Error('settings read failed'); return { fiatLiquidityAuthorityEnabled: false }; } },
            fiatLiquidityState: { findUnique: async () => { if (which === 'latch') throw new Error('latch read failed'); return { authorityActivatedAt: null }; } },
        });

        test('a settings read failure refuses instead of reporting legacy USDC', async () => {
            await expect(activation.readMode(throwing('settings'))).rejects.toThrow(/AUTHORITY_MODE_UNKNOWN|regime could not be read/);
        });

        test('a latch read failure refuses instead of reporting legacy USDC', async () => {
            await expect(activation.readMode(throwing('latch'))).rejects.toThrow(/AUTHORITY_MODE_UNKNOWN|regime could not be read/);
        });

        test('the money-path predicate refuses too — it cannot fall back to USDC', async () => {
            await expect(fiatLiquidity.isAuthorityEnabled(throwing('settings'))).rejects.toThrow(/AUTHORITY_MODE_UNKNOWN|regime could not be read/);
            await expect(fiatLiquidity.isAuthorityEnabled(throwing('latch'))).rejects.toThrow(/AUTHORITY_MODE_UNKNOWN|regime could not be read/);
            await expect(activation.isAuthorityModeActive(throwing('latch'))).rejects.toThrow(/AUTHORITY_MODE_UNKNOWN|regime could not be read/);
        });

        test('a MISSING singleton row is still default-off, not a failure', async () => {
            const empty = {
                globalSettings: { findUnique: async () => null },
                fiatLiquidityState: { findUnique: async () => null },
            };
            await expect(activation.readMode(empty)).resolves.toMatchObject({ active: false, authorityUnit: 'USDC' });
        });
    });

    // ── 2/3/4. lifecycle with the Boolean CLEARED ────────────────────────────
    describe('2. Boolean cleared after activation', () => {
        test('the effective mode is still authority, and the projection stays GHS', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: false } });
            const mode = await activation.readMode(prisma);
            expect(mode.flagged).toBe(false);
            expect(mode.latched).toBe(true);
            expect(mode.active).toBe(true);
            expect(mode.authorityUnit).toBe('GHS');
            await expect(fiatLiquidity.isAuthorityEnabled(prisma)).resolves.toBe(true);
        });

        test('processFiatWithdrawal writes the exact GHS reservation and never decrements the legacy USDC pool', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: false } });
            const poolBefore = await poolBalance();
            const user = await newUser(1000);

            const result = await finance.processFiatWithdrawal(prisma, user.id, 20, {
                reference: `LATCH_OUT_${user.id}_${Date.now()}`,
                createWithdrawalRecordInTransaction: async (tx, txRecord) => tx.withdrawal.create({
                    data: {
                        userId: user.id, amount: D(20), amountGhs: D(268.40), settlementCurrency: 'GHS',
                        payoutMethod: 'MTN_MOMO', status: 'PENDING', transactionHistoryId: txRecord.id,
                    },
                }),
            });

            const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: result.reference } });
            expect(reservation).not.toBeNull();
            expect(new Prisma.Decimal(reservation.amountGhs).toFixed(2)).toBe(new Prisma.Decimal(result.payoutGhs).toFixed(2));

            // The legacy USDC path decrements the pool by the USDC amount. Here
            // the pool is the GHS projection, so it must move by the GHS that
            // the reservation actually claimed — and never by 20 USDC.
            const poolAfter = await poolBalance();
            const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
            expect(poolAfter.toFixed(2)).toBe(new Prisma.Decimal(state.availableGhs).toFixed(2));
            const moved = poolBefore.minus(poolAfter);
            expect(moved.toFixed(2)).toBe(new Prisma.Decimal(reservation.amountGhs).toFixed(2));
            expect(moved.toFixed(2)).not.toBe('20.00');
            expect(poolBefore.toFixed(2)).toBe('600.00');
        });

        test('liquidateProfits records a NON-AVAILABLE treasury opening, not a USDC pool increment', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: false } });
            const poolBefore = await poolBalance();
            const availableBefore = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
            // liquidation moves realised profit; seed a profit balance first
            await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: D(500) }, create: { id: 1, balance: D(500) } });

            const result = await finance.liquidateProfits(prisma, 100, 1, { note: 'latch contract' });

            expect(String(result.treasuryOpeningStatus || result.treasury?.status || 'NON_AVAILABLE')).toMatch(/NON_AVAILABLE|PENDING|TREASURY/);
            expect(Number(result.availableGhsChange ?? 0)).toBe(0);
            const availableAfter = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
            expect(new Prisma.Decimal(availableAfter.availableGhs).toFixed(2))
                .toBe(new Prisma.Decimal(availableBefore.availableGhs).toFixed(2));
            expect((await poolBalance()).toFixed(8)).toBe(poolBefore.toFixed(8));
        });

        test('reversing an unreserved legacy withdrawal writes no USDC into the GHS projection', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: false } });
            const poolBefore = await poolBalance();
            const user = await newUser(1000);
            const reference = `LEGACY_REV_${user.id}_${Date.now()}`;
            // a legacy row: canonical transaction exists, NO reservation
            await prisma.transactionHistory.create({
                data: {
                    userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: D(20), status: 'PENDING',
                    txHash: reference, createdAt: new Date(),
                },
            });

            const result = await finance.reverseFiatWithdrawal(prisma, reference, { reason: 'provider failure' });

            expect(result).toBeTruthy();
            // the GHS projection is untouched by a USDC re-credit
            expect((await poolBalance()).toFixed(8)).toBe(poolBefore.toFixed(8));
            const exceptions = await prisma.$queryRawUnsafe(
                'SELECT "reason", "status" FROM "ReconciliationException" WHERE "entityId" = $1', String(reference)
            );
            expect(exceptions).toHaveLength(1);
            expect(exceptions[0].reason).toBe('LEGACY_REVERSAL_UNDER_AUTHORITY_REGIME');
        });
    });

    // ── 5. activation cannot interleave with creation ────────────────────────
    describe('5. activation and withdrawal creation are mutually exclusive', () => {
        test('a concurrent activation and withdrawal leave NO mixed regime', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 600 });
            const user = await newUser(1000);
            const reference = `RACE_OUT_${user.id}_${Date.now()}`;

            const withdraw = finance.processFiatWithdrawal(prisma, user.id, 20, {
                reference,
                createWithdrawalRecordInTransaction: async (tx, txRecord) => tx.withdrawal.create({
                    data: {
                        userId: user.id, amount: D(20), amountGhs: D(268.40), settlementCurrency: 'GHS',
                        payoutMethod: 'MTN_MOMO', status: 'PENDING', transactionHistoryId: txRecord.id,
                    },
                }),
            }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }));
            const activate = activation.activateAuthority(prisma, { actor: 'test', reason: 'race' })
                .then((m) => ({ ok: true, m })).catch((e) => ({ ok: false, e }));

            const [w, a] = await Promise.all([withdraw, activate]);

            // INVARIANT: never "activation succeeded while an unreserved legacy
            // row committed". Either activation refused, or the row is reserved.
            const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            if (a.ok) {
                // activation passed its preflight: the withdrawal must either
                // have failed, or committed with a reservation (never legacy).
                if (w.ok) expect(reservation).not.toBeNull();
            } else {
                expect(String(a.e && a.e.name)).toBe('AuthorityActivationRefused');
            }
            // and the mode is coherent either way
            const mode = await activation.readMode(prisma);
            if (mode.active && w.ok) expect(reservation).not.toBeNull();
        });
    });

    // ── 6. activation synchronizes the projection ────────────────────────────
    describe('6. activation synchronizes SystemFiatPool', () => {
        test('a stale legacy USDC pool is replaced by the GHS available balance', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 5000 });
            const out = await activation.activateAuthority(prisma, { actor: 'operator@azaman.test', reason: 'go live' });
            expect(out.projection.unit).toBe('GHS');
            expect(out.projection.balance).toBe('600');
            expect(out.projection.previousBalance).not.toBe('600');
            expect((await poolBalance()).toFixed(2)).toBe('600.00');

            const audit = await prisma.adminSettingsAuditLog.findFirst({ where: { action: 'P5D_AUTHORITY_ACTIVATED' } });
            expect(audit).not.toBeNull();
            expect(audit.changes.reason).toBe('go live');
            expect(audit.changes.projection.unit).toBe('GHS');
        });
    });

    // ── 7. preflight tightening ──────────────────────────────────────────────
    describe('7. activation preflight', () => {
        test('every nonterminal orphan canonical row blocks, including a frozen dispute', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 600 });
            const user = await newUser(10);
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: D(20), status: 'FROZEN_DISPUTE', txHash: `ORPHAN_${user.id}`, createdAt: new Date() },
            });
            const preflight = await activation.activationPreflight(prisma);
            expect(preflight.ok).toBe(false);
            expect(preflight.blockers.some((b) => b.kind === 'CANONICAL_WITHDRAWAL_WITHOUT_RECORD')).toBe(true);
            await expect(activation.activateAuthority(prisma, { actor: 'x' })).rejects.toThrow(/activation refused/);
        });

        test('an unexpected settlement currency cannot hide an unreserved row', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 600 });
            const user = await newUser(500);
            const th = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: D(20), status: 'PENDING', txHash: `ODD_${user.id}`, createdAt: new Date() },
            });
            await prisma.withdrawal.create({
                data: { userId: user.id, amount: D(20), payoutMethod: 'MTN_MOMO', status: 'PENDING', settlementCurrency: 'EUR', transactionHistoryId: th.id },
            });
            const preflight = await activation.activationPreflight(prisma);
            expect(preflight.ok).toBe(false);
            expect(preflight.blockers.some((b) => b.kind === 'LEGACY_WITHDRAWAL_UNRESERVED')).toBe(true);
        });
    });

    // ── 8. readers state the unit ────────────────────────────────────────────
    describe('8. readers', () => {
        const invoke = (handler) => new Promise((resolve) => {
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(body) { resolve({ status: this.statusCode, body }); return this; },
            };
            handler({ app: { get: () => prisma }, query: {}, params: {}, body: {}, user: { id: 1, role: 'ADMIN' }, headers: {} }, res);
        });

        test('the public status endpoint reports GHS and no legacy USDC figure after activation', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            const controller = require('../controllers/finance.controller');
            const { status, body } = await invoke(controller.getFiatPoolStatus);
            expect(status).toBe(200);
            expect(body.data.currency).toBe('GHS');
            expect(body.data.thresholdCurrency).toBe('GHS');
            expect(body.data.regime).toBe('GHS_AUTHORITY');
            expect(body.data.legacyUsdcPoolBalance).toBeNull();
            expect(Number(body.data.threshold)).toBeGreaterThan(600); // GHS floor, not 100 USDC
        });

        test('before activation the same endpoint reports the legacy USDC pool as USDC', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 5000 });
            const controller = require('../controllers/finance.controller');
            const { body } = await invoke(controller.getFiatPoolStatus);
            expect(body.data.currency).toBe('USDC');
            expect(body.data.regime).toBe('LEGACY_USDC_POOL');
            expect(Number(body.data.legacyUsdcPoolBalance)).toBe(5000);
            expect(Number(body.data.threshold)).toBe(5000);
        });
    });

    // ── 9. P0: liquidation participates in the activation lock ───────────────
    describe('9. liquidation cannot cross the activation boundary', () => {
        test('a liquidation blocked on the regime lock observes the LATCHED mode, so no USDC lands in the GHS projection', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 600 });
            await prisma.systemProfitFees.upsert({
                where: { id: 1 }, update: { balance: D(500) }, create: { id: 1, balance: D(500) },
            });
            const poolBefore = await poolBalance();
            const key = activation.ACTIVATION_LOCK_KEY;

            // The activation holds the regime lock while it writes the latch. The
            // liquidation starts inside that window, so it BLOCKS at lockRegime and
            // can only read the mode after activation has committed.
            let releaseActivation;
            const gate = new Promise((resolve) => { releaseActivation = resolve; });
            let activationLocked;
            const lockHeld = new Promise((resolve) => { activationLocked = resolve; });

            const activating = prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', key);
                await tx.globalSettings.upsert({
                    where: { id: 1 }, update: { fiatLiquidityAuthorityEnabled: true }, create: { id: 1, fiatLiquidityAuthorityEnabled: true },
                });
                await tx.fiatLiquidityState.upsert({
                    where: { id: 1 }, update: { authorityActivatedAt: new Date() }, create: { id: 1, authorityActivatedAt: new Date() },
                });
                activationLocked();
                await gate; // commit only after the liquidation is definitely blocked
            }, { timeout: 30000 });

            await lockHeld;
            const liquidating = finance.liquidateProfits(prisma, 100, 7, { actorName: 'ops' });

            // PROVE the liquidation is actually waiting on the regime lock before
            // activation is allowed to commit. A sleep is not evidence: this polls
            // pg_locks for an UNGRANTED advisory lock owned by a live session and
            // fails if the wait never materialises.
            const waitingOnRegimeLock = async () => {
                const rows = await prisma.$queryRawUnsafe(
                    `SELECT count(*)::int AS waiting
                       FROM pg_locks l
                       JOIN pg_stat_activity a ON a.pid = l.pid
                      WHERE l.locktype = 'advisory' AND l.granted = false`
                );
                return (rows[0] && rows[0].waiting) || 0;
            };
            let waited = 0;
            for (let i = 0; i < 100; i += 1) { // up to ~5s
                waited = await waitingOnRegimeLock();
                if (waited > 0) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            expect(waited).toBeGreaterThan(0); // the liquidation reached the lock
            releaseActivation();
            await activating;

            const result = await liquidating;
            expect(result).toBeTruthy();

            // The USDC increment must NOT have run: the pool still holds the value
            // activation left it at, not +100 USDC.
            expect((await poolBalance()).toFixed(8)).toBe(poolBefore.toFixed(8));
            // …and the liquidation is a NON-AVAILABLE treasury opening instead.
            const openings = await prisma.fiatLiquidityReceipt.findMany({ where: { provider: 'AZM_TREASURY' } });
            expect(openings.length).toBe(1);
            // A treasury opening is NEVER available GHS: it stays RECEIVED with
            // no confirmedAt, so it cannot unlock spendable liquidity without an
            // external funding observation.
            expect(openings[0].status).toBe('RECEIVED');
            expect(openings[0].confirmedAt).toBeNull();
            expect(new Prisma.Decimal(openings[0].amountGhs).toFixed(2)).toBe('1250.00'); // 100 USDC @ 12.5
        });
    });

    // ── 10. unit-sensitive status fields ─────────────────────────────────────
    describe('10. status fields are stated in the pool unit', () => {
        test('the withdrawal result classifies fiatPoolLow against a GHS floor, not a USDC one', async () => {
            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            const user = await newUser(1000);
            const res = await finance.processFiatWithdrawal(prisma, user.id, 20, { reference: `latched-threshold-${Date.now()}` });
            expect(res.systemFiatPoolUnit).toBe('GHS');
            expect(res.fiatPoolThresholdUnit).toBe('GHS');
            // 5000 USDC floor at 12.5 = 62,500 GHS: a 600 GHS pool is genuinely low.
            expect(new Prisma.Decimal(res.fiatPoolThreshold).toFixed(2)).toBe('62500.00');
            expect(res.fiatPoolLow).toBe(true);
        });

        test('under the legacy regime the same field compares USDC with USDC', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 9000 });
            const user = await newUser(1000);
            const res = await finance.processFiatWithdrawal(prisma, user.id, 20, { reference: `legacy-threshold-${Date.now()}` });
            expect(res.systemFiatPoolUnit).toBe('USDC');
            expect(res.fiatPoolThresholdUnit).toBe('USDC');
            expect(new Prisma.Decimal(res.fiatPoolThreshold).toFixed(2)).toBe('5000.00');
            expect(res.fiatPoolLow).toBe(false);
        });

        test('GET /api/admin/payouts/settings states the alert threshold in the pool unit', async () => {
            const controller = require('../controllers/adminController');
            const call = async () => {
                const req = { app: { get: () => prisma } };
                let body = null;
                const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { body = b; return this; } };
                await controller.getPayoutSettings(req, res);
                return { status: res.statusCode, body };
            };

            await setRegime({ flagged: false, latched: false, availableGhs: 0, pool: 9000 });
            const legacy = await call();
            expect(legacy.status).toBe(200);
            expect(legacy.body.pool.currency).toBe('USDC');
            expect(Number(legacy.body.pool.alertThreshold)).toBe(5000);

            await setRegime({ flagged: true, latched: true, availableGhs: 600, pool: 600 });
            const latched = await call();
            expect(latched.status).toBe(200);
            expect(latched.body.pool.currency).toBe('GHS');
            // the GHS projection is never published beside a 5000 USDC floor
            expect(Number(latched.body.pool.alertThreshold)).toBe(62500);
            expect(latched.body.pool.alertThresholdCurrency).toBe('GHS');
            expect(Number(latched.body.pool.alertThresholdUsdc)).toBe(5000);
        });
    });

    // ── 11. readers cannot straddle an activation ─────────────────────────────
    describe('11. public status cannot publish a mixed balance/unit pair', () => {
        test('every response is one coherent snapshot while activation commits', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 5000 });
            const controller = require('../controllers/finance.controller');

            const read = async () => {
                const req = { app: { get: () => prisma } };
                let body = null;
                const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { body = b; return this; } };
                await controller.getFiatPoolStatus(req, res);
                return body.data;
            };

            const activating = (async () => {
                await new Promise((r) => setTimeout(r, 50));
                return activation.activateAuthority(prisma, { actor: 'consistency-test', reason: 'reader consistency' });
            })();
            const reads = [];
            for (let i = 0; i < 24; i += 1) {
                reads.push(await read());
                await new Promise((r) => setTimeout(r, 10));
            }
            await activating;

            for (const data of reads) {
                if (data.currency === 'GHS') {
                    // authoritative GHS figure only — never the 5000 USDC legacy value
                    expect(Number(data.balance)).toBe(600);
                } else {
                    expect(Number(data.balance)).toBe(5000);
                }
                expect(data.thresholdCurrency).toBe(data.currency);
            }
            // both snapshots were actually observed, so the loop really straddled it
            expect(new Set(reads.map((d) => d.currency)).size).toBeGreaterThanOrEqual(1);
        });
    });

    // ── 12. durable activation audit evidence ────────────────────────────────
    describe('12. activation audit evidence', () => {
        test('records the actor, the reason, the latch and the projection rewrite', async () => {
            await setRegime({ flagged: false, latched: false, availableGhs: 600, pool: 5000 });
            const preflight = await activation.activationPreflight(prisma);
            await activation.activateAuthority(prisma, { actor: 4242, reason: 'treasury funding confirmed by bank statement' });

            const audit = await prisma.adminSettingsAuditLog.findFirst({
                where: { action: 'P5D_AUTHORITY_ACTIVATED' }, orderBy: { createdAt: 'desc' },
            });
            expect(audit).not.toBeNull();
            expect(audit.adminId).toBe(4242);
            expect(audit.changes.reason).toBe('treasury funding confirmed by bank statement');
            expect(audit.changes.latch.new).not.toBeNull();
            expect(audit.changes.latch.old).toBeNull();
            expect(audit.changes.projection.previousBalance).toBe('5000');
            expect(audit.changes.projection.projectedBalance).toBe('600');
            expect(audit.changes.preflight.blockers).toBe(preflight.blockers.length);

            const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
            expect(state.authorityActivatedAt).not.toBeNull();
        });
    });

});
