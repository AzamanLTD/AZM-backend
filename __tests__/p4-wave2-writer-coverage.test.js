// __tests__/p4-wave2-writer-coverage.test.js
// =============================================================================
// §P.4 wave-2 completeness — regression coverage for the final writer
// migrations and report/reconciliation accuracy fixes (PR review blockers
// #1, #4, #5, #6).
//
// Pre-fix defects proven absent here:
//   1. adminController.forceCancel reclassified escrow (SELL → vendor
//      unallocated, BUY → buyer available) with NO authoritative ledger
//      posting — the books silently diverged from the projections.
//   2. peerTransferController.fulfillTransferRequest moved money between
//      customer liabilities with NO posting (the sendFunds path was
//      migrated; the request-fulfillment path was not).
//   3. finance.service.processCryptoDeposit (legacy finance webhook)
//      credited balances with NO posting and NO representability gate.
//   4. SOURCE_FAMILIES escrow/dispute/unallocated entries were flagged
//      un-authoritative forever; PoR could never complete the restricted
//      denominator. Post-fix they are authoritative via the ledger
//      reclassification representation (reported for observability, NOT
//      added to the obligation-row denominator — the flow-based liability
//      X already counts those funds exactly once).
//   5. The PoR snapshot payload hardcoded stale P3 values
//      (restrictedObligationsTotal: null / modeled: false) even when the
//      composed report knew better.
//   6. Projection reconciliation covered available + escrow buckets but
//      not the dispute and vendor-unallocated wave-2 buckets.
// =============================================================================
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/azm_test?schema=public';
process.env.NODE_ENV = 'test';

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p4-wave2] TEST_DATABASE_URL not set — skipping real-DB suite.');

const { Prisma, PrismaClient } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const restrictedObligations = require('../services/restrictedObligationService');
const reconciliation = require('../services/ledgerReconciliationService');
const finance = require('../services/finance.service');
const adminController = require('../controllers/adminController');
const peerTransferController = require('../controllers/peerTransferController');
const proofOfReserves = require('../services/proofOfReservesIntegrityService');
const { seedUser } = require('./helpers/factories');

const D = (v) => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('§P.4 wave-2 writer coverage (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => { prisma = new PrismaClient(); });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "RestrictedObligation", "LedgerTransaction", "LedgerAccount", "JournalEntry", ' +
        '"ProofOfReservesSnapshot", "ProofOfReservesLeaf", "PeerTransfer", "Friendship", "DirectMessage", ' +
        '"TransactionHistory", "Trade", "Conversation", "Message", "AuditLog", "WalletAddress", "User", ' +
        '"SystemHotWallet", "SystemMasterCrypto", "SystemFiatPool", "SystemProfitFees", "GlobalSettings", "AdminProfitLog" ' +
        'RESTART IDENTITY CASCADE'
    );
    beforeEach(async () => { await TRUNCATE_ALL(); }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    const bal = async (code) => (await ledger.accountBalance(prisma, code)).balance;

    // Fund a ledger escrow account (projection bucket included) from a
    // clearing account — the canonical wave-2 seeding pattern.
    const fundEscrow = (ownerId, code, amount, entryType = 'ESCROW_LOCK') =>
        prisma.$transaction(async (tx) => {
            await ledger.ensureAccount(tx, code, { userId: ownerId });
            await ledger.post(tx, {
                idempotencyKey: `test:fund-escrow:${code}:${amount}`,
                entryType, description: 'test escrow funding',
                lines: [
                    { account: 'clearing:conversion', debit: String(amount) },
                    { account: code, credit: String(amount) },
                ],
            });
        });

    // ── 1. forceCancel: escrow reclassification posts authoritatively ─────────
    describe('admin forceCancel ledger coverage', () => {
        const makeRes = () => {
            const res = {};
            res.status = jest.fn().mockReturnValue(res);
            res.json = jest.fn().mockReturnValue(res);
            return res;
        };
        // A real admin user — forceCancel writes an ADMIN_INTERVENTION
        // message authored by the admin (FK on Message.senderId).
        let admin;
        beforeEach(async () => { admin = await seedUser(prisma, { availableBalance: 0, username: 'warroom_admin', email: 'warroom_admin@test.com' }); });
        const makeReq = (tradeId) => ({
            app: { get: (key) => (key === 'prisma' ? prisma : (key === 'socketio' ? { to: () => ({ emit: () => {} }) } : (key === 'emitBalanceUpdate' ? (async () => {}) : undefined))) },
            body: { tradeId: String(tradeId), adminNotes: 'war room override' },
            user: { id: admin.id, username: 'warroom_admin' },
            ip: '127.0.0.1',
        });
        const seedDisputedTrade = async ({ type, amountCrypto }) => {
            const buyer = await seedUser(prisma, { availableBalance: 0 });
            const vendor = await seedUser(prisma, { availableBalance: 0 });
            const trade = await prisma.trade.create({
                data: {
                    crypto: 'USDC', type, status: 'DISPUTED',
                    amountCrypto: new Prisma.Decimal(amountCrypto),
                    amountFiat: new Prisma.Decimal(amountCrypto * 16),
                    rate: new Prisma.Decimal(16),
                    expiresAt: new Date(Date.now() + 3600_000),
                    userId: buyer.id, vendorId: vendor.id,
                },
            });
            return { buyer, vendor, trade };
        };

        it('SELL ad: vendor escrow returns to unallocated WITH its authoritative posting, exactly once', async () => {
            const { vendor, trade } = await seedDisputedTrade({ type: 'SELL', amountCrypto: 50 });
            await fundEscrow(vendor.id, `escrow:trade-${trade.id}:locked`, 50);
            await prisma.user.update({ where: { id: vendor.id }, data: { escrowLockedBalance: D(50) } });

            const res = makeRes();
            await adminController.forceCancel(makeReq(trade.id), res);
            expect(res.status).toHaveBeenCalledWith(200);

            // Projections moved.
            const v = await prisma.user.findUnique({ where: { id: vendor.id } });
            expect(v.escrowLockedBalance.toFixed(8)).toBe('0.00000000');
            expect(v.vendorUnallocatedBalance.toFixed(8)).toBe('50.00000000');

            // The BOOKS moved identically — the pre-fix defect was a silent
            // projection-only reclassification.
            expect((await bal(`escrow:trade-${trade.id}:locked`)).toFixed(8)).toBe('0.00000000');
            expect((await bal(`user:${vendor.id}:unallocated`)).toFixed(8)).toBe('50.00000000');

            // Exactly-once: one force-cancel posting, and a second attempt
            // (trade no longer DISPUTED) cannot add another.
            const postings = await prisma.ledgerTransaction.findMany({
                where: { idempotencyKey: `ledger:p2p:force-cancel:${trade.id}` },
            });
            expect(postings).toHaveLength(1);
            expect(postings[0].entryType).toBe('VENDOR_ALLOCATE');

            const res2 = makeRes();
            await adminController.forceCancel(makeReq(trade.id), res2);
            expect(res2.status).toHaveBeenCalledWith(400);
            expect(await prisma.ledgerTransaction.count({
                where: { idempotencyKey: `ledger:p2p:force-cancel:${trade.id}` },
            })).toBe(1);
        });

        it('BUY ad: buyer escrow refunds to available WITH its authoritative posting', async () => {
            const { buyer, trade } = await seedDisputedTrade({ type: 'BUY', amountCrypto: 30 });
            await fundEscrow(buyer.id, `escrow:trade-${trade.id}:locked`, 30);
            await prisma.user.update({ where: { id: buyer.id }, data: { escrowLockedBalance: D(30) } });

            const res = makeRes();
            await adminController.forceCancel(makeReq(trade.id), res);
            expect(res.status).toHaveBeenCalledWith(200);

            const b = await prisma.user.findUnique({ where: { id: buyer.id } });
            expect(b.escrowLockedBalance.toFixed(8)).toBe('0.00000000');
            expect(b.availableBalance.toFixed(8)).toBe('30.00000000');
            expect((await bal(`user:${buyer.id}:liability`)).toFixed(8)).toBe('30.00000000');
            expect((await bal(`escrow:trade-${trade.id}:locked`)).toFixed(8)).toBe('0.00000000');

            const posting = await prisma.ledgerTransaction.findUnique({
                where: { idempotencyKey: `ledger:p2p:force-cancel:${trade.id}` },
            });
            expect(posting.entryType).toBe('ESCROW_REFUND');
        });
    });

    // ── 2. peer transfer fulfill: liability transfer posts authoritatively ────
    describe('peer transfer fulfill ledger coverage', () => {
        const mockRes = () => {
            const r = { _status: 200, _body: null };
            r.status = (s) => { r._status = s; return r; };
            r.json = (b) => { r._body = b; return r; };
            return r;
        };
        const mockApp = () => ({
            get: (k) =>
                k === 'prisma' ? prisma :
                k === 'socketio' ? { to: () => ({ emit: () => {} }) } :
                k === 'emitBalanceUpdate' ? (async () => {}) : null,
        });

        it('fulfillment moves liability on the BOOKS, exactly once; a second fulfill attempt adds no posting', async () => {
            const requester = await seedUser(prisma, { availableBalance: 0 });
            const payer = await seedUser(prisma, { availableBalance: 0 });
            // Fund the payer through the ledger so projections and books agree.
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: `test:fund-payer:${payer.id}`,
                    entryType: 'DEPOSIT', description: 'funding',
                    lines: [
                        { account: 'clearing:conversion', debit: '300' },
                        { account: `user:${payer.id}:liability`, credit: '300' },
                    ],
                });
                await tx.user.update({ where: { id: payer.id }, data: { availableBalance: D(300) } });
            });
            const friendship = await prisma.friendship.create({
                data: { requesterId: requester.id, addresseeId: payer.id, status: 'ACCEPTED' },
            });

            const reqRes = mockRes();
            await peerTransferController.requestFunds(
                { user: { id: requester.id }, body: { friendshipId: friendship.id, amount: 75, reference: 'pay me back' }, app: mockApp() },
                reqRes
            );
            expect(reqRes._status).toBe(201);
            const transferId = reqRes._body.transfer?.id ?? reqRes._body.transferId ?? reqRes._body.id;
            expect(transferId).toBeTruthy();

            const fulRes = mockRes();
            await peerTransferController.fulfillTransferRequest(
                { user: { id: payer.id }, params: { id: String(transferId) }, app: mockApp() },
                fulRes
            );
            expect(fulRes._status).toBe(200);

            // Projections.
            const p = await prisma.user.findUnique({ where: { id: payer.id } });
            const r = await prisma.user.findUnique({ where: { id: requester.id } });
            expect(p.availableBalance.toFixed(8)).toBe('225.00000000');
            expect(r.availableBalance.toFixed(8)).toBe('75.00000000');

            // Books — the pre-fix defect: fulfillment was projection-only.
            expect((await bal(`user:${payer.id}:liability`)).toFixed(8)).toBe('225.00000000');
            expect((await bal(`user:${requester.id}:liability`)).toFixed(8)).toBe('75.00000000');

            // Exactly-once: one posting on the fulfillment identity; replay
            // through the controller (transfer no longer PENDING) adds none.
            const key = `ledger:peer:fulfill:${transferId}`;
            const postings = await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: key } });
            expect(postings).toHaveLength(1);
            expect(postings[0].entryType).toBe('TRANSFER');

            const fulRes2 = mockRes();
            await peerTransferController.fulfillTransferRequest(
                { user: { id: payer.id }, params: { id: String(transferId) }, app: mockApp() },
                fulRes2
            );
            expect([400, 409]).toContain(fulRes2._status);
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
        });
    });

    // ── 3. legacy finance webhook deposit: provisional custody posting ───────
    describe('legacy processCryptoDeposit ledger coverage', () => {
        it('credits balances WITH a provisional clearing posting; replay is fenced; unrepresentable amounts roll back entirely', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });

            const result = await finance.processCryptoDeposit(prisma, {
                userId: user.id, amountUsdc: 25, txHash: 'LEGACY-WH-1', address: null,
            });
            expect(result.alreadyProcessed).toBe(false);

            const u = await prisma.user.findUnique({ where: { id: user.id } });
            expect(u.availableBalance.toFixed(8)).toBe('25.00000000');
            // Books: provisional custody clearing — NOT a reserve asset.
            expect((await bal('clearing:custody:unverified:usdc')).toFixed(8)).toBe('25.00000000');
            expect((await bal(`user:${user.id}:liability`)).toFixed(8)).toBe('25.00000000');

            const posting = await prisma.ledgerTransaction.findUnique({
                where: { idempotencyKey: 'ledger:deposit:crypto:LEGACY-WH-1' },
            });
            expect(posting).not.toBeNull();
            expect(posting.entryType).toBe('CUSTODY_DEPOSIT');

            // Replay on the same txHash: idempotent, no duplicate posting.
            const replay = await finance.processCryptoDeposit(prisma, {
                userId: user.id, amountUsdc: 25, txHash: 'LEGACY-WH-1', address: null,
            });
            expect(replay.alreadyProcessed).toBe(true);
            expect(await prisma.ledgerTransaction.count({
                where: { idempotencyKey: 'ledger:deposit:crypto:LEGACY-WH-1' },
            })).toBe(1);

            // Fail-closed: an amount the authoritative books cannot express
            // (over-precision) rejects and rolls back EVERYTHING — the
            // legacy route can no longer mint value the books can't represent.
            await expect(finance.processCryptoDeposit(prisma, {
                userId: user.id, amountUsdc: 25.1234567891, txHash: 'LEGACY-WH-2', address: null,
            })).rejects.toThrow();

            const u2 = await prisma.user.findUnique({ where: { id: user.id } });
            expect(u2.availableBalance.toFixed(8)).toBe('25.00000000'); // unchanged
            expect(await prisma.transactionHistory.count({ where: { txHash: 'LEGACY-WH-2' } })).toBe(0);
            expect(await prisma.ledgerTransaction.count({
                where: { idempotencyKey: 'ledger:deposit:crypto:LEGACY-WH-2' },
            })).toBe(0);
        });
    });

    // ── 4. SOURCE_FAMILIES: accurate authority + representation semantics ────
    describe('restricted obligation families (post wave-2)', () => {
        it('every family is authoritative; ledger-reclassification families report ledger totals but are NOT double-counted into the denominator', async () => {
            // Seed escrow-restricted funds through the ledger.
            const user = await seedUser(prisma, { availableBalance: 0 });
            await fundEscrow(user.id, 'escrow:wave2-test-1:locked', 60);
            await prisma.user.update({ where: { id: user.id }, data: { escrowLockedBalance: D(60) } });

            const totals = await restrictedObligations.authoritativeTotals(prisma, { asset: 'USDC' });
            expect(totals.complete).toBe(true); // every writer migrated — no family stays un-authoritative forever

            const escrow = totals.families.ESCROW_LOCK;
            expect(escrow.authoritative).toBe(true);
            expect(escrow.representation).toBe('LEDGER_RECLASSIFICATION');
            expect(escrow.includedInDenominator).toBe(false);
            expect(escrow.ledgerReclassificationTotal.toFixed(8)).toBe('60.00000000'); // exact ledger sum
            expect(escrow.activeTotal.toFixed(8)).toBe('0.00000000');   // no obligation rows for this family

            const fiat = totals.families.PENDING_FIAT_WITHDRAWAL;
            expect(fiat.representation).toBe('RESTRICTED_OBLIGATION_ROW');
            expect(fiat.includedInDenominator).toBe(true);

            // `total` sums ONLY obligation-row families — the escrow
            // reclassification is already counted once inside the
            // flow-based customer liability X and must not be added again.
            expect(totals.total.toFixed(8)).toBe('0.00000000');

            for (const fam of Object.values(totals.families)) {
                expect(fam.authoritative).toBe(true);
            }
        });
    });

    // ── 5. PoR snapshot: restricted values come from the report, not stale hardcodes ──
    describe('proof-of-reserves snapshot payload', () => {
        it('reports the authoritative restricted total and modeled=true (blocker: stale P3 hardcodes)', async () => {
            // Seed one ACTIVE pending-fiat-withdrawal obligation row.
            await prisma.restrictedObligation.create({
                data: {
                    reference: 'por-snapshot-test-1',
                    sourceType: 'PENDING_FIAT_WITHDRAWAL',
                    sourceEntity: 'withdrawal',
                    sourceEntityId: 'por-test-w1',
                    amount: D(40),
                    status: 'ACTIVE',
                    reserveInclusionPolicy: 'INCLUDED_IN_RESERVE_DENOMINATOR',
                },
            });

            const { snapshot } = await proofOfReserves.createSnapshot();
            const breakdown = snapshot.breakdown;

            // The nested reserves block mirrors the composed report —
            // the pre-fix payload hardcoded null/false here.
            expect(new Prisma.Decimal(breakdown.reserves.restrictedObligationsTotal).toFixed(8)).toBe('40.00000000');
            expect(breakdown.reserves.restrictedObligationsAvailable).toBe(true);
            expect(breakdown.invariant.restrictedObligationsModeled).toBe(true);
            // §P.3 additive columns (top-level snapshot record fields)
            // stay consistent with the report.
            expect(snapshot.restrictedObligationsTotal.toFixed(8)).toBe('40.00000000');
            expect(snapshot.restrictedObligationsAvailable).toBe(true);
        });

        it('with zero obligation rows the totals report a known zero (not an unknown null)', async () => {
            const { snapshot } = await proofOfReserves.createSnapshot();
            expect(new Prisma.Decimal(snapshot.breakdown.reserves.restrictedObligationsTotal).toFixed(8)).toBe('0.00000000');
            expect(snapshot.breakdown.reserves.restrictedObligationsAvailable).toBe(true);
            expect(snapshot.breakdown.invariant.restrictedObligationsModeled).toBe(true);
        });
    });

    // ── 6. reconciliation: dispute + unallocated buckets are checked ────────
    describe('projection reconciliation (wave-2 buckets)', () => {
        it('flags dispute and unallocated drift; clean books produce no exceptions', async () => {
            // A user with a ledger liability account (so reconciliation iterates them).
            const user = await seedUser(prisma, { availableBalance: 15 });
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: `test:recon-fund:${user.id}`,
                    entryType: 'DEPOSIT', description: 'funding',
                    lines: [
                        { account: 'clearing:conversion', debit: '15' },
                        { account: `user:${user.id}:liability`, credit: '15' },
                    ],
                });
            });

            const userKey = `user:${user.id}`;
            const kindsFor = async () => {
                const { exceptions } = await reconciliation.reconcileUserProjections(prisma);
                return exceptions.filter((e) => e.userId === user.id).map((e) => e.kind).sort();
            };

            // Clean baseline: available/liability agree; no drift anywhere.
            expect(await kindsFor()).toEqual([]);

            // Drift the dispute projection with no ledger behind it.
            await prisma.user.update({ where: { id: user.id }, data: { disputeEscrowBalance: D(10) } });
            // zero-ledger + nonzero projection reports the unmigrated-bucket
            // heuristic (same as escrow); the coverage requirement is that the
            // DISPUTE bucket drift is DETECTED at all.
            expect(await kindsFor()).toEqual(['UNMIGRATED_BUCKET_ACTIVITY']);

            // Reconcile the books: dispute account agrees, drift removed.
            await prisma.$transaction(async (tx) => {
                await ledger.ensureAccount(tx, `${userKey}:dispute`, { userId: user.id });
                await ledger.post(tx, {
                    idempotencyKey: `test:recon-dispute:${user.id}`,
                    entryType: 'ESCROW_LOCK', description: 'dispute restriction',
                    lines: [
                        { account: `${userKey}:liability`, debit: '10' },
                        { account: `${userKey}:dispute`, credit: '10' },
                    ],
                });
                // NOTE: the ledger now also disagrees on the LIABILITY side
                // (ledger available 15-10=5 vs projection 15) — align the
                // projection to the books like a migrated writer would.
                // (Funded at 15 so the aligned projection stays >= 0 — the
                // User_availableBalance_nonneg armor refuses negative ones.)
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: D(5) } });
            });
            expect(await kindsFor()).toEqual([]);
            // restore for the next scenario
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: `test:recon-dispute-release:${user.id}`,
                    entryType: 'ESCROW_REFUND', description: 'release',
                    lines: [
                        { account: `${userKey}:dispute`, debit: '10' },
                        { account: `${userKey}:liability`, credit: '10' },
                    ],
                });
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: D(15), disputeEscrowBalance: D(0) } });
            });
            expect(await kindsFor()).toEqual([]);

            // Drift the unallocated projection with no ledger behind it.
            await prisma.user.update({ where: { id: user.id }, data: { vendorUnallocatedBalance: D(20) } });
            expect(await kindsFor()).toEqual(['UNMIGRATED_BUCKET_ACTIVITY']);
        });
    });
});
