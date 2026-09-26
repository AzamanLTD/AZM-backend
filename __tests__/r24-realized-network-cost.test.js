// __tests__/r24-realized-network-cost.test.js
// =============================================================================
// r24 — REALIZED NETWORK COST FROM RECEIPT EVIDENCE (P1) — proofs.
//
// The ONLY authority for the realized network cost of a reverted execution is
// the chain receipt itself: gasUsed × gasPrice (POL/MATIC wei, paid by the
// hot-wallet operator). r22-Q made the field exist and ruled it is NEVER
// fabricated from the estimate; r24 populates it from receipt evidence,
// recorded ATOMICALLY with the quarantine (RECONCILIATION_REQUIRED) transition
// on every verification-driven revert site.
//
// Three layers:
//  UNIT (no DB): receipt gas parsing — exact BigInt math, decimal/hex forms,
//    honest absence (null) for missing/unparseable/zero evidence, and the
//    deliberate refusal to fabricate from an EIP-1559 maxFeePerGas cap.
//  VERIFICATION: verifyChainTransfer returns the realized cost with the revert
//    evidence when the receipt proves it, and honestly omits it when not.
//  REAL POSTGRESQL: the cost rides the SAME atomic CAS that quarantines the
//    row (advanceExecution + settleExecution sites), exactly-once under a
//    concurrent advance race, absent when the receipt carries no evidence,
//    and PRESERVED through the recovery convergence to FAILED.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r24-network-cost] TEST_DATABASE_URL not set — skipping DB proofs.');

const custody = require('../services/tatumCustodyExecutionService');
const recovery = require('../services/custodyRecoveryService');
const { ERROR_CLASSES } = require('../services/custodyExecutionErrors');

const { STATUSES, parseRealizedNetworkCostWei, verifyChainTransfer } = custody;

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const DEST = '0x' + '33'.repeat(20);
const TX_HASH = '0x' + 'ab'.repeat(32);
const NATIVE = custody.CANONICAL.contractAddress;

const HOT_SIG = 'test-hot-signature-id';
const CUST_SIG = 'test-kms-signature-id';

// Saved env so each test can toggle the gate flags safely.
const SAVED_ENV = {};
const ENV_KEYS = ['TATUM_PROVIDER', 'TATUM_API_KEY', 'TATUM_KMS_ENABLED', 'TATUM_CRYPTO_EXECUTION_ENABLED',
    'TATUM_KMS_SIGNATURE_ID', 'TATUM_KMS_CHAIN', 'TATUM_KMS_ENVIRONMENT', 'TATUM_KMS_FOUR_EYE_REQUIRED',
    'TATUM_HOT_WALLET_SIGNATURE_ID', 'TATUM_HOT_WALLET_INDEX', 'TATUM_HOT_WALLET_ADDRESS',
    'TATUM_TREASURY_ADDRESS', 'TATUM_KMS_SIGNER_REGISTRY', 'TATUM_KMS_VALIDATOR_ALLOWED_IPS', 'TATUM_BASE_URL'];
beforeAll(() => { for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k]; });
afterAll(() => {
    for (const k of ENV_KEYS) {
        if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
    }
    custody.__setProviderForTests(null);
});

function enableGates() {
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
}

function fakeProvider(behavior = {}) {
    return {
        name: 'FAKE',
        async getTransaction() {
            if (behavior.transaction === null) return null;
            return behavior.transaction ? { ...behavior.transaction } : null;
        },
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIT — receipt gas parsing (no DB)
// ═════════════════════════════════════════════════════════════════════════════

describe('r24 P1 unit — parseRealizedNetworkCostWei (receipt evidence only)', () => {
    it('hex receipt: exact gasUsed × gasPrice in wei (BigInt math, no float)', () => {
        // 21000 gas × 1 gwei = 21,000,000,000,000 wei
        const wei = parseRealizedNetworkCostWei({ status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00' });
        expect(wei).toBe(21000n * 1000000000n);
        expect(typeof wei).toBe('bigint');
    });

    it('decimal-string receipt: same exact product as hex form', () => {
        const hex = parseRealizedNetworkCostWei({ gasUsed: '0x5208', gasPrice: '0x3b9aca00' });
        const dec = parseRealizedNetworkCostWei({ gasUsed: '21000', gasPrice: '1000000000' });
        expect(dec).toBe(hex);
    });

    it('exactness at magnitudes where Number precision would corrupt the evidence', () => {
        // 30M gas × 100 gwei = 3e18 wei — far beyond 2^53 (Number-precise),
        // inside the durable BIGINT range. Float math would lose digits.
        const gasUsed = 30000000n;
        const gasPrice = 100000000000n;
        const expected = gasUsed * gasPrice; // 3000000000000000000n
        expect(parseRealizedNetworkCostWei({
            gasUsed: '0x' + gasUsed.toString(16), gasPrice: '0x' + gasPrice.toString(16),
        })).toBe(expected);
    });

    it('missing evidence records NOTHING — null, never a fabricated zero', () => {
        expect(parseRealizedNetworkCostWei({ gasUsed: '0x5208' })).toBeNull();            // no gasPrice
        expect(parseRealizedNetworkCostWei({ gasPrice: '0x3b9aca00' })).toBeNull();       // no gasUsed
        expect(parseRealizedNetworkCostWei({ gasUsed: '', gasPrice: '' })).toBeNull();    // empty strings
        expect(parseRealizedNetworkCostWei({ gasUsed: null, gasPrice: null })).toBeNull();
        expect(parseRealizedNetworkCostWei(null)).toBeNull();                             // no receipt at all
        expect(parseRealizedNetworkCostWei('not-a-receipt')).toBeNull();
    });

    it('unparseable evidence records NOTHING', () => {
        expect(parseRealizedNetworkCostWei({ gasUsed: 'abc', gasPrice: '0x3b9aca00' })).toBeNull();
        expect(parseRealizedNetworkCostWei({ gasUsed: '0xZZ12', gasPrice: '0x3b9aca00' })).toBeNull();
        expect(parseRealizedNetworkCostWei({ gasUsed: '21,000', gasPrice: '1000000000' })).toBeNull();
        expect(parseRealizedNetworkCostWei({ gasUsed: '1.5e4', gasPrice: '1000000000' })).toBeNull();
    });

    it('zero-valued evidence records NOTHING (deliberate: absence, not a free ride)', () => {
        expect(parseRealizedNetworkCostWei({ gasUsed: '0x0', gasPrice: '0x3b9aca00' })).toBeNull();
        expect(parseRealizedNetworkCostWei({ gasUsed: '0x5208', gasPrice: '0x0' })).toBeNull();
        expect(parseRealizedNetworkCostWei({ gasUsed: '0', gasPrice: '0' })).toBeNull();
    });

    it('EIP-1559 receipt: maxFeePerGas is NEVER used as the price paid', () => {
        // A cap is not a price. Absent an explicit gasPrice the cost is
        // honestly absent — using the cap would be a fabrication (r24 P1).
        const wei = parseRealizedNetworkCostWei({
            gasUsed: '0x5208',
            maxFeePerGas: '0x5f5e100', // 100 gwei cap
            // gasPrice deliberately absent — r24 refuses the cap
        });
        expect(wei).toBeNull();
    });

    it('an explicit gasPrice alongside 1559 caps IS the evidence (receipt says what was paid)', () => {
        const wei = parseRealizedNetworkCostWei({
            gasUsed: '0x5208',
            maxFeePerGas: '0x5f5e100',
            gasPrice: '0x3b9aca00', // the receipt names the actual price
        });
        expect(wei).toBe(21000n * 1000000000n);
    });

    it('a cost exceeding the durable BIGINT range records NOTHING (never clamped, never a write-time crash)', () => {
        // The column is signed 64-bit. The exact product here is ~3.4e38 —
        // unrepresentable. Honest absence (null) keeps the quarantine itself
        // writable; the operator computes the exact cost from the receipt.
        const gasUsed = 0xffffffffffffffffn;
        const gasPrice = 0xffffffffffffffffn;
        expect(parseRealizedNetworkCostWei({
            gasUsed: '0x' + gasUsed.toString(16), gasPrice: '0x' + gasPrice.toString(16),
        })).toBeNull();
        // Just inside the range still records exactly.
        const max64 = (2n ** 63n - 1n);
        expect(parseRealizedNetworkCostWei({ gasUsed: '1', gasPrice: max64.toString() })).toBe(max64);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// VERIFICATION — verifyChainTransfer carries the cost with the revert evidence
// ═════════════════════════════════════════════════════════════════════════════

describe('r24 P1 unit — verifyChainTransfer revert evidence', () => {
    const verifyArgs = { txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n };

    it('a reverted receipt WITH gas evidence returns the exact realized cost', async () => {
        const verdict = await verifyChainTransfer(fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00', logs: [] },
        }), verifyArgs);
        expect(verdict.verified).toBe(false);
        expect(verdict.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);
        expect(verdict.realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n);
    });

    it('a reverted receipt WITHOUT gas evidence is still CHAIN_REVERTED — cost honestly absent', async () => {
        const verdict = await verifyChainTransfer(fakeProvider({
            transaction: { status: 'reverted', logs: [] },
        }), verifyArgs);
        expect(verdict.verified).toBe(false);
        expect(verdict.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);
        expect(verdict.realizedNetworkCostBaseUnits).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// REAL POSTGRESQL — atomic recording at the quarantine sites
// ═════════════════════════════════════════════════════════════════════════════

describeOrSkip('r24 (real PostgreSQL)', () => {
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
        const id = `r24-${Date.now()}-${++userSeq}-${Math.random().toString(36).slice(2, 8)}`;
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

    // The full §P.4 reservation stack (history + execution), approved and
    // driven to BROADCAST with a chain tx hash — the state from which
    // advanceExecution/settleExecution consult the chain receipt.
    async function seedBroadcastWithdrawal({ user }) {
        const txRecord = await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'WITHDRAWAL_CRYPTO',
                amountUsdc: 0.9725, feeUsdc: 0.0275,
                txHash: null, status: 'PENDING',
            },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${txRecord.id}`,
            transactionHistoryId: txRecord.id,
            userId: user.id,
            fromAddress: HOT,
            toAddress: DEST,
            amountBaseUnits: 972500n,
            feeChargeBaseUnits: 27500n,
            metadata: { customerDebitBaseUnits: '1000000', netPayoutBaseUnits: '972500' },
        });
        await custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: {
                kind: 'CUSTOMER_WITHDRAWAL', refId: String(txRecord.id), userId: user.id,
                fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: execution.amountBaseUnits,
            },
        });
        await prisma.custodyExecution.update({
            where: { id: execution.id },
            data: { status: STATUSES.BROADCAST, txHash: TX_HASH, broadcastAt: new Date(), tatumPendingId: 'pend-r24' },
        });
        return { txRecord, execution };
    }

    async function currentExec(id) {
        return prisma.custodyExecution.findUnique({ where: { id } });
    }

    // ── advanceExecution: the advance authority's quarantine site ───────────

    it('advanceExecution records the realized cost ATOMICALLY with the revert quarantine', async () => {
        const user = await seedUser(500);
        const { execution } = await seedBroadcastWithdrawal({ user });

        const provider = fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00', logs: [] },
        });
        const result = await custody.advanceExecution(prisma, { executionId: execution.id }, { provider });

        expect(result.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(result.changed).toBe(true);
        expect(result.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);

        // The cost and the quarantine are ONE write: the row shows BOTH,
        // immediately, with the revert evidence classified.
        const after = await currentExec(execution.id);
        expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_REVERTED);
        expect(after.realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n);
        expect(after.txHash).toBe(TX_HASH); // revert evidence preserved
    });

    it('advanceExecution on a receipt WITHOUT gas evidence quarantines with the cost honestly ABSENT', async () => {
        const user = await seedUser(500);
        const { execution } = await seedBroadcastWithdrawal({ user });

        const provider = fakeProvider({ transaction: { status: 'failed', logs: [] } });
        const result = await custody.advanceExecution(prisma, { executionId: execution.id }, { provider });

        expect(result.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        const after = await currentExec(execution.id);
        expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(after.realizedNetworkCostBaseUnits).toBeNull(); // honest absence — never the estimate
    });

    it('the quarantine-with-cost write is EXACTLY-ONCE under a concurrent advance race', async () => {
        const user = await seedUser(500);
        const { execution } = await seedBroadcastWithdrawal({ user });

        const provider = fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00', logs: [] },
        });
        // Two concurrent advances on the same BROADCAST row: both verify the
        // same receipt, but only ONE can win the transitionExecution CAS from
        // BROADCAST — the cost write rides that single atomic CAS.
        const results = await Promise.all([
            custody.advanceExecution(prisma, { executionId: execution.id }, { provider }),
            custody.advanceExecution(prisma, { executionId: execution.id }, { provider }),
        ]);

        const changed = results.filter((r) => r.changed);
        expect(changed).toHaveLength(1); // exactly one quarantine transition
        // The CAS loser converges on the winner's state — it NEVER reports
        // a phantom second transition.
        const converged = results.filter((r) => r.changed === false && r.converged === true);
        expect(converged).toHaveLength(1);
        expect(results.filter((r) => r.status === STATUSES.RECONCILIATION_REQUIRED)).toHaveLength(2); // both report the converged state

        const after = await currentExec(execution.id);
        expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(after.realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n); // recorded by the single CAS winner
    });

    it('a repeat advance after quarantine NEVER re-writes (terminal quarantine)', async () => {
        const user = await seedUser(500);
        const { execution } = await seedBroadcastWithdrawal({ user });

        const provider = fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00', logs: [] },
        });
        await custody.advanceExecution(prisma, { executionId: execution.id }, { provider });
        const recorded = await currentExec(execution.id);

        // Second advance on the quarantined row: terminal — no re-transition.
        const again = await custody.advanceExecution(prisma, { executionId: execution.id }, { provider });
        expect(again.changed).toBe(false);
        const after = await currentExec(execution.id);
        expect(after.realizedNetworkCostBaseUnits).toBe(recorded.realizedNetworkCostBaseUnits);
    });

    // ── settleExecution: the settlement authority's own quarantine site ────

    it('settleExecution records the realized cost on its own revert verification path', async () => {
        const user = await seedUser(500);
        const { execution } = await seedBroadcastWithdrawal({ user });
        await prisma.custodyExecution.update({
            where: { id: execution.id },
            data: { status: STATUSES.CONFIRMING },
        });

        // settleExecution with no supplied evidence verifies via getProvider().
        custody.__setProviderForTests(fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x30d40', gasPrice: '0x174876e800', logs: [] },
        }));
        const result = await custody.settleExecution(prisma, { executionId: execution.id });

        expect(result.settled).toBe(false);
        expect(result.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(result.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);

        const after = await currentExec(execution.id);
        expect(after.status).toBe(STATUSES.RECONCILIATION_REQUIRED);
        expect(after.errorClass).toBe(ERROR_CLASSES.CHAIN_REVERTED);
        // 200000 gas × 100 gwei = 20,000,000,000,000,000 wei — from the receipt only.
        expect(after.realizedNetworkCostBaseUnits).toBe(200000n * 100000000000n);
    });

    // ── recovery convergence: the recorded cost SURVIVES into the terminal state ──

    it('recovery convergence to FAILED PRESERVES the recorded cost (and refunds exactly once)', async () => {
        const user = await seedUser(500);
        const before = (await prisma.user.findUnique({ where: { id: user.id } })).availableBalance;
        const { execution } = await seedBroadcastWithdrawal({ user });

        // The r24 recording site: quarantine WITH the receipt-proven cost.
        const provider = fakeProvider({
            transaction: { status: '0x0', gasUsed: '0x5208', gasPrice: '0x3b9aca00', logs: [] },
        });
        await custody.advanceExecution(prisma, { executionId: execution.id }, { provider });
        const quarantined = await currentExec(execution.id);
        expect(quarantined.realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n);

        // The automatic recovery pass converges the revert quarantine.
        const results = await recovery.convergeReconciliationRequired(prisma);
        expect(results[0].action).toBe('REVERT_REFUNDED');

        const after = await currentExec(execution.id);
        expect(after.status).toBe(STATUSES.FAILED);
        expect(after.txHash).toBe(TX_HASH);                       // revert evidence preserved
        expect(after.realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n); // cost evidence preserved through convergence
        expect((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance.toString())
            .toBe(before.plus('1').toString());                    // exactly-once refund

        // Exactly-once: a second pass never double-refunds and never re-writes.
        const second = await recovery.convergeReconciliationRequired(prisma);
        expect(second).toHaveLength(0);
        expect((await currentExec(execution.id)).realizedNetworkCostBaseUnits).toBe(21000n * 1000000000n);
    });
});
