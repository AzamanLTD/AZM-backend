// __tests__/p4-liability-ledger.test.js
// =============================================================================
// Financial architecture §P.4 — canonical authoritative liability ledger.
//
// Real-PostgreSQL proofs over the migrated wave-1 financial paths and the
// ledger primitive. Every test runs against TEST_DATABASE_URL on the live
// relational engine (no mocks for money paths). Proves (mandate list):
//   1-2  exact Decimal balancing, zero/negative/unbalanced rejection
//   3-6  ledger failure rolls back the ENTIRE financial mutation
//        (User projection + TransactionHistory + custody rows); caller-owned
//        transaction boundary; no independent ledger transaction underneath
//   7-9  exactly-once economic identity (unique constraint + posting-hash
//        replay + conflict detection); concurrent identical ops -> ONE posting
//   10   concurrent transfers cannot drive the projection negative
//   11   crypto deposit -> custody asset + customer liability, exactly once
//   12   crypto withdrawal reservation + verified settlement, exactly once
//   13   ambiguous withdrawal NEVER auto-refunds (obligation stays ACTIVE)
//   14   fiat deposit -> liability against conversion clearing, NO fake
//        inventory, NO fake custody asset
//   15   fiat withdrawal remains provider-settlement-safe (no fee/revenue
//        realization before provider SUCCESS; exact reserve/settle/reverse)
//   16   escrow internal reclassification does not change total customer
//        liability
//   17   refund/reversal changes total customer liability EXACTLY once
//   18   restricted obligation denominator is deterministic and fail-closed
//   19   synthetic singletons never affect authoritative reserve/ledger math
//   20   reconciliation detects projection/ledger disagreement (read-only,
//        never rewrites history)
//   21   migration installer is idempotent (and never mutates financial data)
// Remaining items (22-25: backup/restore drill, route-check, prisma validate,
// dependency audit) are executed by the CI battery/CLI gates in the PR.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p4-ledger] TEST_DATABASE_URL not set — skipping DB proofs.');

const { Prisma, PrismaClient } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const restrictedObligations = require('../services/restrictedObligationService');
const reconciliation = require('../services/ledgerReconciliationService');
const finance = require('../services/finance.service');
const custody = require('../services/tatumCustodyExecutionService');
const accounting = require('../services/custodyAccountingService');
const { seedUser } = require('./helpers/factories');

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const OTHER = '0x' + '55'.repeat(20);
const NATIVE = custody.CANONICAL.contractAddress;
const D = (v) => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('§P.4 authoritative liability ledger (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "RestrictedObligation", "LedgerTransaction", "LedgerAccount", "JournalEntry", ' +
        '"CustodyEvidence", "CustodyMovement", "CustodyAccount", "CustodyExecution", "OnchainSweep", ' +
        '"TransactionHistory", "WalletAddress", "User", "SystemHotWallet", "SystemMasterCrypto", ' +
        '"SystemFiatPool", "SystemProfitFees", "GlobalSettings", "AdminProfitLog", ' +
        '"ProofOfReservesSnapshot" RESTART IDENTITY CASCADE'
    );
    beforeEach(async () => {
        process.env.TATUM_HOT_WALLET_ADDRESS = HOT;
        process.env.TATUM_WEBHOOK_SECRET = 'test-webhook-secret';
        await TRUNCATE_ALL();
    }, 30000);
    afterEach(async () => {
        custody.__setProviderForTests(null);
        delete process.env.TATUM_WEBHOOK_SECRET;
        await TRUNCATE_ALL();
    }, 30000);

    const bal = (code) => ledger.accountBalance(prisma, code);
    const userBal = (id) => ledger.userLiabilityBalance(prisma, id);
    const avail = async (id) => (await prisma.user.findUnique({ where: { id: id }, select: { availableBalance: true } })).availableBalance;

    // ═════════════════════════════════════════════════════════════════════════
    describe('1-2. primitive: exact Decimal balancing, fail-closed quantities', () => {
        it('posts an exactly balanced Decimal transaction (0.1 + 0.2 == 0.3) with deterministic hash', async () => {
            const user = await seedUser(prisma);
            const r = await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:exact:1',
                entryType: 'TRANSFER',
                description: 'exact decimal balancing',
                lines: [
                    { account: 'clearing:conversion', debit: '0.1' },
                    { account: `user:${user.id}:liability`, credit: '0.3' },
                    { account: 'clearing:conversion', debit: '0.2' },
                ],
            }));
            expect(r.replayed).toBe(false);
            expect(r.entries).toHaveLength(3);
            const c = await bal('clearing:conversion');
            expect(c.balance.toFixed(8)).toBe('0.30000000'); // debit-normal exact
            const again = ledger.computePostingHash('TRANSFER', r.entries.map(e => ({
                account: e.account, debit: e.debit, credit: e.credit,
            })));
            expect(again).toBe(r.transaction.postingHash);
        });

        it.each([
            ['unbalanced', { account: 'revenue:fees', credit: '0.2' }, /unbalanced/i, 'LEDGER_UNBALANCED'],
            ['zero posting', { account: 'revenue:fees', credit: '0' }, /zero-value/i, 'LEDGER_ZERO_LINE'],
            ['negative', { account: 'revenue:fees', credit: '-5' }, /not an exact|negative/i, 'LEDGER_INEXACT_QUANTITY'],
            ['over-precision float', { account: 'revenue:fees', credit: 0.1234567891 }, /exactly representable/i, 'LEDGER_INEXACT_QUANTITY'],
            ['both sides', { account: 'revenue:fees', debit: '1', credit: '1' }, /BOTH/i, 'LEDGER_BOTH_SIDES'],
            ['unknown account', { account: 'user:1:cashdrawer', credit: '1' }, /authoritative chart/i, 'LEDGER_UNKNOWN_ACCOUNT'],
        ])('rejects %s — fail closed, nothing persisted', async (_name, badLine, message, code) => {
            const user = await seedUser(prisma);
            await expect(prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: `test:reject:${code}`,
                entryType: 'TRANSFER',
                description: 'must never commit',
                lines: [{ account: `user:${user.id}:liability`, debit: '1' }, badLine],
            }))).rejects.toThrow(message);
            expect(await prisma.ledgerTransaction.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);
        });

        it('requires the caller-owned transaction client', async () => {
            await expect(ledger.post(undefined, {})).rejects.toMatchObject({ code: 'LEDGER_TX_REQUIRED' });
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('3-6. caller-owned transaction boundary — rollback proofs', () => {
        it('a posting failure rolls back the User projection mutation in the same transaction', async () => {
            const user = await seedUser(prisma, { availableBalance: 50 });
            await expect(prisma.$transaction(async (tx) => {
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { decrement: 10 } } });
                await ledger.post(tx, {
                    idempotencyKey: 'test:rollback:user',
                    entryType: 'TRANSFER', description: 'bad posting',
                    lines: [
                        { account: `user:${user.id}:liability`, debit: '10' },
                        { account: 'does:not:exist', credit: '10' },
                    ],
                });
            })).rejects.toThrow(/authoritative chart/);
            expect((await avail(user.id)).toString()).toBe('50'); // unchanged
        });

        it('a posting failure rolls back the TransactionHistory mutation in the same transaction', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await expect(prisma.$transaction(async (tx) => {
                await tx.transactionHistory.create({
                    data: { userId: user.id, type: 'INTERNAL_TRANSFER', amountUsdc: 5, feeUsdc: 0, txHash: 'rollback-th-1', status: 'COMPLETED' },
                });
                await ledger.post(tx, {
                    idempotencyKey: 'test:rollback:th',
                    entryType: 'TRANSFER', description: 'unbalanced',
                    lines: [
                        { account: `user:${user.id}:liability`, debit: '5' },
                        { account: 'clearing:conversion', credit: '4' },
                    ],
                });
            })).rejects.toThrow(/unbalanced/);
            expect(await prisma.transactionHistory.count({ where: { txHash: 'rollback-th-1' } })).toBe(0);
        });

        it('the posting joins the CALLER transaction — an outer failure leaves NO committed posting (no independent ledger transaction underneath)', async () => {
            const user = await seedUser(prisma);
            await expect(prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: 'test:join:1',
                    entryType: 'TRANSFER', description: 'outer will fail',
                    lines: [
                        { account: `user:${user.id}:liability`, debit: '1' },
                        { account: 'clearing:conversion', credit: '1' },
                    ],
                });
                throw new Error('outer failure after posting');
            })).rejects.toThrow('outer failure after posting');
            expect(await prisma.ledgerTransaction.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('7-9. exactly-once economic identity', () => {
        it('duplicate CONCURRENT identical posts: the unique identity means exactly ONE economic posting commits', async () => {
            const user = await seedUser(prisma);
            const postOnce = () => prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:concurrent:1',
                entryType: 'TRANSFER', description: 'concurrent same identity',
                lines: [
                    { account: 'clearing:conversion', debit: '10' },
                    { account: `user:${user.id}:liability`, credit: '10' },
                ],
            }));
            const results = await Promise.allSettled([postOnce(), postOnce()]);
            const ok = results.filter(r => r.status === 'fulfilled');
            // Two legal interleavings, both exactly-once economically:
            //   (a) both check-then-create collide on the unique key → one
            //       commits, the loser rolls back and rejects;
            //   (b) the winner fully commits before the loser's
            //       findUnique → the loser takes the REPLAY path and also
            //       fulfills (replayed: true), pointing at the SAME
            //       committed transaction. In either case exactly ONE
            //       posting exists afterwards — never two.
            expect(ok.length).toBeGreaterThanOrEqual(1);
            expect(new Set(ok.map(r => r.value.transaction.id)).size).toBe(1);
            expect(ok.some(r => r.value.replayed)).toBe(results.some(r => r.status === 'rejected') === false);
            expect(await prisma.ledgerTransaction.count()).toBe(1);
            expect(await prisma.journalEntry.count()).toBe(2);
            const committed = await bal('clearing:conversion');
            expect(committed.balance.toFixed(8)).toBe('10.00000000'); // never doubled
        });

        it('an exact REPLAY returns the already-committed result — no second posting, no history rewrite', async () => {
            const user = await seedUser(prisma);
            const params = {
                idempotencyKey: 'test:replay:1',
                entryType: 'TRANSFER', description: 'replayable',
                lines: [
                    { account: `user:${user.id}:liability`, debit: '7' },
                    { account: 'clearing:conversion', credit: '7' },
                ],
            };
            const first = await prisma.$transaction((tx) => ledger.post(tx, params));
            const second = await prisma.$transaction((tx) => ledger.post(tx, params));
            expect(second.replayed).toBe(true);
            expect(second.transaction.id).toBe(first.transaction.id);
            expect(await prisma.ledgerTransaction.count()).toBe(1);
        });

        it('the same key with DIFFERENT economics is a hard conflict — history can never be overwritten', async () => {
            const user = await seedUser(prisma);
            await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:conflict:1',
                entryType: 'TRANSFER', description: 'original',
                lines: [
                    { account: 'clearing:conversion', debit: '5' },
                    { account: `user:${user.id}:liability`, credit: '5' },
                ],
            }));
            await expect(prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:conflict:1',
                entryType: 'TRANSFER', description: 'hijack attempt',
                lines: [
                    { account: 'clearing:conversion', debit: '999' },
                    { account: `user:${user.id}:liability`, credit: '999' },
                ],
            }))).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENCY_CONFLICT' });
            expect((await bal('clearing:conversion')).balance.toFixed(8)).toBe('5.00000000');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('9-10. internal transfer: exactly once; concurrency cannot create negative projections', () => {
        it('transfer posts BOTH liability legs in the caller transaction and is exactly-once under replay', async () => {
            const [a, b] = [await seedUser(prisma, { availableBalance: 0 }), await seedUser(prisma, { availableBalance: 0 })];
            const doTransfer = () => prisma.$transaction(async (tx) => {
                const amt = 25;
                const claim = await tx.user.updateMany({
                    where: { id: a.id, availableBalance: { gte: amt } },
                    data: { availableBalance: { decrement: amt } },
                });
                if (claim.count !== 1) throw new Error('INSUFFICIENT_FUNDS');
                await tx.user.update({ where: { id: b.id }, data: { availableBalance: { increment: amt } } });
                await ledger.post(tx, {
                    idempotencyKey: `ledger:transfer:${a.id}-${b.id}-1`,
                    entryType: 'TRANSFER', description: 'peer transfer',
                    lines: [
                        { account: `user:${a.id}:liability`, debit: String(amt) },
                        { account: `user:${b.id}:liability`, credit: String(amt) },
                    ],
                });
            });
            // Fund A through the ledger itself so projections stay honest.
            await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:transfer:fund-a',
                entryType: 'DEPOSIT', description: 'funding deposit',
                lines: [
                    { account: 'clearing:conversion', debit: '100' },
                    { account: `user:${a.id}:liability`, credit: '100' },
                ],
            }));
            await prisma.user.update({ where: { id: a.id }, data: { availableBalance: { increment: 100 } } });
            await doTransfer();
            expect((await avail(a.id)).toString()).toBe('75');
            expect((await avail(b.id)).toString()).toBe('25');
            expect((await userBal(a.id)).toFixed(0)).toBe('75'); // 100 funded - 25 sent
            expect((await userBal(b.id)).toFixed(0)).toBe('25');
            // Replay: identical key returns the committed result, projections unchanged.
            const replay = await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: `ledger:transfer:${a.id}-${b.id}-1`,
                entryType: 'TRANSFER', description: 'peer transfer',
                lines: [
                    { account: `user:${a.id}:liability`, debit: '25' },
                    { account: `user:${b.id}:liability`, credit: '25' },
                ],
            }));
            expect(replay.replayed).toBe(true);
            expect((await avail(a.id)).toString()).toBe('75'); // NOT debited twice
        });

        it('CONCURRENT over-spending transfers: the guarded claim leaves the projection exactly consistent, never negative', async () => {
            const a = await seedUser(prisma, { availableBalance: 100 });
            const b = await seedUser(prisma, { availableBalance: 0 });
            const transfer60 = () => prisma.$transaction(async (tx) => {
                const claim = await tx.user.updateMany({
                    where: { id: a.id, availableBalance: { gte: 60 } },
                    data: { availableBalance: { decrement: 60 } },
                });
                if (claim.count !== 1) throw new Error('INSUFFICIENT_FUNDS');
                await tx.user.update({ where: { id: b.id }, data: { availableBalance: { increment: 60 } } });
                await ledger.post(tx, {
                    idempotencyKey: `ledger:transfer:conc-${Math.random()}`,
                    entryType: 'TRANSFER', description: 'racing transfer',
                    lines: [
                        { account: `user:${a.id}:liability`, debit: '60' },
                        { account: `user:${b.id}:liability`, credit: '60' },
                    ],
                });
            });
            const results = await Promise.allSettled([transfer60(), transfer60()]);
            const fulfilled = results.filter(r => r.status === 'fulfilled');
            expect(fulfilled).toHaveLength(1); // only one can win the 60-unit claim
            const finalBal = await avail(a.id);
            expect(finalBal.gte(0)).toBe(true); // NEVER negative
            expect(finalBal.toString()).toBe('40');
            expect((await avail(b.id)).toString()).toBe('60');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('11. crypto deposit (migrated webhook path): custody asset + customer liability exactly once', () => {
        const depositController = require('../controllers/depositController');
        const { allocateDepositAddress } = require('../services/walletAddressService');
        const webhookReq = ({ body }) => ({
            body,
            headers: {},
            rawBody: JSON.stringify(body),
            app: { get: (key) => ({ prisma, tatumService: null, socketio: null, emitBalanceUpdate: null }[key]) },
        });
        const webhookRes = () => {
            const res = { statusCode: 0, body: null };
            res.status = (c) => { res.statusCode = c; return res; };
            res.json = (b) => { res.body = b; return res; };
            return res;
        };
        const tatumFake = () => ({
            providerMode: 'MOCK',
            deriveDepositAddress: async (userId) => ({
                address: ('0x' + String(userId).padStart(8, '0') + 'a'.repeat(24)).toLowerCase(),
                derivationIndex: userId,
                source: 'MOCK',
            }),
        });

        it('webhook settlement posts D clearing:custody:unverified:usdc / C user:{id}:liability atomically (provisional custody), and replays are idempotent', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const registry = await allocateDepositAddress(prisma, tatumFake(), user.id);
            const txHash = '0x' + 'cc'.repeat(32);
            const body = { address: registry.address, txId: txHash, amount: 7.5, asset: 'USDC', userId: user.id };

            const res1 = webhookRes();
            await depositController.tatumCryptoWebhook(webhookReq({ body }), res1);
            expect(res1.statusCode).toBe(200);

            // Projection + authoritative ledger agree exactly.
            expect((await avail(user.id)).toString()).toBe('7.5');
            expect((await userBal(user.id)).toFixed(6)).toBe('7.500000');
            // Wave-2: the webhook records PROVISIONAL custody only. The
            // unverified clearing balance is NOT a PoR reserve asset; only
            // independent transaction evidence (custodyAccounting verify)
            // reclassifies it into custody:deposit:usdc.
            const provisional = await bal('clearing:custody:unverified:usdc');
            expect(provisional.balance.toFixed(6)).toBe('7.500000');
            const custodyAsset = await bal('custody:deposit:usdc');
            expect(custodyAsset.balance.toFixed(6)).toBe('0.000000');
            // One posting group, two lines, linked to the TransactionHistory row.
            const post = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `ledger:deposit:crypto:${txHash}` } });
            expect(post).not.toBeNull();
            expect(post.relatedEntity).toBe('transactionHistory');
            const lines = await prisma.journalEntry.findMany({ where: { ledgerTransactionId: post.id } });
            expect(lines).toHaveLength(2);
            expect(new Set(lines.map(l => l.account))).toEqual(new Set(['clearing:custody:unverified:usdc', `user:${user.id}:liability`]));
            // The custody candidate is LINKED to the posting.
            expect(post.metadata.custodyMovementId).toBe((await prisma.custodyMovement.findFirst({ where: { txHash } })).id);

            // Replay the same webhook: idempotent, no second anything.
            const res2 = webhookRes();
            await depositController.tatumCryptoWebhook(webhookReq({ body }), res2);
            expect(res2.statusCode).toBe(200);
            expect(res2.body.data.alreadyProcessed).toBe(true);
            expect(await prisma.ledgerTransaction.count()).toBe(1);
            expect((await avail(user.id)).toString()).toBe('7.5');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('12-13. crypto withdrawal reservation + verified settlement + ambiguity', () => {
        async function reserveWithdrawal(user, { amountBase = 2000000n, feeBase = 500000n, id } = {}) {
            const ledgerRow = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 2.0, feeUsdc: 0.5, txHash: null, status: 'PENDING' },
            });
            const execution = await custody.createWithdrawalExecution(prisma, {
                idempotencyKey: `withdrawal:${id}`,
                transactionHistoryId: ledgerRow.id,
                userId: user.id,
                fromAddress: HOT, toAddress: OTHER, amountBaseUnits: amountBase, feeChargeBaseUnits: feeBase,
            });
            // §P.4 reservation — exactly as withdrawalController posts it.
            await prisma.$transaction(async (tx) => {
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { decrement: 2.5 } } });
                const reservation = await ledger.post(tx, {
                    idempotencyKey: `ledger:withdrawal:crypto:execution:${execution.id}`,
                    entryType: 'CUSTODY_WITHDRAWAL', description: 'reservation',
                    reference: `custody-exec:${execution.id}`,
                    userId: user.id, relatedEntity: 'custodyExecution', relatedEntityId: execution.id,
                    lines: [
                        { account: `user:${user.id}:liability`, debit: '2.5' },
                        { account: 'restricted:reserves', credit: '2.5' },
                    ],
                });
                await restrictedObligations.createForPendingWithdrawal(tx, {
                    sourceType: 'PENDING_CRYPTO_WITHDRAWAL',
                    reference: `withdrawal:crypto:${execution.id}`,
                    userId: user.id, amount: '2.5', asset: 'USDC', network: 'POLYGON',
                    sourceEntity: 'custodyExecution', sourceEntityId: execution.id,
                    ledgerTransactionId: reservation.transaction.id,
                    domainStateRef: { customerDebitBaseUnits: '2500000', netPayoutBaseUnits: '2000000', feeChargeBaseUnits: '500000' },
                });
                await tx.custodyExecution.update({
                    where: { id: execution.id },
                    data: { metadata: { customerDebitBaseUnits: '2500000', netPayoutBaseUnits: '2000000', feeChargeBaseUnits: '500000' } },
                });
            });
            return { execution, ledgerRow };
        }

        it('12: reservation reserves funds in restricted:reserves linked to the execution; VERIFIED settlement posts exactly once and releases', async () => {
            const user = await seedUser(prisma, { availableBalance: 10 });
            // Test-epoch custody funding (the credited side of the hot-wallet
            // asset: an opening adjustment + a §P.4-style sweep posting).
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: 'test:epoch:opening', entryType: 'ADJUSTMENT',
                    description: 'test-epoch opening custody asset adjustment',
                    lines: [
                        { account: 'custody:deposit:usdc', debit: '10' },
                        { account: 'equity:treasury', credit: '10' },
                    ],
                });
                await ledger.post(tx, {
                    idempotencyKey: 'test:epoch:sweep', entryType: 'CUSTODY_SWEEP',
                    description: 'sweep deposit -> hot custody',
                    lines: [
                        { account: 'custody:hot:usdc', debit: '10' },
                        { account: 'custody:deposit:usdc', credit: '10' },
                    ],
                });
            });
            const { execution } = await reserveWithdrawal(user, { id: 'a' });

            // Reservation state: customer debited, funds restricted (not revenue, not custody asset yet).
            expect((await avail(user.id)).toString()).toBe('7.5');
            const restricted = await bal('restricted:reserves');
            expect(restricted.balance.toFixed(6)).toBe('2.500000');
            expect((await bal('custody:hot:usdc')).balance.toFixed(6)).toBe('10.000000'); // epoch sweep only — nothing realized yet
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe('0.000000');    // fee NOT realized yet
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } });
            expect(obligation.status).toBe('ACTIVE');

            // Drive to CONFIRMING with chain evidence, then settle through the
            // REAL settlement authority.
            const txHash = '0x' + 'dd'.repeat(32);
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'CONFIRMING', txHash } });
            custody.__setProviderForTests({
                name: 'FAKE',
                async getTransaction() {
                    return {
                        status: '0x1',
                        logs: [{
                            address: NATIVE,
                            topics: [
                                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                                '0x' + '0'.repeat(24) + HOT.slice(2).toLowerCase(),
                                '0x' + '0'.repeat(24) + OTHER.slice(2).toLowerCase(),
                            ],
                            data: '0x' + BigInt(2000000n).toString(16).padStart(64, '0'),
                        }],
                    };
                },
            });
            const settled = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(settled.settled).toBe(true);

            // Settlement posting: restricted drained; custody asset + realized fee.
            expect((await bal('restricted:reserves')).balance.toFixed(6)).toBe('0.000000');
            expect((await bal('custody:hot:usdc')).balance.toFixed(6)).toBe('8.000000'); // 10 swept in - 2 paid out
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe('0.500000');
            expect((await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } })).status).toBe('RELEASED');

            // Idempotent settlement retry: NO second posting, NO second release.
            const again = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(again.settled).toBe(false);
            expect(again.alreadySettled).toBe(true);
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:withdrawal:crypto:settle:${execution.id}` } })).toBe(1);
        });

        it('13: AMBIGUOUS outcomes go to RECONCILIATION_REQUIRED — the obligation NEVER auto-refunds', async () => {
            const user = await seedUser(prisma, { availableBalance: 10 });
            const { execution } = await reserveWithdrawal(user, { id: 'b' });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'BROADCAST', txHash: '0x' + 'ee'.repeat(32) } });
            const before = await avail(user.id);
            await custody.reconcileExecution(prisma, { executionId: execution.id });
            const executionRow = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
            expect(executionRow.status).toBe('RECONCILIATION_REQUIRED');
            // NO refund: projection unchanged, obligation still ACTIVE, funds still reserved.
            expect((await avail(user.id)).toString()).toBe(before.toString());
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } });
            expect(obligation.status).toBe('ACTIVE');
            expect((await bal('restricted:reserves')).balance.toFixed(6)).toBe('2.500000');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('14. fiat deposit: liability against conversion clearing, NO fake inventory', () => {
        it('a fiat-settled USDC deposit credits customer liability against clearing:conversion — inventory/custody assets untouched', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const amount = new Prisma.Decimal('12.34');
            const fiatRow = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'DEPOSIT_FIAT', amountUsdc: amount, feeUsdc: 0, txHash: 'FIAT-1', status: 'COMPLETED' },
            });
            await prisma.$transaction(async (tx) => {
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { increment: amount } } });
                await ledger.post(tx, {
                    idempotencyKey: 'ledger:deposit:fiat:FIAT-1',
                    entryType: 'DEPOSIT', description: 'fiat-settled deposit at quoted rate',
                    reference: 'FIAT-1', userId: user.id,
                    relatedEntity: 'transactionHistory', relatedEntityId: fiatRow.id,
                    lines: [
                        { account: 'clearing:conversion', debit: amount },
                        { account: `user:${user.id}:liability`, credit: amount },
                    ],
                });
            });
            expect((await userBal(user.id)).toFixed(2)).toBe('12.34');
            const clearing = await bal('clearing:conversion');
            expect(clearing.balance.toFixed(2)).toBe('12.34'); // explicit, explainable
            // NO fake inventory, NO fake custody asset was ever posted.
            expect((await bal('inventory:usdc:lots')).balance.toFixed(8)).toBe('0.00000000');
            expect((await bal('custody:deposit:usdc')).balance.toFixed(8)).toBe('0.00000000');
            expect((await bal('custody:hot:usdc')).balance.toFixed(8)).toBe('0.00000000');
            // Reconciliation explains the clearing balance exactly.
            const rec = await reconciliation.reconcileClearingConversion(prisma);
            expect(rec.exceptions).toHaveLength(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('15, 17. fiat withdrawal lifecycle: provider-settlement-safe, exact reserve/settle/reverse', () => {
        async function seedFinanceSettings() {
            await prisma.globalSettings.create({ data: { id: 1 } });
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { liveRetailRate: '15.5', liveRateSource: 'TEST', lastExternalSync: new Date() },
            });
            await prisma.systemFiatPool.create({ data: { id: 1, balance: 100000 } });
        }

        it('reservation debits the customer and restricts the funds; NOTHING is realized before provider SUCCESS; settlement realizes exactly once', async () => {
            await seedFinanceSettings();
            const user = await seedUser(prisma, { availableBalance: 100 });
            const before = await avail(user.id);

            const withdrawal = await finance.processFiatWithdrawal(prisma, user.id, 10, { reference: 'FW-1' });
            expect(withdrawal.reference).toBe('FW-1');
            const exitFee = Number(withdrawal.exitFee);
            const totalDeduct = Number(withdrawal.totalDeducted);

            // Projection debited; ledger liability debited identically; funds restricted.
            expect((await avail(user.id)).eq(D(before).minus(D(totalDeduct)))).toBe(true);
            expect((await userBal(user.id)).eq(D('-' + totalDeduct))).toBe(true);
            expect((await bal('restricted:reserves')).balance.toFixed(6)).toBe(D(totalDeduct).toFixed(6));
            // Provider-settlement-safe: no revenue, no referrer, no provider asset yet.
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe('0.000000');
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: 'withdrawal:fiat:FW-1' } });
            expect(obligation.status).toBe('ACTIVE');
            expect(Number(obligation.amount)).toBe(totalDeduct);

            // Provider SUCCESS settlement: realize exactly once.
            const settled = await finance.completeFiatWithdrawal(prisma, 'FW-1', { providerTxId: 'PTX-1' });
            expect(settled.changed).toBe(true);
            expect((await bal('restricted:reserves')).balance.toFixed(6)).toBe('0.000000');
            // Wave-2: fiat settlement is a FIAT rail — the principal enters
            // clearing:fiat:offramp:usdc, NOT provider custody (that account is
            // reserved for real provider-held USDC). §P.5 reconciles the rail
            // against actual GHS liquidity movements.
            expect((await bal('clearing:fiat:offramp:usdc')).balance.toFixed(6)).toBe('10.000000');
            expect((await bal('custody:provider:usdc')).balance.toFixed(6)).toBe('0.000000');
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe(D(exitFee).toFixed(6));
            expect((await prisma.restrictedObligation.findUnique({ where: { reference: 'withdrawal:fiat:FW-1' } })).status).toBe('RELEASED');

            // Duplicate settlement: idempotent no-op, never double-realized.
            const dup = await finance.completeFiatWithdrawal(prisma, 'FW-1', { providerTxId: 'PTX-1' });
            expect(dup.changed).toBe(false);
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe(D(exitFee).toFixed(6));
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: 'ledger:withdrawal:fiat:settle:FW-1' } })).toBe(1);
        });

        it('17: definitive reversal refunds the customer EXACTLY once and cancels the obligation', async () => {
            await seedFinanceSettings();
            const user = await seedUser(prisma, { availableBalance: 100 });
            const before = await avail(user.id);
            const withdrawal = await finance.processFiatWithdrawal(prisma, user.id, 10, { reference: 'FW-2' });
            expect(withdrawal.reference).toBe('FW-2');
            const totalDeduct = Number(withdrawal.totalDeducted);

            const reversed = await finance.reverseFiatWithdrawal(prisma, 'FW-2');
            expect(reversed.alreadyReversed).toBe(false);
            expect(Number(reversed.refundedAmount)).toBe(totalDeduct);
            expect((await avail(user.id)).eq(before)).toBe(true); // full refund, exactly once
            expect((await bal('restricted:reserves')).balance.toFixed(6)).toBe('0.000000');
            expect((await bal('revenue:fees')).balance.toFixed(6)).toBe('0.000000'); // nothing realized ever
            expect((await prisma.restrictedObligation.findUnique({ where: { reference: 'withdrawal:fiat:FW-2' } })).status).toBe('CANCELLED');

            // Second reversal attempt: idempotent, never a second refund.
            const again = await finance.reverseFiatWithdrawal(prisma, 'FW-2');
            expect(again.alreadyReversed).toBe(true);
            expect((await avail(user.id)).eq(before)).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('16-17. escrow reclassification: total customer liability is invariant; refund lands exactly once', () => {
        const totalCustomerLiability = async (userId) => {
            const available = await ledger.userLiabilityBalance(prisma, userId);
            const escrowAccounts = await prisma.ledgerAccount.findMany({
                where: { userId, code: { startsWith: 'escrow:' }, status: 'ACTIVE' },
                select: { code: true },
            });
            let escrow = new Prisma.Decimal(0);
            for (const a of escrowAccounts) escrow = escrow.plus((await bal(a.code)).balance);
            return available.plus(escrow);
        };

        it('escrow internal reclassification does NOT change total customer liability; release-to-counterparty and refund each land exactly once', async () => {
            const [sender, receiver] = [await seedUser(prisma, { availableBalance: 0 }), await seedUser(prisma, { availableBalance: 0 })];
            // Sender has 100 available liability.
            await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:escrow:fund',
                entryType: 'DEPOSIT', description: 'funding',
                lines: [
                    { account: 'clearing:conversion', debit: '100' },
                    { account: `user:${sender.id}:liability`, credit: '100' },
                ],
            }));
            await prisma.user.update({ where: { id: sender.id }, data: { availableBalance: { increment: 100 } } });
            const before = await totalCustomerLiability(sender.id);
            expect(before.toFixed(0)).toBe('100');

            // Escrow LOCK: available -> escrow:{id}:locked (internal reclassification).
            const lockLines = () => ([
                { account: `user:${sender.id}:liability`, debit: '40' },
                { account: `escrow:trade-1:locked`, credit: '40' },
            ]);
            await prisma.$transaction(async (tx) => {
                await ledger.ensureAccount(tx, `escrow:trade-1:locked`, { userId: sender.id });
                await ledger.post(tx, { idempotencyKey: 'test:escrow:lock', entryType: 'ESCROW_LOCK', description: 'lock', lines: lockLines() });
                await tx.user.update({ where: { id: sender.id }, data: { availableBalance: { decrement: 40 }, escrowLockedBalance: { increment: 40 } } });
            });
            expect((await totalCustomerLiability(sender.id)).toFixed(0)).toBe('100'); // INVARIANT
            expect((await ledger.userLiabilityBalance(prisma, sender.id)).toFixed(0)).toBe('60');
            expect((await bal('escrow:trade-1:locked')).balance.toFixed(0)).toBe('40');

            // REFUND path: escrow returns to the owner exactly once.
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: 'test:escrow:refund',
                    entryType: 'ESCROW_REFUND', description: 'refund',
                    lines: [
                        { account: 'escrow:trade-1:locked', debit: '40' },
                        { account: `user:${sender.id}:liability`, credit: '40' },
                    ],
                });
                await tx.user.update({ where: { id: sender.id }, data: { availableBalance: { increment: 40 }, escrowLockedBalance: { decrement: 40 } } });
            });
            expect((await totalCustomerLiability(sender.id)).toFixed(0)).toBe('100');
            const replayRefund = await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:escrow:refund',
                entryType: 'ESCROW_REFUND', description: 'refund',
                lines: [
                    { account: 'escrow:trade-1:locked', debit: '40' },
                    { account: `user:${sender.id}:liability`, credit: '40' },
                ],
            }));
            expect(replayRefund.replayed).toBe(true); // exactly once — replay returns the committed result
            expect((await bal('escrow:trade-1:locked')).balance.toFixed(0)).toBe('0');

            // RELEASE-to-counterparty path: total SENDER liability drops by the
            // released amount; RECEIVER liability rises identically (not revenue).
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, { idempotencyKey: 'test:escrow:lock-2', entryType: 'ESCROW_LOCK', description: 'lock 2', lines: lockLines() });
                await ledger.post(tx, {
                    idempotencyKey: 'test:escrow:release',
                    entryType: 'ESCROW_RELEASE', description: 'release to counterparty',
                    lines: [
                        { account: 'escrow:trade-1:locked', debit: '40' },
                        { account: `user:${receiver.id}:liability`, credit: '40' },
                    ],
                });
            });
            expect((await totalCustomerLiability(sender.id)).toFixed(0)).toBe('60');
            expect((await ledger.userLiabilityBalance(prisma, receiver.id)).toFixed(0)).toBe('40');
            expect((await bal('revenue:fees')).balance.toFixed(8)).toBe('0.00000000'); // internal transfer is NEVER revenue
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('18-19. restricted denominator: deterministic, fail-closed; synthetic singletons never authoritative', () => {
        it('authoritativeTotals sums ACTIVE obligations exactly and is INCOMPLETE (fail-closed) until every family is authoritative', async () => {
            const user = await seedUser(prisma);
            const t = await restrictedObligations.authoritativeTotals(prisma);
            expect(t.total.toFixed(0)).toBe('0');
            expect(t.complete).toBe(false); // escrow/dispute/vendor families unmodelled -> PoR cannot claim full backing

            await prisma.$transaction(async (tx) => {
                await restrictedObligations.createForPendingWithdrawal(tx, {
                    sourceType: 'PENDING_FIAT_WITHDRAWAL', reference: 'RO-1',
                    userId: user.id, amount: '10.5', sourceEntity: 'transactionHistory', sourceEntityId: 'FW-X',
                });
                await restrictedObligations.createForPendingWithdrawal(tx, {
                    sourceType: 'PENDING_CRYPTO_WITHDRAWAL', reference: 'RO-2',
                    userId: user.id, amount: '2.25', sourceEntity: 'custodyExecution', sourceEntityId: 'EX-Y',
                });
            });
            const after = await restrictedObligations.authoritativeTotals(prisma);
            expect(after.total.toFixed(2)).toBe('12.75');
            expect(after.complete).toBe(false);
            // Deterministic read: repeated queries return the identical total.
            const again = await restrictedObligations.authoritativeTotals(prisma);
            expect(again.total.toFixed(2)).toBe('12.75');

            // Release removes exactly the released amount from the denominator.
            await prisma.$transaction((tx) => restrictedObligations.releaseOnSettlement(tx, { reference: 'RO-2' }));
            const finalT = await restrictedObligations.authoritativeTotals(prisma);
            expect(finalT.total.toFixed(2)).toBe('10.50');
        });

        it('synthetic singleton balances can NEVER affect authoritative reserve/ledger calculations', async () => {
            const user = await seedUser(prisma);
            // Park a huge synthetic "treasury" — display-only bookkeeping.
            await prisma.systemMasterCrypto.create({ data: { id: 1, balance: 9999999 } });
            await prisma.systemHotWallet.create({ data: { id: 1, balance: 8888888 } });
            // Ledger balances ignore singletons by construction — only
            // ledger-linked JournalEntry lines count.
            expect((await bal('custody:hot:usdc')).balance.toFixed(8)).toBe('0.00000000');
            const t = await restrictedObligations.authoritativeTotals(prisma);
            expect(t.total.toFixed(0)).toBe('0'); // obligations derive from RestrictedObligation rows only
            const user0 = await ledger.userLiabilityBalance(prisma, user.id);
            expect(user0.toFixed(8)).toBe('0.00000000');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('20. reconciliation: read-only detection, never silent repair', () => {
        it('flags projection/ledger disagreement in BOTH directions and never rewrites anything', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            // (a) ledger-only transfer: the ledger moved, the projection didn't.
            await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:recon:1',
                entryType: 'TRANSFER', description: 'ledger-only movement',
                lines: [
                    { account: `user:${user.id}:liability`, debit: '30' },
                    { account: 'clearing:conversion', credit: '30' },
                ],
            }));
            let report = await reconciliation.reconcileUserProjections(prisma);
            const hit = report.exceptions.find(e => e.kind === 'PROJECTION_LEDGER_DISAGREEMENT' && e.userId === user.id);
            expect(hit).toBeDefined();
            expect(hit.difference).toBe('30.00000000'); // projection 0 minus ledger -30

            // Reconciliation must NOT have repaired anything.
            expect((await avail(user.id)).toString()).toBe('0');
            expect((await userBal(user.id)).toFixed(0)).toBe('-30');

            // (b) rogue projection mutation without a ledger posting.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: { increment: 55 } } });
            report = await reconciliation.reconcileUserProjections(prisma);
            const hit2 = report.exceptions.find(e => e.kind === 'PROJECTION_LEDGER_DISAGREEMENT' && e.userId === user.id);
            expect(hit2).toBeDefined();
            expect(hit2.difference).toBe('85.00000000'); // 55 rogue - 30 ledger-only
        });

        it('restricted obligations vs restricted:reserves ledger balance must agree exactly', async () => {
            const user = await seedUser(prisma);
            // Obligation without a ledger reservation leg: drift is flagged.
            await prisma.$transaction(async (tx) => {
                await restrictedObligations.createForPendingWithdrawal(tx, {
                    sourceType: 'PENDING_FIAT_WITHDRAWAL', reference: 'DRIFT-1',
                    userId: user.id, amount: '5', sourceEntity: 'transactionHistory', sourceEntityId: 'FW-Z',
                });
            });
            let rec = await reconciliation.reconcileRestrictedObligations(prisma);
            expect(rec.exceptions[0].kind).toBe('RESTRICTED_LEDGER_DISAGREEMENT');
            // Now post the matching reservation: exact agreement.
            await prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'test:recon:restricted',
                entryType: 'WITHDRAWAL', description: 'reservation',
                lines: [
                    { account: `user:${user.id}:liability`, debit: '5' },
                    { account: 'restricted:reserves', credit: '5' },
                ],
            }));
            rec = await reconciliation.reconcileRestrictedObligations(prisma);
            expect(rec.exceptions).toHaveLength(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('21. migration installer: idempotent, never mutates financial data', () => {
        it('re-running the installer is safe and deterministic', async () => {
            const { execFileSync } = require('child_process');
            const run = () => execFileSync('node', ['scripts/p4LedgerInstaller.js'], {
                env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
                cwd: process.cwd(),
            }).toString();
            const out1 = run();
            expect(out1).toMatch(/canonical chart ensured/i);
            const before = await prisma.ledgerAccount.count();
            run(); // idempotent — safe to re-run
            const after = await prisma.ledgerAccount.count();
            expect(after).toBe(before);
            expect(Object.keys(ledger.CANONICAL_ACCOUNTS).includes('restricted:reserves')).toBe(true);
            // The installer never performs financial backfill.
            expect(await prisma.ledgerTransaction.count()).toBe(0);
        });
    });
});
