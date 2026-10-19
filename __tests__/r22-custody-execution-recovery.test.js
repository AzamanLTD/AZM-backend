// __tests__/r22-custody-execution-recovery.test.js
// =============================================================================
// r22 — CUSTODY EXECUTION RECOVERY + TERMINAL CONVERGENCE (P0) — proofs.
//
// Three layers:
//  UNIT (no DB): ERC-20 calldata decoding, PendingTransaction matching against
//    the CURRENT Tatum contract (id/chain/hashes/serializedTransaction/index/
//    txId — no invented fields), state-machine completeness.
//  REAL POSTGRESQL: stale-RESERVING fail+refund (exactly once), canonical
//    re-submission through the durable boundary, SUBMITTED crash-window
//    resolution via provider pending evidence (bind / quarantine / converge),
//    quarantined-outcome convergence (UNKNOWN_OUTCOME rebinding, CHAIN_REVERTED
//    exactly-once refund, CHAIN_MISMATCH human quarantine), settle-time
//    TransactionHistory convergence guards (missing/FAILED record refusal,
//    real txHash atomicity), approval/denial race hardening, and the recovery
//    worker's bounded pass.
//  CONFIG: the dedicated 60s custody-recovery cadence is registered through the
//    existing BullMQ scheduler abstraction.
// =============================================================================

const fs = require('fs');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r22-recovery] TEST_DATABASE_URL not set — skipping DB proofs.');

const custody = require('../services/tatumCustodyExecutionService');
const recovery = require('../services/custodyRecoveryService');
const {
    ERROR_CLASSES,
} = require('../services/custodyExecutionErrors');

const { STATUSES } = custody;

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const DEST = '0x' + '33'.repeat(20);
const OTHER_DEST = '0x' + '44'.repeat(20);
const TX_HASH = '0x' + 'ab'.repeat(32);
const TX_HASH_2 = '0x' + 'cd'.repeat(32);
const NATIVE = custody.CANONICAL.contractAddress;

const HOT_SIG = 'test-hot-signature-id';
const CUST_SIG = 'test-kms-signature-id';

// Saved env so each test can toggle the gate flags safely.
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
function disableGates() {
    process.env.TATUM_PROVIDER = 'MOCK';
    delete process.env.TATUM_KMS_ENABLED;
    delete process.env.TATUM_CRYPTO_EXECUTION_ENABLED;
}

// ── ERC-20 evidence construction (the real ABI shape, nothing provider-invented)
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
        async completePendingRequest() { return true; },
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

// Current Tatum PendingTransaction shape: {id, chain, hashes[],
// serializedTransaction, index?, txId?}. JSON is the KMS EVM representation.
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

// ═════════════════════════════════════════════════════════════════════════════
// UNIT LAYER — evidence decoding, matching, state machine
// ═════════════════════════════════════════════════════════════════════════════

describe('r22 unit — ERC-20 calldata decoding (no DB)', () => {
    it('decodes exact recipient and exact base-unit amount from transfer calldata', () => {
        const decoded = recovery.decodeErc20TransferCalldata(transferCalldata(DEST, 1000000n));
        expect(decoded.recipient).toBe(DEST);
        expect(decoded.amountBaseUnits).toBe(1000000n);
    });

    it('rejects malformed / truncated calldata (never guesses semantics)', () => {
        expect(recovery.decodeErc20TransferCalldata('0xdeadbeef')).toBeNull();
        expect(recovery.decodeErc20TransferCalldata('not-hex')).toBeNull();
        expect(recovery.decodeErc20TransferCalldata('')).toBeNull();
        // A different selector (approve) is NOT a transfer.
        expect(recovery.decodeErc20TransferCalldata('0x095ea7b3' + 'ff'.repeat(128))).toBeNull();
    });

    it('decodes the JSON serialized representation (the ONLY admissible shape)', () => {
        const json = recovery.decodePendingTransferSemantics(
            JSON.stringify({ data: transferCalldata(DEST, 2500000n), to: NATIVE })
        );
        expect(json).toMatchObject({ contract: NATIVE, recipient: DEST, amountBaseUnits: 2500000n });
    });

    it('r23 D4: a bare-hex payload is UNUSABLE evidence — no selector-substring binding', () => {
        // The bare-hex fallback was removed (r23 D4): decoding a transfer
        // selector located inside an arbitrary hex blob produced semantics
        // WITHOUT an established token contract — a recipient/amount
        // collision could then bind ANY contract's transfer. Fail closed.
        const hex = '0x' + 'ee'.repeat(6) + transferCalldata(DEST, 700000n).slice(2);
        expect(recovery.decodePendingTransferSemantics(hex)).toBeNull();
        // JSON without an explicit `to` (the token contract) is unusable.
        expect(recovery.decodePendingTransferSemantics(
            JSON.stringify({ data: transferCalldata(DEST, 700000n) })
        )).toBeNull();
        // JSON with an invalid contract address is unusable.
        expect(recovery.decodePendingTransferSemantics(
            JSON.stringify({ data: transferCalldata(DEST, 700000n), to: '0x123' })
        )).toBeNull();
    });

    it('treats an unparseable serialized transaction as UNUSABLE evidence — never a mismatch, never a match', () => {
        expect(recovery.decodePendingTransferSemantics('random-garbage')).toBeNull();
        expect(recovery.decodePendingTransferSemantics('')).toBeNull();
        expect(recovery.decodePendingTransferSemantics(null)).toBeNull();
    });
});

describe('r22 unit — PendingTransaction matching (CURRENT documented contract)', () => {
    const exec = {
        contractAddress: NATIVE, toAddress: DEST, amountBaseUnits: 1000000n,
        fromAddress: HOT,
    };

    it('binds only on exact chain + signature identity + exact decoded semantics', () => {
        const verdict = recovery.matchesExecution(
            makePending({ id: 'p1', hashes: [HOT_SIG], index: 0, to: DEST, amount: 1000000n }),
            exec,
            { expectedSignatureId: HOT_SIG, expectedIndex: 0 }
        );
        expect(verdict.usable).toBe(true);
        expect(verdict.match).toBe(true);
    });

    it('a different KMS signature identity, chain, or derivation index is not our pending', () => {
        expect(recovery.matchesExecution(
            makePending({ id: 'p2', chain: 'ETH' }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }).match
        ).toBe(false);
        expect(recovery.matchesExecution(
            makePending({ id: 'p3', hashes: ['some-other-signature-id'] }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }).match
        ).toBe(false);
        expect(recovery.matchesExecution(
            makePending({ id: 'p4', index: 7 }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }).match
        ).toBe(false);
    });

    it('decoded-but-DIFFERENT recipient/amount is a positive NON-match (another operation)', () => {
        const wrongRecipient = recovery.matchesExecution(
            makePending({ id: 'p5', to: OTHER_DEST, amount: 1000000n }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }
        );
        expect(wrongRecipient.usable).toBe(true);
        expect(wrongRecipient.match).toBe(false);
        const wrongAmount = recovery.matchesExecution(
            makePending({ id: 'p6', to: DEST, amount: 999999n }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }
        );
        expect(wrongAmount.usable).toBe(true);
        expect(wrongAmount.match).toBe(false);
    });

    it('an unparseable payload is unusable evidence — no probabilistic binding', () => {
        const verdict = recovery.matchesExecution(
            makePending({ id: 'p7', serialized: 'not-parseable' }), exec, { expectedSignatureId: HOT_SIG, expectedIndex: 0 }
        );
        expect(verdict.usable).toBe(false);
        expect(verdict.match).toBe(false);
    });
});

describe('r22 unit — the execution state machine is complete and enforced', () => {
    it('every CustodyExecution status has an explicit recovery owner and evidence source', () => {
        const statuses = Object.values(STATUSES);
        for (const status of statuses) {
            expect(custody.STATE_MACHINE[status]).toBeDefined();
            expect(typeof custody.STATE_MACHINE[status].recoveryOwner).toBe('string');
            expect(custody.STATE_MACHINE[status].recoveryOwner).not.toBe('');
        }
        // Every non-terminal status is resumable; COMPLETED/FAILED are not.
        // RECONCILIATION_REQUIRED is terminal-BUT-resumable BY DESIGN: its
        // entire recovery owner is convergence out of quarantine.
        for (const status of statuses) {
            if (status === STATUSES.COMPLETED || status === STATUSES.FAILED) {
                expect(custody.STATE_MACHINE[status].resumable).toBe(false);
            } else {
                expect(custody.STATE_MACHINE[status].resumable).toBe(true);
            }
        }
        expect(custody.STATE_MACHINE[STATUSES.RECONCILIATION_REQUIRED].recoveryOwner)
            .toBe('custodyRecoveryService.convergeReconciliationRequired');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// REAL POSTGRESQL LAYER
// ═════════════════════════════════════════════════════════════════════════════

describeOrSkip('r22 recovery (real PostgreSQL)', () => {
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
        const id = `r22-${Date.now()}-${++userSeq}-${Math.random().toString(36).slice(2, 8)}`;
        return prisma.user.create({
            data: {
                username: `user_${id}`,
                email: `${id}@test.local`,
                password: 'x'.repeat(60),
                availableBalance: balance,
                azamanId: `AZM-TEST-${id}`,
                phoneVerified: false,
            },
        });
    }

    // The full §P.4 reservation stack the controller creates: debited user,
    // PENDING history row, ledger reservation, linked restricted obligation.
    async function seedReservedWithdrawal({ user, amountBase = 1000000n, feeBase = 27500n, createdAt = null }) {
        const txRecord = await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'WITHDRAWAL_CRYPTO',
                amountUsdc: Number(amountBase - feeBase) / 1e6, feeUsdc: Number(feeBase) / 1e6,
                txHash: null, status: 'PENDING',
            },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${txRecord.id}`,
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
                idempotencyKey: `ledger:withdrawal:crypto:execution:${execution.id}`,
                entryType: 'CUSTODY_WITHDRAWAL',
                description: 'Crypto withdrawal reservation (test)',
                reference: `custody-exec:${execution.id}`,
                userId: user.id,
                relatedEntity: 'custodyExecution',
                relatedEntityId: execution.id,
                metadata: { status: 'PENDING', transactionHistoryId: txRecord.id },
                lines: [
                    { account: `user:${user.id}:liability`, debit: '1' },
                    { account: 'restricted:reserves', credit: '1' },
                ],
            });
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_CRYPTO_WITHDRAWAL',
                reference: `withdrawal:crypto:${execution.id}`,
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

    // ── B. RESERVING recovery ───────────────────────────────────────────────

    describe('B — stale RESERVING recovery', () => {
        it('a stale unapproved withdrawal is failed with an exactly-once refund (no provider I/O can have happened)', async () => {
            const user = await seedUser(499); // debit already taken in the reservation seeding
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });

            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results).toHaveLength(1);
            expect(results[0].action).toBe('FAILED_REFUNDED');

            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect(after.errorClass).toBe(ERROR_CLASSES.PROVIDER_REJECTED);

            // Money convergence: exactly one refund of the FULL debit.
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
            // Linked record converged to FAILED.
            expect((await prisma.transactionHistory.findUnique({ where: { id: after.refId } })).status).toBe('FAILED');
            // Obligation canceled, reservation reversed exactly once.
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } });
            expect(obligation.status).toBe('CANCELLED');
            const reversals = await prisma.ledgerTransaction.count({
                where: { idempotencyKey: `ledger:withdrawal:crypto:refund:${execution.id}` },
            });
            expect(reversals).toBe(1);
        });

        it('a repeat recovery pass can never double-refund (exactly-once)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });
            await recovery.recoverReservingExecutions(prisma);
            const afterFirst = await balanceOf(user.id);

            const second = await recovery.recoverReservingExecutions(prisma);
            expect(second).toHaveLength(0); // no longer RESERVING — not picked up
            expect((await balanceOf(user.id)).toString()).toBe(afterFirst.toString());
            const refunds = await prisma.ledgerTransaction.count({
                where: { idempotencyKey: `ledger:withdrawal:crypto:refund:${execution.id}` },
            });
            expect(refunds).toBe(1);
        });

        it('a stale APPROVED withdrawal RE-ENTERS the canonical submission boundary exactly once', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { approvalStatus: 'APPROVED' } });
            const provider = fakeProvider({ submitPendingId: 'tatum-pending-9' });
            custody.__setProviderForTests(provider);

            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('RESUBMITTED');
            expect(results[0].status).toBe(STATUSES.SIGNING);
            expect(provider.submitted).toHaveLength(1); // exactly one provider call
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.SIGNING);
            expect(after.tatumPendingId).toBe('tatum-pending-9');
            expect(after.idempotencyKey).toBe(execution.idempotencyKey); // SAME execution — no second one
            expect(await prisma.custodyExecution.count({ where: { refId: after.refId } })).toBe(1);
        });

        it('a FRESH RESERVING row (inside the staleness window) is never raced by recovery', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user }); // createdAt = now
            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results).toHaveLength(0);
            expect((await currentExec(execution.id)).status).toBe(STATUSES.RESERVING);
        });

        it('a stale DENIED withdrawal is failed and refunded (no submission is possible for a denied request)', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user, createdAt: HOUR_AGO });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { approvalStatus: 'DENIED' } });

            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('FAILED_REFUNDED');
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
            expect((await currentExec(execution.id)).status).toBe(STATUSES.FAILED);
        });

        it('a stale RESERVING deposit sweep is failed WITHOUT a customer refund and frees the address for re-claim', async () => {
            const user = await seedUser(500);
            const sweepAudit = await prisma.onchainSweep.create({
                data: { userId: user.id, fromAddress: CUST, toAddress: HOT, amountUsdc: '1', status: 'BROADCASTING', txHash: null },
            });
            const { execution } = await custody.claimSweepExecution(prisma, {
                walletAddressId: 'wa-r22-stale', userId: user.id, fromAddress: CUST, toAddress: HOT,
                amountBaseUnits: 1000000n, onchainSweepId: sweepAudit.id, metadata: { derivationIndex: 5 },
            });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { createdAt: HOUR_AGO } });
            const before = await balanceOf(user.id);

            const results = await recovery.recoverReservingExecutions(prisma);
            expect(results[0].action).toBe('FAILED_REFUNDED'); // sweep refunds nothing; FAILED convergence
            expect((await balanceOf(user.id)).toString()).toBe(before.toString()); // no customer money moved
            expect((await currentExec(execution.id)).status).toBe(STATUSES.FAILED);
            expect((await prisma.onchainSweep.findUnique({ where: { id: sweepAudit.id } })).status).toBe('FAILED');

            // The address is re-claimable: no in-flight sweep remains.
            const reclaim = await custody.claimSweepExecution(prisma, {
                walletAddressId: 'wa-r22-stale', userId: user.id, fromAddress: CUST, toAddress: HOT,
                amountBaseUnits: 1000000n, onchainSweepId: sweepAudit.id, metadata: { derivationIndex: 5 },
            });
            expect(reclaim.isNew).toBe(true);
        });
    });

    // ── C. SUBMITTED crash-window recovery ──────────────────────────────────

    describe('C — SUBMITTED crash-window recovery (provider pending evidence, never a retry)', () => {
        async function seedSubmittedWithdrawal({ user, pendingId = null, submittedAt = HOUR_AGO }) {
            const { txRecord, execution } = await seedReservedWithdrawal({ user });
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: {
                    kind: 'CUSTOMER_WITHDRAWAL', refId: String(txRecord.id), userId: user.id,
                    fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits,
                },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.SUBMITTED, submittedAt, tatumPendingId: pendingId },
            });
            return { txRecord, execution };
        }

        it('SUBMITTED + pendingId + signed tx → converges to BROADCAST (chain evidence continues)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user, pendingId: 'tatum-pending-9' });
            custody.__setProviderForTests(fakeProvider({
                kmsRequest: { id: 'tatum-pending-9', txHash: TX_HASH, status: 'SIGNED' },
            }));

            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('BOUND_BROADCAST');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.BROADCAST);
            expect(after.txHash).toBe(TX_HASH);
        });

        it('crash-after-CAS: exactly one provider pending matches → durable bind to SIGNING, NO second transfer', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            const provider = fakeProvider({
                pendings: [
                    makePending({ id: 'pend-match-1', hashes: [HOT_SIG], index: 0, to: DEST, amount: execution.amountBaseUnits }),
                    makePending({ id: 'pend-other', hashes: [HOT_SIG], index: 0, to: OTHER_DEST, amount: 500000n }),
                ],
            });
            custody.__setProviderForTests(provider);

            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('BOUND_SIGNING');
            expect(results[0].pendingId).toBe('pend-match-1');
            expect(provider.submitted).toHaveLength(0); // NEVER a second transfer

            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.SIGNING);
            expect(after.tatumPendingId).toBe('pend-match-1');
        });

        it('a matched pending that ALREADY carries a valid txId binds straight to BROADCAST', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-signed', txId: TX_HASH, to: DEST, amount: execution.amountBaseUnits })],
            }));
            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('BOUND_BROADCAST');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.BROADCAST);
            expect(after.txHash).toBe(TX_HASH);
        });

        it('a matched pending with a MALFORMED txId is quarantined — malformed evidence is never used', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-bad', txId: 'not-a-hash', to: DEST, amount: execution.amountBaseUnits })],
            }));
            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('QUARANTINED');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_MISMATCH);
        });

        it('MULTIPLE matching pendings → quarantine (no probabilistic binding)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({
                pendings: [
                    makePending({ id: 'pend-a', to: DEST, amount: execution.amountBaseUnits }),
                    makePending({ id: 'pend-b', to: DEST, amount: execution.amountBaseUnits }),
                ],
            }));
            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('QUARANTINED_AMBIGUOUS');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.tatumPendingId).toBeNull(); // nothing bound
        });

        it('NO matching pending → honest quarantine: no refund, no retry, evidence recorded (N: user still sees PENDING)', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { txRecord, execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-unrelated', to: OTHER_DEST, amount: 777777n })],
            }));

            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('QUARANTINED_NO_MATCH');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect(after.errorClass).toBe(ERROR_CLASSES.UNKNOWN_OUTCOME);
            // Money untouched; customer record honestly still PENDING.
            expect((await balanceOf(user.id)).toString()).toBe(before.toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: txRecord.id } })).status).toBe('PENDING');
            // The four-eye validator refuses quarantined executions.
            const verdict = await custody.validateKmsPendingRequest(prisma, { pendingId: 'anything' });
            expect(verdict.approved).toBe(false);
        });

        it('a pending already bound to ANOTHER execution is never stolen', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            const other = await seedSubmittedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: other.execution.id },
                data: { tatumPendingId: 'pend-owned', status: STATUSES.SIGNING },
            });
            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-owned', to: DEST, amount: execution.amountBaseUnits })],
            }));
            const results = await recovery.recoverSubmittedExecutions(prisma);
            // 'pend-owned' is excluded from binding → no match → quarantine.
            expect(results[0].action).toBe('QUARANTINED_NO_MATCH');
            expect((await currentExec(execution.id)).tatumPendingId).toBeNull();
        });

        it('provider unavailable during the scan → row left untouched for the next pass', async () => {
            const user = await seedUser(500);
            const { execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({ listError: new Error('tatum 503') }));
            const results = await recovery.recoverSubmittedExecutions(prisma);
            expect(results[0].action).toBe('PROVIDER_UNAVAILABLE');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.SUBMITTED); // untouched
        });

        it('a bound crash-window execution then settles END-TO-END on verified chain evidence', async () => {
            const user = await seedUser(500);
            const { txRecord, execution } = await seedSubmittedWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-e2e', to: DEST, amount: execution.amountBaseUnits })],
            }));
            await recovery.recoverSubmittedExecutions(prisma); // bind → SIGNING

            // KMS signed → tx hash observed.
            custody.__setProviderForTests(fakeProvider({
                kmsRequest: { id: 'pend-e2e', txHash: TX_HASH, status: 'SIGNED' },
                transaction: {
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
                },
            }));
            await custody.reconcilePendingExecutions(prisma); // SIGNING → BROADCAST
            await custody.reconcilePendingExecutions(prisma); // BROADCAST → verify → settle

            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.COMPLETED);
            // F/G: the customer-facing record completed WITH the real hash.
            const hist = await prisma.transactionHistory.findUnique({ where: { id: txRecord.id } });
            expect(hist.status).toBe('COMPLETED');
            expect(hist.txHash).toBe(TX_HASH);
            // The obligation released on settlement.
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } });
            expect(obligation.status).toBe('RELEASED');
        });
    });

    // ── D/E. RECONCILIATION_REQUIRED convergence ────────────────────────────

    describe('D/E — quarantined outcome convergence', () => {
        async function seedQuarantined({ user, errorClass, pendingId = null }) {
            const { txRecord, execution } = await seedReservedWithdrawal({ user });
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: {
                    kind: 'CUSTOMER_WITHDRAWAL', refId: String(txRecord.id), userId: user.id,
                    fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits,
                },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: {
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass,
                    errorMessage: 'simulated quarantine',
                    tatumPendingId: pendingId,
                },
            });
            return { txRecord, execution };
        }

        it('a quarantined UNKNOWN_OUTCOME binds when the pending appears on a LATER pass (recurring convergence)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedQuarantined({ user, errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME });

            custody.__setProviderForTests(fakeProvider({ pendings: [] }));
            let results = await recovery.convergeReconciliationRequired(prisma);
            expect(results[0].action).toBe('STILL_QUARANTINED_NO_MATCH');

            custody.__setProviderForTests(fakeProvider({
                pendings: [makePending({ id: 'pend-late', to: DEST, amount: execution.amountBaseUnits })],
            }));
            // r23 D5: the first pass rescheduled the row into a 60s backoff
            // window — advance the pass clock past it (a real worker's next
            // 60s tick does this naturally).
            results = await recovery.convergeReconciliationRequired(prisma, { now: Date.now() + 61 * 1000 });
            expect(results[0].action).toBe('BOUND_SIGNING');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.SIGNING);
            expect(after.tatumPendingId).toBe('pend-late');
        });

        it('CHAIN_REVERTED converges to FAILED + exactly-once refund, preserving the revert evidence (txHash)', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { txRecord, execution } = await seedQuarantined({ user, errorClass: ERROR_CLASSES.CHAIN_REVERTED });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { txHash: TX_HASH, broadcastAt: new Date() },
            });

            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results[0].action).toBe('REVERT_REFUNDED');

            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.FAILED);
            expect(after.txHash).toBe(TX_HASH); // revert evidence preserved
            expect(after.errorMessage).toContain('verified chain revert');
            // Realized network cost is NEVER fabricated from the estimate (r22-Q).
            expect(after.realizedNetworkCostBaseUnits).toBeNull();
            // Full customer debit returned exactly once.
            expect((await balanceOf(user.id)).toString()).toBe(before.plus('1').toString());
            expect((await prisma.transactionHistory.findUnique({ where: { id: txRecord.id } })).status).toBe('FAILED');
            const obligation = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:crypto:${execution.id}` } });
            expect(obligation.status).toBe('CANCELLED');
        });

        it('a repeated pass over a converged revert can never double-refund', async () => {
            const user = await seedUser(500);
            const { execution } = await seedQuarantined({ user, errorClass: ERROR_CLASSES.CHAIN_REVERTED });
            await recovery.convergeReconciliationRequired(prisma);
            const afterFirst = await balanceOf(user.id);
            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results).toHaveLength(0); // FAILED is terminal — no longer quarantined
            expect((await balanceOf(user.id)).toString()).toBe(afterFirst.toString());
        });

        it('CHAIN_MISMATCH stays quarantined for HUMAN reconciliation — no refund, no retry, validator refuses', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedQuarantined({ user, errorClass: ERROR_CLASSES.CHAIN_MISMATCH, pendingId: 'pend-mm' });

            // r23 D5: CHAIN_MISMATCH is a HUMAN-OWNED class — excluded from
            // the bounded automatic scan entirely (it used to be returned as
            // a HUMAN_RECONCILIATION action each pass).
            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results).toHaveLength(0);

            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect((await balanceOf(user.id)).toString()).toBe(before.toString());
            const verdict = await custody.validateKmsPendingRequest(prisma, { pendingId: 'pend-mm' });
            expect(verdict.approved).toBe(false);
            expect(verdict.httpStatus).toBe(409); // terminal — KMS must not sign
        });

        it('a quarantined DEPOSIT_SWEEP with CHAIN_REVERTED converges to FAILED and frees the address', async () => {
            const user = await seedUser(500);
            const sweepAudit = await prisma.onchainSweep.create({
                data: { userId: user.id, fromAddress: CUST, toAddress: HOT, amountUsdc: '1', status: 'BROADCASTING', txHash: TX_HASH },
            });
            const { execution } = await custody.claimSweepExecution(prisma, {
                walletAddressId: 'wa-r22-revert', userId: user.id, fromAddress: CUST, toAddress: HOT,
                amountBaseUnits: 1000000n, onchainSweepId: sweepAudit.id, metadata: { derivationIndex: 5 },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.RECONCILIATION_REQUIRED, errorClass: ERROR_CLASSES.CHAIN_REVERTED, txHash: TX_HASH },
            });
            const results = await recovery.convergeReconciliationRequired(prisma);
            expect(results[0].action).toBe('REVERT_REFUNDED');
            expect((await currentExec(execution.id)).status).toBe(STATUSES.FAILED);
            expect((await prisma.onchainSweep.findUnique({ where: { id: sweepAudit.id } })).status).toBe('FAILED');
            const reclaim = await custody.claimSweepExecution(prisma, {
                walletAddressId: 'wa-r22-revert', userId: user.id, fromAddress: CUST, toAddress: HOT,
                amountBaseUnits: 1000000n, metadata: { derivationIndex: 5 },
            });
            expect(reclaim.isNew).toBe(true);
        });
    });

    // ── F/G. settle-time terminal convergence ───────────────────────────────

    describe('F/G — settlement convergence guards', () => {
        function verifiedReceipt(amountBaseUnits) {
            return {
                status: '0x1',
                logs: [{
                    address: NATIVE,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x' + HOT.slice(2).padStart(64, '0'),
                        '0x' + DEST.slice(2).padStart(64, '0'),
                    ],
                    data: '0x' + BigInt(amountBaseUnits).toString(16).padStart(64, '0'),
                }],
            };
        }

        async function seedBroadcastWithdrawal({ user, txRecordOverride = null }) {
            const { txRecord, execution } = await seedReservedWithdrawal({ user });
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: {
                    kind: 'CUSTOMER_WITHDRAWAL', refId: String(txRecord.id), userId: user.id,
                    fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits,
                },
            });
            if (txRecordOverride) await txRecordOverride(txRecord);
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.BROADCAST, txHash: TX_HASH, broadcastAt: new Date() },
            });
            return { txRecord, execution };
        }

        it('settlement REFUSES an execution whose linked history record is missing (no COMPLETED-without-record divergence)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedBroadcastWithdrawal({
                user,
                txRecordOverride: async (txRecord) => { await prisma.transactionHistory.delete({ where: { id: txRecord.id } }); },
            });
            custody.__setProviderForTests(fakeProvider({ transaction: verifiedReceipt(execution.amountBaseUnits) }));

            const outcome = await custody.advanceExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(false);
            expect(outcome.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED); // quarantined, NOT completed
        });

        it('settlement REFUSES a linked history record already FAILED while chain evidence proves success (contradiction → human)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedBroadcastWithdrawal({
                user,
                txRecordOverride: async (txRecord) => {
                    await prisma.transactionHistory.update({ where: { id: txRecord.id }, data: { status: 'FAILED' } });
                },
            });
            custody.__setProviderForTests(fakeProvider({ transaction: verifiedReceipt(execution.amountBaseUnits) }));

            const outcome = await custody.advanceExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(false);
            expect(outcome.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        });

        it('normal settlement converges the REAL txHash into the customer record atomically, and re-settle is idempotent', async () => {
            const user = await seedUser(500);
            const { txRecord, execution } = await seedBroadcastWithdrawal({ user });
            custody.__setProviderForTests(fakeProvider({ transaction: verifiedReceipt(execution.amountBaseUnits) }));

            const first = await custody.advanceExecution(prisma, { executionId: execution.id });
            expect(first.settled).toBe(true);
            const hist = await prisma.transactionHistory.findUnique({ where: { id: txRecord.id } });
            expect(hist.status).toBe('COMPLETED');
            expect(hist.txHash).toBe(TX_HASH); // the real chain hash — converged atomically

            // Idempotent re-settle: no error, no divergence, hash already there.
            const again = await custody.settleExecution(prisma, { executionId: execution.id, evidence: { verified: true, detail: 'test', [Symbol.for('x')]: false } });
            expect(again.settled).toBe(false);
            expect(again.alreadySettled).toBe(true);
        });

        it('a DEPOSIT_SWEEP settles even when its audit row is missing (audit-only; money path never blocked)', async () => {
            const user = await seedUser(500);
            const walletAddress = await prisma.walletAddress.create({
                data: {
                    id: 'wa-r22-audit', userId: user.id, network: 'POLYGON', asset: 'USDC',
                    contractAddress: NATIVE, address: CUST, derivationIndex: 5, status: 'ACTIVE',
                },
            });
            const { execution } = await custody.claimSweepExecution(prisma, {
                walletAddressId: walletAddress.id, userId: user.id, fromAddress: CUST, toAddress: HOT,
                amountBaseUnits: 1000000n, onchainSweepId: null, metadata: { derivationIndex: 5 },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.BROADCAST, txHash: TX_HASH, broadcastAt: new Date() },
            });
            const sweepReceipt = {
                status: '0x1',
                logs: [{
                    address: NATIVE,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x' + CUST.slice(2).padStart(64, '0'),
                        '0x' + HOT.slice(2).padStart(64, '0'),
                    ],
                    data: '0x' + (1000000n).toString(16).padStart(64, '0'),
                }],
            };
            custody.__setProviderForTests(fakeProvider({ transaction: sweepReceipt }));
            const outcome = await custody.advanceExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(true);
            expect((await currentExec(execution.id)).status).toBe(STATUSES.COMPLETED);
        });
    });

    // ── H. approval / denial races ───────────────────────────────────────────

    describe('H — approval/denial race hardening', () => {
        it('r23 D1: DENY from SIGNING with a successful provider cancel → QUARANTINED (cancel is NOT broadcast proof)', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            await custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: execution.refId, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits },
            });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.SIGNING, tatumPendingId: 'pend-deny-1' },
            });
            const provider = fakeProvider({});
            custody.__setProviderForTests(provider);

            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied', provider);
            expect(denied.approvalStatus).toBe('DENIED');
            expect(provider.deletes).toContain('pend-deny-1'); // best-effort cancel still happens
            expect(denied.denialLimitation).toBe('QUARANTINED_POST_SUBMISSION_PENDING_CANCELLED');
            const after = await currentExec(execution.id);
            // Past the submission CAS a cancel success is not broadcast proof
            // (a daemon fetch already in flight is an unavoidable external
            // race): fail closed — quarantine, NEVER refund on denial.
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
            expect((await balanceOf(user.id)).toString()).toBe(before.toString());
        });

        it('DENY whose provider cancel FAILS → quarantined (an in-flight KMS fetch is an unavoidable external race)', async () => {
            const user = await seedUser(500);
            const before = await balanceOf(user.id);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.SIGNING, tatumPendingId: 'pend-deny-2', approvalStatus: 'APPROVED' },
            });
            const provider = fakeProvider({ deleteError: new Error('tatum 503') });
            custody.__setProviderForTests(provider);

            const denied = await custody.denyKmsRequest(prisma, execution.id, 'operator denied', provider);
            expect(denied.approvalStatus).toBe('DENIED');
            expect(denied.denialLimitation).toBe('PENDING_CANCEL_FAILED_QUARANTINED');
            const after = await currentExec(execution.id);
            expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED); // never refunded
            expect((await balanceOf(user.id)).toString()).toBe(before.toString());
        });

        it('DENY after BROADCAST records the fact but cannot stop settlement on verified chain evidence', async () => {
            const user = await seedUser(500);
            const { txRecord, execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.BROADCAST, txHash: TX_HASH, broadcastAt: new Date(), approvalStatus: 'APPROVED' },
            });
            const denied = await custody.denyKmsRequest(prisma, execution.id, 'late denial', fakeProvider({}));
            expect(denied.denialLimitation).toBe('ALREADY_BROADCAST');

            const receipt = {
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
            custody.__setProviderForTests(fakeProvider({ transaction: receipt }));
            const outcome = await custody.advanceExecution(prisma, { executionId: execution.id });
            expect(outcome.settled).toBe(true); // chain evidence remains the authority
            expect((await prisma.transactionHistory.findUnique({ where: { id: txRecord.id } })).status).toBe('COMPLETED');
        });

        it('APPROVAL after broadcast evidence exists is refused (the outcome belongs to chain evidence)', async () => {
            const user = await seedUser(500);
            const { execution } = await seedReservedWithdrawal({ user });
            await prisma.custodyExecution.update({
                where: { id: execution.id },
                data: { status: STATUSES.BROADCAST, txHash: TX_HASH },
            });
            await expect(custody.approveKmsRequest(prisma, {
                executionId: execution.id,
                expected: { fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits },
            })).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            expect((await currentExec(execution.id)).approvalStatus).toBe('PENDING'); // unchanged
        });
    });

    // ── I. the dedicated recovery cadence ───────────────────────────────────

    describe('I — dedicated recovery worker + cadence', () => {
        it('CustodyRecoveryWorker runs a bounded pass and is safe to re-enter', async () => {
            const CustodyRecoveryWorker = require('../workers/custodyRecoveryWorker');
            const worker = new CustodyRecoveryWorker(prisma, null);
            const r1 = await worker._tick();
            expect(r1).toBeDefined();
            expect(Array.isArray(r1.reserving)).toBe(true);

            // While a pass is in flight, a second tick is a no-op (bounded).
            const first = worker._tick();
            const second = await worker._tick();
            expect(second).toBe(null); // guarded by the in-flight flag
            await first;
        });

        it('the 60s custody-recovery cadence is registered through the existing BullMQ scheduler abstraction', () => {
            const workersIndex = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'index.js'), 'utf8');
            expect(workersIndex).toMatch(/register\('custody-recovery',\s*String\(60 \* 1000\)/);
            expect(workersIndex).toMatch(/CustodyRecoveryWorker/);
        });

        it('the recovery pass is idempotent and concurrency-safe: duplicate passes converge (run twice back-to-back)', async () => {
            const results1 = await recovery.runRecoveryPass(prisma);
            const results2 = await recovery.runRecoveryPass(prisma);
            expect(results1).toBeDefined();
            expect(results2).toBeDefined();
            // No exceptions, no divergent state; an empty DB yields empty buckets.
            expect(results1.reserving).toHaveLength(0);
            expect(results1.submitted).toHaveLength(0);
        });
    });

    // ── Gates-off safety ────────────────────────────────────────────────────

    describe('execution gates off → recovery fails closed (P1 static integrity)', () => {
        it('recovery refuses to run when the LIVE+KMS+execution gate is off', async () => {
            disableGates();
            await expect(recovery.recoverReservingExecutions(prisma)).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            await expect(recovery.recoverSubmittedExecutions(prisma)).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
            await expect(recovery.convergeReconciliationRequired(prisma)).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
        });
    });
});
