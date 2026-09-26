// __tests__/r23-custody-denial-approval-races.test.js
// =============================================================================
// r23 — CUSTODY EXECUTION DENIAL/APPROVAL/SUBMISSION RACES + FAIRNESS — proofs.
//
// Proves the r23 defect fixes against REAL PostgreSQL:
//  D1  denial evidence contract — a denial from pre-submission states is
//      definitive (FAILED + exactly-once refund); a denial past the submission
//      CAS is QUARANTINED regardless of provider-cancel success (cancel is
//      not broadcast proof); a denial racing a submission is single-winner by
//      CAS (never a refund without FAILED, never a provider call after a
//      winning denial).
//  D2  approval is a conditional (CAS) write — never restorable after a
//      denial/terminal state; idempotent repeats converge.
//  D3  linked-record identity — settlement and refund both refuse misbound
//      TransactionHistory rows (wrong owner / wrong type / conflicting
//      economics / competing txHash) and quarantine instead; the victim
//      record is never mutated.
//  D5  recovery fairness — due-time backoff scheduling means a permanently
//      unresolvable backlog can never starve a fresh row; human-owned
//      quarantine classes are excluded from the automatic scan.
//  D6  REQUESTED is an owned recovery state (stale rows converge like RESERVING).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r23-races] TEST_DATABASE_URL not set — skipping DB proofs.');

const custody = require('../services/tatumCustodyExecutionService');
const recovery = require('../services/custodyRecoveryService');
const { ERROR_CLASSES } = require('../services/custodyExecutionErrors');

const { STATUSES } = custody;

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const DEST = '0x' + '33'.repeat(20);
const NATIVE = custody.CANONICAL.contractAddress;
const TX_HASH = '0x' + 'ab'.repeat(32);
const TX_HASH_2 = '0x' + 'cd'.repeat(32);
const HOT_SIG = 'test-hot-signature-id';
const CUST_SIG = 'test-kms-signature-id';

const SAVED_ENV = {};
const ENV_KEYS = ['TATUM_PROVIDER', 'TATUM_API_KEY', 'TATUM_KMS_ENABLED', 'TATUM_CRYPTO_EXECUTION_ENABLED',
    'TATUM_KMS_SIGNATURE_ID', 'TATUM_KMS_CHAIN', 'TATUM_KMS_ENVIRONMENT', 'TATUM_KMS_FOUR_EYE_REQUIRED',
    'TATUM_HOT_WALLET_SIGNATURE_ID', 'TATUM_HOT_WALLET_INDEX', 'TATUM_HOT_WALLET_ADDRESS',
    'TATUM_TREASURY_ADDRESS', 'TATUM_KMS_SIGNER_REGISTRY', 'TATUM_KMS_VALIDATOR_ALLOWED_IPS', 'TATUM_BASE_URL',
    'TATUM_CUSTODY_RESERVING_STALE_MINUTES', 'TATUM_CUSTODY_SUBMITTED_GRACE_MINUTES'];
beforeAll(() => { for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k]; });
afterAll(() => {
    for (const k of ENV_KEYS) {
        if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
    }
    custody.__setProviderForTests(null);
});

function enableGates(overrides = {}) {
    process.env.TATUM_PROVIDER = 'LIVE';
    process.env.TATUM_API_KEY = 'test-tatum-key';
    process.env.TATUM_KMS_ENABLED = 'true';
    process.env.TATUM_CRYPTO_EXECUTION_ENABLED = 'true';
    process.env.TATUM_KMS_SIGNATURE_ID = CUST_SIG;
    process.env.TATUM_KMS_CHAIN = 'POLYGON';
    process.env.TATUM_KMS_ENVIRONMENT = 'TESTNET';
    process.env.TATUM_KMS_FOUR_EYE_REQUIRED = 'true';
    process.env.TATUM_HOT_WALLET_SIGNATURE_ID = HOT_SIG;
    process.env.TATUM_HOT_WALLET_INDEX = '0';
    process.env.TATUM_HOT_WALLET_ADDRESS = HOT;
    delete process.env.TATUM_TREASURY_ADDRESS;
    process.env.TATUM_KMS_SIGNER_REGISTRY = JSON.stringify([
        { signatureId: CUST_SIG, index: 5, address: CUST, model: 'MNEMONIC_INDEXED' },
        { signatureId: HOT_SIG, index: 0, address: HOT, model: 'MNEMONIC_INDEXED' },
    ]);
    delete process.env.TATUM_KMS_VALIDATOR_ALLOWED_IPS;
    delete process.env.TATUM_CUSTODY_RESERVING_STALE_MINUTES;
    delete process.env.TATUM_CUSTODY_SUBMITTED_GRACE_MINUTES;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

function transferCalldata(recipient, amountBaseUnits) {
    const bn = BigInt(amountBaseUnits);
    return '0x' + 'a9059cbb'
        + recipient.slice(2).toLowerCase().padStart(64, '0')
        + bn.toString(16).padStart(64, '0');
}

function fakeProvider(behavior = {}) {
    const p = {
        name: 'FAKE',
        submitted: [],
        listed: 0,
        deletes: [],
        async submitTokenTransfer(payload) {
            if (behavior.submitError) throw behavior.submitError;
            p.submitted.push(payload);
            return { pendingId: behavior.submitPendingId || 'tatum-pending-9', txHash: behavior.submitTxHash || null };
        },
        async getKmsRequest(id) {
            if (behavior.kmsError) throw behavior.kmsError;
            const r = behavior.kmsRequest || { id, txHash: null, status: null };
            return { ...r };
        },
        async listPendingRequests(chain = 'MATIC') {
            p.listed++;
            if (behavior.listError) throw behavior.listError;
            return (behavior.pendings || []).map((x) => ({ ...x }));
        },
        async deletePendingRequest(pendingId) {
            if (behavior.deleteError) throw behavior.deleteError;
            p.deletes.push(pendingId);
            return true;
        },
        async getTransaction(hash) {
            if (behavior.transaction === null) return null;
            return behavior.transaction ? { ...behavior.transaction } : null;
        },
    };
    return p;
}

function makePending({ id, chain = 'MATIC', hashes = [HOT_SIG], index = 0, to = DEST, amount = 1000000n, contract = NATIVE, txId = null, serialized = null }) {
    return {
        id,
        chain,
        hashes,
        index,
        txId,
        serializedTransaction: serialized !== null
            ? serialized
            : JSON.stringify({ data: transferCalldata(to, amount), to: contract, chainId: 137, nonce: 1 }),
    };
}

// ── UNIT LAYER ───────────────────────────────────────────────────────────────

describe('r23 unit — decoder fail-closed contract (D4)', () => {
    it('JSON without an explicit token contract is UNUSABLE evidence', () => {
        const json = JSON.stringify({ data: transferCalldata(DEST, 1000000n) });
        expect(recovery.decodePendingTransferSemantics(json)).toBeNull();
    });

    it('matchesExecution treats a decode without a contract as unusable (no binding)', () => {
        const exec = { contractAddress: NATIVE, toAddress: DEST, amountBaseUnits: 1000000n, fromAddress: HOT };
        const verdict = recovery.matchesExecution(
            { ...makePending({ id: 'x1' }), serializedTransaction: JSON.stringify({ data: transferCalldata(DEST, 1000000n) }) },
            exec,
            { expectedSignatureId: HOT_SIG, expectedIndex: 0 }
        );
        expect(verdict.usable).toBe(false);
        expect(verdict.match).toBe(false);
    });

    it('recovery backoff grows 60s → 300s → 900s cap (D5)', () => {
        expect(recovery.recoveryBackoffMs(0)).toBe(60 * 1000);
        expect(recovery.recoveryBackoffMs(2)).toBe(60 * 1000);
        expect(recovery.recoveryBackoffMs(3)).toBe(300 * 1000);
        expect(recovery.recoveryBackoffMs(6)).toBe(900 * 1000);
        expect(recovery.recoveryBackoffMs(99)).toBe(900 * 1000); // capped
    });

    it('REQUESTED has a real recovery owner in the state machine (D6)', () => {
        expect(custody.STATE_MACHINE[STATUSES.REQUESTED].recoveryOwner)
            .toBe('custodyRecoveryService.recoverReservingExecutions');
    });
});

// ── REAL POSTGRESQL LAYER ────────────────────────────────────────────────────

describeOrSkip('r23 races (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(() => { enableGates(); });

    afterEach(async () => {
        custody.__setProviderForTests(null);
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "CustodyExecution", "OnchainSweep", "TransactionHistory", "User", ' +
            '"SystemHotWallet", "SystemProfitFees", "AdminProfitLog", "AuditLog", "JournalEntry", ' +
            '"LedgerTransaction", "LedgerAccount", "RestrictedObligation", ' +
            '"CustodyAccount", "CustodyMovement", "CustodyEvidence", "WalletAddress" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    let userSeq = 0;
    async function seedUser(balance = 500) {
        const id = 'r23-' + Date.now() + '-' + (++userSeq) + '-' + Math.random().toString(36).slice(2, 8);
        return prisma.user.create({
            data: {
                username: 'user_' + id,
                email: id + '@test.local',
                password: 'x'.repeat(60),
                availableBalance: balance,
                azamanId: 'AZM-TEST-' + id,
                phoneVerified: false,
            },
        });
    }

    async function seedReservedWithdrawal({ user, amountBase = 1000000n, feeBase = 27500n, createdAt = null }) {
        const txRecord = await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'WITHDRAWAL_CRYPTO',
                amountUsdc: Number(amountBase - feeBase) / 1e6, feeUsdc: Number(feeBase) / 1e6,
                txHash: null, status: 'PENDING',
            },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: 'withdrawal:' + txRecord.id,
            transactionHistoryId: txRecord.id,
            userId: user.id,
            fromAddress: HOT,
            toAddress: DEST,
            amountBaseUnits: amountBase - feeBase,
            feeChargeBaseUnits: feeBase,
            metadata: { customerDebitBaseUnits: String(amountBase), netPayoutBaseUnits: String(amountBase - feeBase) },
        });
        if (createdAt) {
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { createdAt } });
        }
        const ledger = require('../services/ledgerService');
        const restrictedObligations = require('../services/restrictedObligationService');
        await prisma.$transaction(async (tx) => {
            const reservation = await ledger.post(tx, {
                idempotencyKey: 'ledger:withdrawal:crypto:execution:' + execution.id,
                entryType: 'CUSTODY_WITHDRAWAL',
                description: 'Crypto withdrawal reservation (test)',
                reference: 'custody-exec:' + execution.id,
                userId: user.id,
                relatedEntity: 'custodyExecution',
                relatedEntityId: execution.id,
                metadata: { status: 'PENDING', transactionHistoryId: txRecord.id },
                lines: [
                    { account: 'user:' + user.id + ':liability', debit: '1' },
                    { account: 'restricted:reserves', credit: '1' },
                ],
            });
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_CRYPTO_WITHDRAWAL',
                reference: 'withdrawal:crypto:' + execution.id,
                userId: user.id,
                amount: '1',
                asset: 'USDC',
                network: 'POLYGON',
                sourceEntity: 'custodyExecution',
                sourceEntityId: execution.id,
                ledgerTransactionId: reservation.transaction.id,
                domainStateRef: { custodyExecutionId: execution.id, transactionHistoryId: txRecord.id },
            });
        });
        return { txRecord, execution };
    }

    async function balanceOf(userId) {
        return (await prisma.user.findUnique({ where: { id: userId } })).availableBalance;
    }

    async function currentExec(id) {
        return prisma.custodyExecution.findUnique({ where: { id } });
    }

    const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

    // ── D1: denial evidence contract ───────────────────────────────────────

    describe('D1 — denial evidence contract', () => {
        it('deny from RESERVING is definitive: FAILED + exactly-once refund + DENIED, zero provider calls', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            const provider = fakeProvider({});
            custody.__setProviderForTests(provider);

            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied', provider);
            expect(denied.approvalStatus).toBe('DENIED');
            expect(denied.denialLimitation).toBe('FAILED_REFUNDED_PRE_SUBMISSION');
            expect(provider.submitted).toHaveLength(0); // no provider I/O can have happened
            expect(provider.deletes).toHaveLength(0);  // nothing to cancel (no pending exists)
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect(after.errorClass).toBe(ERROR_CLASSES.CONFIGURATION_ERROR);
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: after.refId } })).status).toBe('FAILED');
        });

        it('deny from SUBMITTED (no pendingId, no provider) quarantines — never refunds', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.SUBMITTED, submittedAt: HOUR_AGO },
            });

            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied', null);
            expect(denied.approvalStatus).toBe('DENIED');
            expect(denied.denialLimitation).toBe('QUARANTINED_POST_SUBMISSION');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.UNKNOWN_OUTCOME);
            // The linked record and money are UNTOUCHED — human reconciliation.
            expect((await balanceOf(user.id)).toString()).toBe(before.toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: after.refId } })).status).toBe('PENDING');
        });

        it('a REPEATED denial records the fact only — never a second refund (idempotent by construction)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await custody.denyKmsRequest(prisma, execution.id, 'first denial');
            const afterFirst = await balanceOf(user.id);

            const second = await custody.denyKmsRequest(prisma, execution.id, 'repeated denial');
            expect(second.denialLimitation).toBe('ALREADY_TERMINAL');
            expect(second.approvalStatus).toBe('DENIED');
            expect((await balanceOf(user.id)).toString()).toBe(afterFirst.toString());
            const refunds = await prisma.ledgerTransaction.count({
                where: { idempotencyKey: 'ledger:withdrawal:crypto:refund:' + execution.id },
            });
            expect(refunds).toBe(1); // exactly one refund across both denials
        });

        it('deny of a DEPOSIT_SWEEP from RESERVING fails the sweep with no customer money touched', async () => {
            const execution = await prisma.custodyExecution.create({
                data: {
                    idempotencyKey: 'sweep:deny-1', kind: 'DEPOSIT_SWEEP', refId: null, userId: null,
                    network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                    fromAddress: CUST, toAddress: HOT, amountBaseUnits: 1000000n, decimals: 6,
                    status: STATUSES.RESERVING, approvalStatus: 'PENDING',
                },
            });
            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied');
            expect(denied.denialLimitation).toBe('FAILED_REFUNDED_PRE_SUBMISSION');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect(after.approvalStatus).toBe('DENIED');
        });

        it('THE P0 RACE: denial while a submission is IN FLIGHT — exactly one winner, never both refund and provider call', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });

            // Provider whose submitTokenTransfer BLOCKS until the denial has
            // run — the exact interleaving that produced the P0: the daemon
            // fetch (provider call) is already in flight when the operator
            // denies.
            let releaseSubmit;
            const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
            const provider = {
                name: 'GATED',
                submitted: 0,
                deletes: [],
                async submitTokenTransfer() {
                    provider.submitted++;
                    await submitGate; // hold the call open across the denial
                    return { pendingId: 'inflight-pending-1', txHash: null };
                },
                async listPendingRequests() { return []; },
                async deletePendingRequest(id) { provider.deletes.push(id); return true; },
                async getKmsRequest() { return { id: 'inflight-pending-1', txHash: null }; },
                async getTransaction() { return null; },
            };
            custody.__setProviderForTests(provider);

            // Four-eye approval first (the daemon never submits unapproved).
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: execution.refId, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits },
            });
            const submissionPromise = custody.submitExecution(prisma, { executionId: execution.id });
            // Give the submitter time to win the CAS and enter the provider call.
            await new Promise((r) => setTimeout(r, 150));
            expect((await currentExec(execution.id)).status).toBe(STATUSES.SUBMITTED);

            // The denial lands while the provider call is in flight.
            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied mid-flight');
            expect(denied.approvalStatus).toBe('DENIED');
            expect(denied.denialLimitation).toBe('QUARANTINED_POST_SUBMISSION');

            // Release the in-flight submission.
            releaseSubmit();
            const submission = await submissionPromise;

            // The submitter did NOT win a SIGNING claim — it converged.
            expect(submission.converged).toBe(true);
            expect(submission.status).toBe(STATUSES.RECONCILIATION_REQUIRED);

            const after = await currentExec(execution.id);
            // Single durable outcome: quarantined + DENIED (validator refuses
            // to sign DENIED — no future broadcast), NEVER refunded.
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.approvalStatus).toBe('DENIED');
            expect(provider.submitted).toBe(1); // the in-flight call happened; no second
            expect((await balanceOf(user.id)).toString()).toBe(before.toString()); // no refund
            expect((await prisma.transactionHistory.findUnique({ where: { id: after.refId } })).status).toBe('PENDING');
        });

        it('the mirror interleaving: denial WINS first → the submitter never calls the provider', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            const provider = fakeProvider({});
            custody.__setProviderForTests(provider);

            await custody.denyKmsRequest(prisma, execution.id, 'operator denied first');
            // The refund already converged the money; a late submitter must
            // not reach the provider.
            await expect(custody.submitExecution(prisma, { executionId: execution.id }))
                .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            expect(provider.submitted).toHaveLength(0);
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
        });

        it('a DENIED quarantine row is invisible to the automatic reconciliation scan (never resurrected)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.RECONCILIATION_REQUIRED, approvalStatus: 'DENIED', errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME },
            });
            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results).toHaveLength(0); // DENIED → human-owned, excluded
            // The row stays exactly as the denial left it.
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.approvalStatus).toBe('DENIED');
        });
    });

    // ── D2: approval is a CAS write ─────────────────────────────────────────

    describe('D2 — approval conditional write', () => {
        const approveArgs = (execution, user) => ({
            executionId: execution.id,
            expected: {
                kind: 'CUSTOMER_WITHDRAWAL', refId: execution.refId, userId: user.id,
                fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE,
                amountBaseUnits: execution.amountBaseUnits,
            },
        });

        it('approve after a denial is refused — APPROVED is never restored', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await custody.denyKmsRequest(prisma, execution.id, 'operator denied');
            await expect(custody.approveKmsRequest(prisma, approveArgs(execution, user)))
                .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            expect((await currentExec(execution.id)).approvalStatus).toBe('DENIED');
        });

        it('approve after the row FAILED (denied) is refused as stale', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await custody.denyKmsRequest(prisma, execution.id, 'operator denied');
            await expect(custody.approveKmsRequest(prisma, approveArgs(execution, user)))
                .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            expect((await currentExec(execution.id)).status).toBe(STATUSES.FAILED);
        });

        it('approve racing deny (Promise.all): exactly one durable outcome, never APPROVED-after-DENIED', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            const provider = fakeProvider({});
            custody.__setProviderForTests(provider);

            const [approveRes, denyRes] = await Promise.allSettled([
                custody.approveKmsRequest(prisma, approveArgs(execution, user)),
                custody.denyKmsRequest(prisma, execution.id, 'racing denial', provider),
            ]);
            const after = await currentExec(execution.id);

            // Invariant: the row is EITHER failed+refunded+DENIED or approved
            // and still RESERVING — never a mixed state, never money moved
            // without the FAILED transition (single-winner CAS on both paths).
            const deniedWon = after.status === STATUSES.FAILED && after.approvalStatus === 'DENIED';
            const approvedWon = after.status === STATUSES.RESERVING && after.approvalStatus === 'APPROVED';
            expect(approvedWon || deniedWon).toBe(true);
            if (deniedWon) {
                expect(denyRes.status).toBe('fulfilled');
                expect(approveRes.status).toBe('rejected'); // CAS lost → stale refusal
                expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
                expect(provider.submitted).toHaveLength(0);
            } else {
                // The approval won the CAS; the denial then re-classified the
                // row (its loop re-reads) and converged it definitively or was
                // refused — either way the invariant above holds and no
                // provider submission happened in this test.
                expect(approveRes.status).toBe('fulfilled');
                expect(provider.submitted).toHaveLength(0);
            }
            if (after.status === STATUSES.FAILED) {
                expect(after.approvalStatus).toBe('DENIED');
            }
        });

        it('a repeat approval on an already-APPROVED row is idempotent (alreadyApproved)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            const first = await custody.approveKmsRequest(prisma, approveArgs(execution, user));
            expect(first.approved).toBe(true);
            const again = await custody.approveKmsRequest(prisma, approveArgs(execution, user));
            expect(again.alreadyApproved).toBe(true);
        });

        it('an approval can never land on a quarantined row', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.RECONCILIATION_REQUIRED, errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME },
            });
            await expect(custody.approveKmsRequest(prisma, approveArgs(execution, user)))
                .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            expect((await currentExec(execution.id)).approvalStatus).toBe('PENDING');
        });
    });

    // ── D3: linked-record identity guards ───────────────────────────────────

    describe('D3 — settlement/refund linked-record identity', () => {
        function broadcastReceipt(execution) {
            return {
                status: '0x1',
                logs: [{
                    address: NATIVE,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x' + HOT.slice(2).padStart(64, '0'),
                        '0x' + DEST.slice(2).padStart(64, '0'),
                    ],
                    data: '0x' + BigInt(execution.amountBaseUnits).toString(16).padStart(64, '0'),
                }],
            };
        }

        async function seedBroadcastWithdrawal(user) {
            const { txRecord, execution } = await seedReservedWithdrawal({ user });
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: execution.refId, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.BROADCAST, txHash: TX_HASH, broadcastAt: new Date() },
            });
            custody.__setProviderForTests(fakeProvider({ transaction: broadcastReceipt(execution) }));
            return { txRecord, execution };
        }

        it('settlement refuses when the linked history row belongs to ANOTHER customer (wrong owner → quarantine, victim untouched)', async () => {
            const user = await seedUser(500);
            const victim = await seedUser(400);
            const victimRow = await prisma.transactionHistory.create({
                data: { userId: victim.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 0.9725, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
            });
            const { execution } = await seedBroadcastWithdrawal(user);
            // Corrupt the linkage: refId → the victim's record.
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { refId: victimRow.id } });

            const outcome = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(false);
            expect(outcome.reason).toBe('LINKED_HISTORY_WRONG_OWNER');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_MISMATCH);
            // The victim's record and money are UNTOUCHED.
            const victimAfter = await prisma.transactionHistory.findUnique({ where: { id: victimRow.id } });
            expect(victimAfter.status).toBe('PENDING');
            expect(victimAfter.txHash).toBeNull();
        });

        it('settlement refuses a linked row of the WRONG TYPE', async () => {
            const user = await seedUser(500);
            const wrongType = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'P2P_TRADE', amountUsdc: 0.9725, feeUsdc: 0, txHash: null, status: 'PENDING' },
            });
            const { execution } = await seedBroadcastWithdrawal(user);
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { refId: wrongType.id } });

            const outcome = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(outcome.reason).toBe('LINKED_HISTORY_WRONG_TYPE');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect((await prisma.transactionHistory.findUnique({ where: { id: wrongType.id } })).status).toBe('PENDING');
        });

        it('settlement refuses when the linked economics DISAGREE with the execution', async () => {
            const user = await seedUser(500);
            const mispriced = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 0.5, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
            });
            const { execution } = await seedBroadcastWithdrawal(user);
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { refId: mispriced.id } });

            const outcome = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(outcome.reason).toBe('LINKED_HISTORY_ECONOMIC_MISMATCH');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        });

        it('settlement refuses a COMPLETED row carrying a CONFLICTING txHash (two hash authorities → human)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedBroadcastWithdrawal(user);
            await prisma.transactionHistory.update({
                where: { id: execution.refId },
                data: { status: 'COMPLETED', txHash: TX_HASH_2 }, // a DIFFERENT hash
            });
            const outcome = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(outcome.reason).toBe('LINKED_HISTORY_TXHASH_CONFLICT');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            // The customer-facing hash was NOT silently overwritten.
            expect((await prisma.transactionHistory.findUnique({ where: { id: execution.refId } })).txHash).toBe(TX_HASH_2);
        });

        it('CONTROL: correctly-linked settlement still completes (guards do not overreach)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedBroadcastWithdrawal(user);
            const outcome = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(true);
            expect((await currentExec(execution.id)).status).toBe(STATUSES.COMPLETED);
            const hist = await prisma.transactionHistory.findUnique({ where: { id: execution.refId } });
            expect(hist.status).toBe('COMPLETED');
            expect(hist.txHash).toBe(TX_HASH);
        });

        it('a refund with a MISBOUND linked row is withheld and the failure becomes a quarantine (victim untouched)', async () => {
            const user = await seedUser(500);
            const victim = await seedUser(400);
            const victimBefore = await balanceOf(victim.id);
            const victimRow = await prisma.transactionHistory.create({
                data: { userId: victim.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 0.9725, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
            });
            const userBefore = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });
            // Corrupt: our execution's refId → the victim's PENDING withdrawal.
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { refId: victimRow.id } });

            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('QUARANTINED_REFUND_WITHHELD');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_MISMATCH);
            // NO money moved: our user was not refunded, the victim's row and
            // balance are untouched.
            expect((await balanceOf(user.id)).toString()).toBe(userBefore.toString());
            expect((await balanceOf(victim.id)).toString()).toBe(victimBefore.toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: victimRow.id } })).status).toBe('PENDING');
        });

        it('a verified chain REVERT with a misbound linked row withholds the refund and re-classifies for a human', async () => {
            const user = await seedUser(500);
            const victim = await seedUser(400);
            const victimRow = await prisma.transactionHistory.create({
                data: { userId: victim.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 0.9725, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
            });
            const userBefore = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: {
                    refId: victimRow.id,
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass: ERROR_CLASSES.CHAIN_REVERTED,
                    txHash: TX_HASH,
                },
            });
            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results[0].action).toBe('REVERT_REFUND_WITHHELD_QUARANTINED');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_MISMATCH); // human-owned class
            expect((await balanceOf(user.id)).toString()).toBe(userBefore.toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: victimRow.id } })).status).toBe('PENDING');
        });
    });

    // ── D5: recovery fairness / backoff scheduling ─────────────────────────

    describe('D5 — recovery fairness under backlog', () => {
        const BACKLOG_DEST = '0x' + '77'.repeat(20); // differs from the fresh row's DEST

        async function seedUnresolvableSubmitted(seq, createdAt) {
            // Crash-after-claim SUBMITTED row whose only available pending
            // matches NEITHER its recipient NOR its amount — genuinely
            // unresolvable by evidence (QUARANTINED_NO_MATCH each pass).
            return prisma.custodyExecution.create({
                data: {
                    idempotencyKey: 'withdrawal:stale-' + seq + '-' + Math.random().toString(36).slice(2),
                    kind: 'CUSTOMER_WITHDRAWAL', refId: null, userId: null,
                    network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                    fromAddress: HOT, toAddress: BACKLOG_DEST, amountBaseUnits: 700000n,
                    status: STATUSES.SUBMITTED, approvalStatus: 'APPROVED',
                    submittedAt: createdAt, createdAt,
                },
            });
        }

        it('a 30-row unresolvable backlog cannot starve a FRESH row (due-time scheduling)', async () => {
            const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
            for (let i = 0; i < 30; i++) await seedUnresolvableSubmitted(i, old);

            // The provider is DOWN for the backlog rows (listPendingRequests throws).
            const provider = fakeProvider({ listError: new Error('tatum outage') });
            custody.__setProviderForTests(provider);

            // Pass 1 (limit 25): only the first 25 backlog rows are examined
            // and rescheduled into a 60s backoff window.
            const pass1 = await recovery.recoverSubmittedExecutions(prisma, { provider, limit: 25, now: Date.now() });
            expect(pass1).toHaveLength(25);
            expect(pass1.every((r) => r.action === 'PROVIDER_UNAVAILABLE')).toBe(true);

            // The FRESH row appears now: crash-after-claim, pending BINDABLE.
            const fresh = await prisma.custodyExecution.create({
                data: {
                    idempotencyKey: 'withdrawal:fresh-1',
                    kind: 'CUSTOMER_WITHDRAWAL', refId: null, userId: null,
                    network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                    fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                    status: STATUSES.SUBMITTED, approvalStatus: 'APPROVED',
                    submittedAt: new Date(Date.now() - 30 * 60 * 1000), createdAt: new Date(Date.now() - 30 * 60 * 1000),
                },
            });
            const upProvider = fakeProvider({ pendings: [makePending({ id: 'fresh-pending-1' })] });
            custody.__setProviderForTests(upProvider);

            // Pass 2, one minute later: the backlog rows are INSIDE their
            // backoff window — the fresh row MUST be examined and bound.
            const pass2 = await recovery.recoverSubmittedExecutions(prisma, { provider: upProvider, limit: 25, now: Date.now() + 61 * 1000 });
            const freshResult = pass2.find((r) => r.executionId === fresh.id);
            expect(freshResult).toBeDefined();
            expect(freshResult.action).toBe('BOUND_SIGNING');
            expect((await currentExec(fresh.id)).status).toBe(STATUSES.SIGNING);
        });

        it('backoff grows per attempt and steps up to 5 minutes (schedule stamping)', async () => {
            const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
            const row = await seedUnresolvableSubmitted(0, old);
            const provider = fakeProvider({ listError: new Error('outage') });

            const t0 = Date.now();
            await recovery.recoverSubmittedExecutions(prisma, { provider, limit: 25, now: t0 });
            let after = await currentExec(row.id);
            expect(after.recoveryAttemptCount).toBe(1);
            expect(Number(new Date(after.nextRecoveryAttemptAt) - new Date(after.lastRecoveryAttemptAt))).toBe(60 * 1000);

            await recovery.recoverSubmittedExecutions(prisma, { provider, limit: 25, now: t0 + 61 * 1000 });
            await recovery.recoverSubmittedExecutions(prisma, { provider, limit: 25, now: t0 + 121 * 1000 });
            after = await currentExec(row.id);
            expect(after.recoveryAttemptCount).toBe(3);
            // 4th attempt scheduled +5 minutes (exponential step).
            await recovery.recoverSubmittedExecutions(prisma, { provider, limit: 25, now: t0 + 181 * 1000 });
            after = await currentExec(row.id);
            expect(Number(new Date(after.nextRecoveryAttemptAt) - new Date(after.lastRecoveryAttemptAt))).toBe(300 * 1000);
        });

        it('human-owned quarantine classes are EXCLUDED from the automatic reconciliation scan', async () => {
            await prisma.custodyExecution.create({
                data: {
                    idempotencyKey: 'withdrawal:human-1', kind: 'CUSTOMER_WITHDRAWAL', refId: null, userId: null,
                    network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                    fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                    status: STATUSES.RECONCILIATION_REQUIRED, approvalStatus: 'PENDING',
                    errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                },
            });
            await prisma.custodyExecution.create({
                data: {
                    idempotencyKey: 'withdrawal:human-2', kind: 'CUSTOMER_WITHDRAWAL', refId: null, userId: null,
                    network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                    fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                    status: STATUSES.RECONCILIATION_REQUIRED, approvalStatus: 'PENDING',
                    errorClass: ERROR_CLASSES.CONFIGURATION_ERROR,
                },
            });
            const provider = fakeProvider({});
            const results = await recovery.convergeReconciliationRequired(prisma, { provider, limit: 25, now: Date.now() });
            expect(results).toHaveLength(0); // human-owned: invisible to the bounded scan
        });
    });

    // ── D6: REQUESTED is an owned recovery state ────────────────────────────

    describe('D6 — REQUESTED recovery ownership', () => {
        async function seedRequested(user, approvalStatus) {
            const { txRecord, execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.REQUESTED, approvalStatus },
            });
            return { txRecord, execution };
        }

        it('a stale REQUESTED PENDING row is failed with an exactly-once refund', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedRequested(user, 'PENDING');
            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('FAILED_REFUNDED');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
        });

        it('a stale REQUESTED DENIED row is failed with an exactly-once refund', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedRequested(user, 'DENIED');
            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('FAILED_REFUNDED');
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
        });

        it('a stale REQUESTED APPROVED row re-enters the canonical submission boundary', async () => {
            const user = await seedUser(500);
            const { execution } = await seedRequested(user, 'APPROVED');
            const provider = fakeProvider({ submitPendingId: 'req-resubmit-1' });
            custody.__setProviderForTests(provider);
            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('RESUBMITTED');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.SIGNING);
            expect(provider.submitted).toHaveLength(1);
        });
    });
});
