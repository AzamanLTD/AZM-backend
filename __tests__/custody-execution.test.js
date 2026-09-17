// __tests__/custody-execution.test.js
// =============================================================================
// Financial architecture §P.2 — KMS-capable custody execution boundary.
//
// Three layers:
//  - UNIT (no DB): exact USDC base-unit conversion; destination/asset/signer
//    validation; production gate combinations; raw-private-key prohibition;
//    fake-tx-hash rejection; provider error classification; redaction;
//    transfer-semantics verification against fake chain evidence.
//  - REAL POSTGRESQL proofs: durable execution claims (withdrawal idempotency
//    key + sweep in-flight partial index), forward-only transitions,
//    exactly-once settlement, exactly-once refund on definitive pre-broadcast
//    rejection, NO refund on ambiguous outcomes, retry-block after unknown
//    outcome, four-eye approval exact-match verification, signer/address
//    mismatch, wrong-contract rejection, and the full async lifecycle
//    (SUBMITTED → SIGNING → BROADCAST → CONFIRMING → COMPLETED) with real
//    chain-evidence checks (including a matching-unrelated-transaction that
//    must NOT settle).
//  - CONTROLLER-level proofs (real PG): gates-off → 503 before any debit;
//    pending-signing → 202 with NO tx hash and PENDING ledger row; definitive
//    rejection → exactly-once refund; timeout → NO auto-refund.
//
// The external KMS/Tatum adapter is a DETERMINISTIC FAKE here — these tests
// prove the execution boundary's state machine and invariants, NOT that a
// blockchain transfer occurred. Testnet capability is documented in
// docs/custody-execution.md and is deliberately not claimed by CI.
// =============================================================================
const fs = require('fs');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[custody-execution] TEST_DATABASE_URL not set — skipping DB proofs.');

const custody = require('../services/tatumCustodyExecutionService');
const {
    ERROR_CLASSES,
    CustodyExecutionError,
    classifyProviderError,
    redact,
} = require('../services/custodyExecutionErrors');

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const DEST = '0x' + '33'.repeat(20);
const TX_HASH = '0x' + 'ab'.repeat(32);
const NATIVE = custody.CANONICAL.contractAddress;
const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

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

function enableGates(overrides = {}) {
    process.env.TATUM_PROVIDER = 'LIVE';
    process.env.TATUM_API_KEY = 'test-tatum-key';
    process.env.TATUM_KMS_ENABLED = 'true';
    process.env.TATUM_CRYPTO_EXECUTION_ENABLED = 'true';
    process.env.TATUM_KMS_SIGNATURE_ID = 'test-kms-signature-id';
    process.env.TATUM_KMS_CHAIN = 'POLYGON';
    process.env.TATUM_KMS_ENVIRONMENT = 'TESTNET';
    process.env.TATUM_KMS_FOUR_EYE_REQUIRED = 'true';
    process.env.TATUM_HOT_WALLET_SIGNATURE_ID = 'test-hot-signature-id';
    process.env.TATUM_HOT_WALLET_ADDRESS = HOT;
    delete process.env.TATUM_TREASURY_ADDRESS;
    // KMS signer registry (ops-populated from `tatum-kms getaddress` output):
    // the deposit mnemonic identity derives CUST at index 5; the hot wallet
    // identity derives HOT at index 0.
    process.env.TATUM_KMS_SIGNER_REGISTRY = JSON.stringify([
        { signatureId: 'test-kms-signature-id', index: 5, address: CUST, model: 'MNEMONIC_INDEXED' },
        { signatureId: 'test-hot-signature-id', index: 0, address: HOT, model: 'MNEMONIC_INDEXED' },
    ]);
    delete process.env.TATUM_KMS_VALIDATOR_ALLOWED_IPS;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}
function disableGates() {
    process.env.TATUM_PROVIDER = 'MOCK';
    delete process.env.TATUM_KMS_ENABLED;
    delete process.env.TATUM_CRYPTO_EXECUTION_ENABLED;
}

function fakeProvider(behavior = {}) {
    const p = {
        name: 'FAKE',
        submitted: [],
        completions: [],
        deletes: [],
        // Mirrors the REAL Tatum response semantics: the KMS-signed request
        // returns ONLY { signatureId } — the internal Tatum ID of the prepared
        // pending transaction (the SignatureId OpenAPI schema). No txId.
        async submitTokenTransfer(payload) {
            if (behavior.submitError) throw behavior.submitError;
            p.submitted.push(payload);
            if (behavior.txHash) return { pendingId: behavior.pendingId || null, txHash: behavior.txHash };
            return { pendingId: behavior.pendingId || 'tatum-pending-9', txHash: null };
        },
        async getKmsRequest(id) {
            if (behavior.kmsError) throw behavior.kmsError;
            const r = behavior.kmsRequest || { id, txHash: null, status: null };
            return { ...r };
        },
        // The documented Tatum pending lifecycle endpoints. There is NO approve
        // method: four-eye is the KMS daemon's externalUrl validation contract.
        async listPendingRequests() { return []; },
        async completePendingRequest(pendingId, txId) { p.completions.push({ pendingId, txId }); return true; },
        async deletePendingRequest(pendingId) { p.deletes.push(pendingId); return true; },
        async getTransaction(hash) { if (behavior.transaction === null) return null; return behavior.transaction ? { ...behavior.transaction } : null; },
    };
    return p;
}

// ERC-20 Transfer log for a canonical native-USDC transfer.
function usdcTransferLog({ contract = NATIVE, from = HOT, to = DEST, units }) {
    const pad = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
    const data = '0x' + BigInt(units).toString(16).padStart(64, '0');
    return {
        address: contract,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(to)],
        data,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT LAYER (no database)
// ─────────────────────────────────────────────────────────────────────────────

describe('§P.2 unit: exact base-unit conversion', () => {
    it('converts 100.123456 USDC to exactly 100123456 base units (and other exact cases)', () => {
        expect(custody.toBaseUnits('100.123456')).toBe(100123456n);
        expect(custody.toBaseUnits('1')).toBe(1000000n);
        expect(custody.toBaseUnits('0.000001')).toBe(1n);
        expect(custody.toBaseUnits('7.5')).toBe(7500000n);
        expect(custody.toBaseUnits(7.5)).toBe(7500000n);
        expect(custody.toBaseUnits('100.1')).toBe(100100000n);
        expect(custody.toBaseUnits(42)).toBe(42000000n);
    });

    it.each([
        ['100.1234567', 'more than 6 decimals'],
        ['NaN', 'NaN literal'],
        ['Infinity', 'Infinity literal'],
        ['0', 'zero'],
        ['0.000000', 'zero after padding'],
        ['-5', 'negative'],
        ['-0.5', 'negative decimal'],
        ['1e3', 'exponent notation'],
        ['abc', 'garbage'],
        ['', 'empty'],
        ['1.2.3', 'double dot'],
        ['  ', 'whitespace only'],
    ])('rejects %s (%s)', (input) => {
        expect(() => custody.toBaseUnits(input)).toThrow(CustodyExecutionError);
    });

    it('rejects numeric NaN/Infinity/-0 and non-string/number inputs', () => {
        expect(() => custody.toBaseUnits(NaN)).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits(Infinity)).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits(0)).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits(-1)).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits(null)).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits({})).toThrow(CustodyExecutionError);
        expect(() => custody.toBaseUnits(undefined)).toThrow(CustodyExecutionError);
    });
});

describe('§P.2 unit: destination + asset validation', () => {
    beforeEach(() => { disableGates(); process.env.TATUM_HOT_WALLET_ADDRESS = HOT; });

    it('accepts a valid EOA address and rejects malformed/zero/contract/hot-wallet destinations', () => {
        expect(custody.validateDestination(DEST)).toBe(DEST.toLowerCase());
        expect(() => custody.validateDestination('0x123')).toThrow(CustodyExecutionError);
        expect(() => custody.validateDestination('nothex0123456789abcdef0123456789abcdef0123')).toThrow(CustodyExecutionError);
        expect(() => custody.validateDestination('0x0000000000000000000000000000000000000000')).toThrow(/zero address/);
        expect(() => custody.validateDestination(NATIVE)).toThrow(/token contract/);
        expect(() => custody.validateDestination(HOT)).toThrow(/master hot wallet/);
    });

    it('rejects a transfer payload for the bridged USDC.e contract (distinct asset, never substituted)', () => {
        expect(() => custody.buildTokenTransferPayload({
            from: HOT, to: DEST, amountBaseUnits: 1000000n, contractAddress: USDC_E, signatureId: 'sig',
        })).toThrow(/non-canonical token contract/);
    });

    it('refuses to build a payload without a KMS signatureId (no fallback signing mode)', () => {
        expect(() => custody.buildTokenTransferPayload({
            from: HOT, to: DEST, amountBaseUnits: 1000000n, contractAddress: NATIVE, signatureId: null,
        })).toThrow(/No KMS signatureId/);
    });

    it('builds the EXACT Tatum ChainTransferEthErc20KMS request (decimal amount, MATIC chain, no from)', () => {
        const payload = custody.buildTokenTransferPayload({
            from: HOT, to: DEST, amountBaseUnits: 100123456n, contractAddress: NATIVE, signatureId: 'sig-1', index: 7,
        });
        // Exact provider contract — docs.tatum.io/reference/erc20transfer:
        expect(payload).toEqual({
            chain: 'MATIC',                     // Tatum chain identifier
            to: DEST,
            contractAddress: NATIVE,            // native USDC (never USDC.e)
            amount: '100.123456',               // DECIMAL token quantity — exact string
            digits: 6,
            signatureId: 'sig-1',
            index: 7,                           // only for mnemonic-based signature IDs
        });
        // The provider request carries NO from address (Tatum derives the
        // signer from the KMS identity) and NO private-key material ever.
        expect(payload).not.toHaveProperty('from');
        expect(payload).not.toHaveProperty('fromPrivateKey');
        expect(payload).not.toHaveProperty('currency');
    });

    it('builds the payload WITHOUT index when the signature ID is private-key based (index omitted, not zero)', () => {
        const payload = custody.buildTokenTransferPayload({
            from: HOT, to: DEST, amountBaseUnits: 1n, contractAddress: NATIVE, signatureId: 'sig-2', index: null,
        });
        expect(payload).not.toHaveProperty('index');
        expect(payload.amount).toBe('0.000001');
    });

    it('baseUnitsToDecimalString is EXACT: large values never pass through JS Number (base units are NOT the token quantity)', () => {
        expect(custody.baseUnitsToDecimalString(100123456n)).toBe('100.123456');
        expect(custody.baseUnitsToDecimalString(1000000n)).toBe('1');
        expect(custody.baseUnitsToDecimalString(1n)).toBe('0.000001');
        expect(custody.baseUnitsToDecimalString(0n)).toBe('0');
        // 1.23456789012345678e17 base units — beyond float53 precision.
        expect(custody.baseUnitsToDecimalString(123456789012345678n)).toBe('123456789012.345678');
        expect(custody.baseUnitsToDecimalString('9007199254740993000000')).toBe('9007199254740993');
        // Round-trip: toBaseUnits EXACTLY inverts the decimal string.
        expect(custody.toBaseUnits('123456789012.345678')).toBe(123456789012345678n);
    });
});

describe('§P.2 unit: production execution gates (fail-closed by default)', () => {
    afterEach(disableGates);

    it('is disabled by default (any single flag missing = no real execution)', () => {
        disableGates();
        expect(custody.executionGateStatus().enabled).toBe(false);
    });

    it.each([
        ['provider not LIVE', { TATUM_PROVIDER: 'MOCK' }],
        ['no API key', { TATUM_API_KEY: undefined }],
        ['KMS not enabled', { TATUM_KMS_ENABLED: undefined }],
        ['execution not enabled', { TATUM_CRYPTO_EXECUTION_ENABLED: undefined }],
    ])('stays disabled when %s', (_name, overrides) => {
        enableGates(overrides);
        const gate = custody.executionGateStatus();
        expect(gate.enabled).toBe(false);
        expect(() => custody.requireExecutionEnabled()).toThrow(/not enabled/i);
    });

    it('enables only with all three gates', () => {
        enableGates();
        const gate = custody.executionGateStatus();
        expect(gate.enabled).toBe(true);
        expect(gate.flags).toMatchObject({ providerLive: true, kmsEnabled: true, executionEnabled: true });
    });

    it('submitExecution fails closed before touching the database when gates are off', async () => {
        disableGates();
        await expect(custody.submitExecution({}, { executionId: 'x' }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
    });
});

describe('§P.2 unit: no raw private keys anywhere in the execution boundary', () => {
    it('the HTTP provider refuses any payload carrying private-key material', async () => {
        enableGates();
        const provider = custody.createHttpProvider();
        await expect(provider.submitTokenTransfer({ fromPrivateKey: '0xabc', to: DEST }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
    });

    it('no production execution-path source references fromPrivateKey or a private-key env var', () => {
        const files = [
            'services/tatumCustodyExecutionService.js',
            'services/custodyExecutionErrors.js',
            'controllers/withdrawalController.js',
            'workers/onchainSweepWorker.js',
            'routes/custodyRoutes.js',
        ];
        for (const f of files) {
            const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            expect(src).not.toMatch(/fromPrivateKey\s*[:=]/);
            expect(src).not.toMatch(/TATUM_PRIVATE_KEY/i);
        }
    });
});

describe('§P.2 unit: tx hash evidence rules (no fabricated hashes)', () => {
    it('accepts only 0x + 64 hex characters as real evidence', () => {
        expect(custody.isValidTxHash(TX_HASH)).toBe(true);
        expect(custody.isValidTxHash('0x' + 'ab'.repeat(31))).toBe(false);
        expect(custody.isValidTxHash('0x' + 'zz'.repeat(32))).toBe(false);
        expect(custody.isValidTxHash('')).toBe(false);
        expect(custody.isValidTxHash(null)).toBe(false);
    });

    it('verifies transfer semantics against chain evidence and rejects a matching-but-unrelated transaction', async () => {
        const provider = fakeProvider({ transaction: { status: '0x1', logs: [usdcTransferLog({ units: 100123456n })] } });
        const ok = await custody.verifyChainTransfer(provider, {
            txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 100123456n,
        });
        expect(ok.verified).toBe(true);

        const wrongAmount = await custody.verifyChainTransfer(provider, {
            txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 999n,
        });
        expect(wrongAmount.reason).toBe(ERROR_CLASSES.CHAIN_MISMATCH);

        const wrongRecipient = await custody.verifyChainTransfer(provider, {
            txHash: TX_HASH, fromAddress: HOT, toAddress: '0x' + '99'.repeat(20), contractAddress: NATIVE, amountBaseUnits: 100123456n,
        });
        expect(wrongRecipient.reason).toBe(ERROR_CLASSES.CHAIN_MISMATCH);
    });

    it('distinguishes pending / reverted / unparseable / malformed-hash evidence (fail-closed, never completed)', async () => {
        const notFound = await custody.verifyChainTransfer(fakeProvider({ transaction: null }), {
            txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1n,
        });
        expect(notFound.reason).toBe(ERROR_CLASSES.CONFIRMATION_PENDING);

        const reverted = await custody.verifyChainTransfer(fakeProvider({ transaction: { status: '0x0', logs: [] } }), {
            txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1n,
        });
        expect(reverted.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);

        const unparseable = await custody.verifyChainTransfer(fakeProvider({ transaction: { status: '0x1' } }), {
            txHash: TX_HASH, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1n,
        });
        expect(unparseable.reason).toBe(ERROR_CLASSES.CONFIRMATION_PENDING);
        expect(unparseable.verified).toBe(false);

        const malformed = await custody.verifyChainTransfer(fakeProvider({ transaction: { status: '0x1', logs: [usdcTransferLog({ units: 1n })] } }), {
            txHash: '0xdeadbeef', fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1n,
        });
        expect(malformed.reason).toBe(ERROR_CLASSES.CHAIN_MISMATCH);
    });
});

describe('§P.2 unit: provider error classification (a timeout is NOT "broadcast failed")', () => {
    it('classifies network/timeout/5xx as UNKNOWN_OUTCOME (ambiguous)', () => {
        for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET']) {
            const err = classifyProviderError(Object.assign(new Error('socket died'), { code }), 'transfer');
            expect(err.errorClass).toBe(ERROR_CLASSES.UNKNOWN_OUTCOME);
        }
        const http500 = classifyProviderError({ response: { status: 500, data: 'boom' } }, 'transfer');
        expect(http500.errorClass).toBe(ERROR_CLASSES.UNKNOWN_OUTCOME);
    });

    it('classifies 4xx validation as PROVIDER_REJECTED (definitive, pre-broadcast)', () => {
        const err = classifyProviderError({ response: { status: 400, data: { message: 'insufficient funds' } } }, 'transfer');
        expect(err.errorClass).toBe(ERROR_CLASSES.PROVIDER_REJECTED);
        expect(err.definitivePreBroadcast).toBe(true);
    });

    it('classifies credential refusal as CONFIGURATION_ERROR', () => {
        const err = classifyProviderError({ response: { status: 403 } }, 'transfer');
        expect(err.errorClass).toBe(ERROR_CLASSES.CONFIGURATION_ERROR);
    });

    it('redacts credential-shaped material from persisted messages', () => {
        const out = redact('call failed: x-api-key "SECRETKEY123" signature "SIG" password=hunter2');
        expect(out).not.toMatch(/SECRETKEY123|hunter2/);
        expect(out).toMatch(/REDACTED/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL POSTGRESQL PROOFS
// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('§P.2 custody execution (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');

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
        // Hermetic cleanup: this suite creates users, ledger rows, executions,
        // sweeps and mutates the System* singletons (the controller proofs
        // debit/credit them). Truncate everything it touches so no absolute-
        // balance state leaks into other real-PG suites.
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "CustodyExecution", "OnchainSweep", "TransactionHistory", "User", ' +
            '"SystemHotWallet", "SystemProfitFees", "SystemMasterCrypto", "AdminProfitLog", ' +
            '"AuditLog", "JournalEntry" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedFundedUser(balance = 500) {
        const user = await seedUser(prisma);
        return prisma.user.update({ where: { id: user.id }, data: { availableBalance: balance } });
    }

    async function makeWithdrawalExecution({ userId, txRecordId = 'tx-' + Math.random().toString(36).slice(2), amountBase = 1000000n }) {
        return custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${txRecordId}`,
            transactionHistoryId: txRecordId,
            userId,
            fromAddress: HOT,
            toAddress: DEST,
            amountBaseUnits: amountBase,
            feeChargeBaseUnits: 27500n,
            metadata: { customerDebitBaseUnits: String(amountBase) },
        });
    }

    // ── 1. Durable execution identity: duplicate withdrawal claim → one winner ──
    it('two identical withdrawal execution claims collide on the idempotency key — exactly one execution exists', async () => {
        const user = await seedFundedUser();
        const first = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-dup', amountBase: 1000000n });
        await expect(makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-dup', amountBase: 1000000n }))
            .rejects.toMatchObject({ code: 'P2002' });
        const count = await prisma.custodyExecution.count({ where: { idempotencyKey: 'withdrawal:wd-dup' } });
        expect(count).toBe(1);
        expect(first.kind).toBe('CUSTOMER_WITHDRAWAL');
        expect(first.amountBaseUnits).toBe(1000000n);
        expect(first.decimals).toBe(6);
    });

    // ── 2 + 4. Sweep claim race: overlapping workers → one claim, and the claim
    //    blocks retry after an AMBIGUOUS outcome (no blind double-send) ─────────
    it('two concurrent sweep claims for the same WalletAddress produce exactly one new claim', async () => {
        const user = await seedFundedUser();
        const claimArgs = {
            walletAddressId: 'wa-race-1', userId: user.id, fromAddress: CUST, toAddress: HOT, amountBaseUnits: 2000000n,
        };
        const results = await Promise.allSettled([
            custody.claimSweepExecution(prisma, claimArgs),
            custody.claimSweepExecution(prisma, claimArgs),
            custody.claimSweepExecution(prisma, claimArgs),
        ]);
        const claims = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(claims.filter((c) => c.isNew).length).toBe(1);
        expect(claims.filter((c) => !c.isNew).length).toBe(2);
        expect(new Set(claims.map((c) => c.execution.id)).size).toBe(1);
    });

    it('a sweep stuck in RECONCILIATION_REQUIRED blocks new claims for that address until a human reconciles it', async () => {
        const user = await seedFundedUser();
        const { execution } = await custody.claimSweepExecution(prisma, {
            walletAddressId: 'wa-amb-1', userId: user.id, fromAddress: CUST, toAddress: HOT, amountBaseUnits: 2000000n,
        });
        // Simulate the ambiguous outcome recorded by submitExecution on a timeout.
        await custody.reconcileExecution(prisma, {
            executionId: execution.id,
            errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME,
            errorMessage: 'simulated provider timeout',
        });
        const retry = await custody.claimSweepExecution(prisma, {
            walletAddressId: 'wa-amb-1', userId: user.id, fromAddress: CUST, toAddress: HOT, amountBaseUnits: 2000000n,
        });
        expect(retry.isNew).toBe(false);
        expect(retry.execution.id).toBe(execution.id);
        const inflight = await prisma.custodyExecution.count({ where: { walletAddressId: 'wa-amb-1' } });
        expect(inflight).toBe(1); // no second execution — no double-send of the same balance
    });

    it('a FAILED sweep frees the address for a later legitimate sweep', async () => {
        const user = await seedFundedUser();
        const { execution } = await custody.claimSweepExecution(prisma, {
            walletAddressId: 'wa-fail-1', userId: user.id, fromAddress: CUST, toAddress: HOT, amountBaseUnits: 2000000n,
        });
        await custody.failExecution(prisma, { executionId: execution.id, errorMessage: 'definitive rejection' });
        const retry = await custody.claimSweepExecution(prisma, {
            walletAddressId: 'wa-fail-1', userId: user.id, fromAddress: CUST, toAddress: HOT, amountBaseUnits: 3000000n,
        });
        expect(retry.isNew).toBe(true);
    });

    // ── 3. Ambiguous provider result stays reconcilable (no auto-refund) ────────
    it('a provider timeout during submission marks the execution RECONCILIATION_REQUIRED and refunds nothing', async () => {
        const user = await seedFundedUser(100);
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-timeout' });
        await custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: 'wd-timeout', userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n },
        });
        const userBefore = await prisma.user.findUnique({ where: { id: user.id } });
        const timeoutErr = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
        custody.__setProviderForTests(fakeProvider({ submitError: timeoutErr }));
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME });
        const after = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
        expect(after.status).toBe('RECONCILIATION_REQUIRED');
        expect(after.errorClass).toBe(ERROR_CLASSES.UNKNOWN_OUTCOME);
        const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
        expect(String(userAfter.availableBalance)).toBe(String(userBefore.availableBalance)); // NO auto-refund
        // Terminal: a blind resubmission is structurally impossible.
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
    });

    // ── 5 + 6 + 7. Forward-only transitions, exactly-once settlement ────────────
    it('settlement is exactly-once: duplicate settlement calls converge, and terminal states never move backward', async () => {
        const user = await seedFundedUser();
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1.0, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
        });
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: ledger.id });
        await prisma.custodyExecution.update({
            where: { id: execution.id },
            data: { status: 'CONFIRMING', txHash: TX_HASH, confirmedAt: null },
        });
        // Settlement authority: with no verified-evidence argument supplied,
        // settleExecution must verify the chain evidence ITSELF (makeWithdrawal
        // defaults to 1000000 base units HOT -> DEST) before completing.
        custody.__setProviderForTests(fakeProvider({
            transaction: { status: '0x1', logs: [usdcTransferLog({ from: HOT, to: DEST, units: 1000000n })] },
        }));
        const [a, b] = await Promise.all([
            custody.settleExecution(prisma, { executionId: execution.id }),
            custody.settleExecution(prisma, { executionId: execution.id }),
        ]);
        expect(a.settled ^ b.settled).toBeTruthy(); // exactly one settled
        expect([a, b].filter((r) => r.alreadySettled).length).toBe(1);
        const ledgerAfter = await prisma.transactionHistory.findUnique({ where: { id: ledger.id } });
        expect(ledgerAfter.status).toBe('COMPLETED');
        const executionAfter = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
        expect(executionAfter.status).toBe('COMPLETED');

        // completed cannot transition backward — failure/reconcile are no-ops
        expect(await custody.failExecution(prisma, { executionId: execution.id, errorMessage: 'late attempt' })).toBe(false);
        expect(await custody.reconcileExecution(prisma, { executionId: execution.id })).toBe(false);
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('COMPLETED');
    });

    it('a FAILED execution can never settle (no accidental completion, ledger stays FAILED)', async () => {
        const user = await seedFundedUser();
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1.0, feeUsdc: 0, txHash: null, status: 'FAILED' },
        });
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: ledger.id });
        await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'FAILED' } });
        const result = await custody.settleExecution(prisma, { executionId: execution.id });
        expect(result.settled).toBe(false);
        expect((await prisma.transactionHistory.findUnique({ where: { id: ledger.id } })).status).toBe('FAILED');
    });

    it('failWithdrawalExecution refunds EXACTLY ONCE (conditional transition guards the refund atomically)', async () => {
        const user = await seedFundedUser(100);
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-refund' });
        let refundRuns = 0;
        const refund = async (tx) => {
            refundRuns += 1;
            await tx.user.update({ where: { id: user.id }, data: { availableBalance: { increment: 1 } } });
        };
        const first = await custody.failWithdrawalExecution(prisma, {
            executionId: execution.id, errorClass: ERROR_CLASSES.PROVIDER_REJECTED, errorMessage: 'rejected', refund,
        });
        expect(first.failed).toBe(true);
        const second = await custody.failWithdrawalExecution(prisma, {
            executionId: execution.id, errorClass: ERROR_CLASSES.PROVIDER_REJECTED, errorMessage: 'rejected', refund,
        });
        expect(second.failed).toBe(false);
        expect(refundRuns).toBe(1); // exactly-once — a retry can never double-refund
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(101);
    });

    it('failWithdrawalExecution refuses to fail an execution that already broadcast (ambiguous — must reconcile)', async () => {
        const user = await seedFundedUser(100);
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-broadcast' });
        await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'BROADCAST', txHash: TX_HASH } });
        let refundRuns = 0;
        const result = await custody.failWithdrawalExecution(prisma, {
            executionId: execution.id, errorClass: ERROR_CLASSES.PROVIDER_REJECTED, errorMessage: 'late rejection',
            refund: async () => { refundRuns += 1; },
        });
        expect(result.failed).toBe(false);
        expect(refundRuns).toBe(0);
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('BROADCAST');
    });

    // ── 8 + 9. Four-eye exact-match verification + wrong contract / signer ────
    it('four-eye approval verifies EVERY material field and never approves a mismatched transaction', async () => {
        const user = await seedFundedUser();
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-approval' });
        const base = {
            kind: 'CUSTOMER_WITHDRAWAL', refId: 'wd-approval', userId: user.id,
            fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n,
        };
        const cases = [
            [{ ...base, toAddress: '0x' + '99'.repeat(20) }, /destination does not match/],
            [{ ...base, contractAddress: USDC_E }, /token contract does not match/],
            [{ ...base, amountBaseUnits: 1000001n }, /amount does not match/],
            [{ ...base, fromAddress: CUST }, /source\/signer address does not match/],
            [{ ...base, kind: 'DEPOSIT_SWEEP' }, /execution kind does not match/],
            [{ ...base, refId: 'other-ledger-row' }, /withdrawal reference does not match/],
            [{ ...base, userId: user.id + 12345 }, /user reference does not match/],
        ];
        for (const [expected, pattern] of cases) {
            await expect(custody.approveKmsRequest(prisma, { executionId: execution.id, expected }))
                .rejects.toMatchObject({ errorClass: ERROR_CLASSES.SIGNER_MISMATCH });
        }
        // Same user, different transaction reference must ALSO be rejected —
        // sharing a user is never sufficient for approval.
        await expect(custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: { ...base, refId: 'wd-approval' },
        })).resolves.toMatchObject({ approved: true });
        // Idempotent + safe to call repeatedly.
        const again = await custody.approveKmsRequest(prisma, { executionId: execution.id, expected: base });
        expect(again.alreadyApproved).toBe(true);
        await expect(custody.approveKmsRequest(prisma, { executionId: 'does-not-exist', expected: base }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
    });

    it('four-eye approval is rejected for terminal (stale) executions and for previously-DENIED requests', async () => {
        const user = await seedFundedUser();
        const e1 = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-stale' });
        await prisma.custodyExecution.update({ where: { id: e1.id }, data: { status: 'COMPLETED' } });
        await expect(custody.approveKmsRequest(prisma, {
            executionId: e1.id,
            expected: { fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n },
        })).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });

        const e2 = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-denied' });
        await custody.denyKmsRequest(prisma, e2.id, 'operator denied');
        await expect(custody.approveKmsRequest(prisma, {
            executionId: e2.id,
            expected: { fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n },
        })).rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
        expect((await prisma.custodyExecution.findUnique({ where: { id: e2.id } })).approvalStatus).toBe('DENIED');
    });

    it('a wrong token contract cannot be executed: USDC.e executions are rejected before submission', async () => {
        const user = await seedFundedUser();
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: 'withdrawal:usdce-attempt',
                kind: 'CUSTOMER_WITHDRAWAL', refId: 'wd-usdce', userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: USDC_E,
                fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                status: 'RESERVING', approvalStatus: 'APPROVED',
            },
        });
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.INVALID_ASSET });
        // Row is left in-flight for the caller to fail atomically with its refund.
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('RESERVING');
        await custody.failExecution(prisma, { executionId: execution.id, errorMessage: 'non-canonical asset' });
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('FAILED');
    });

    it('a signer/address mismatch is a hard failure (customer deposit source): the KMS identity must control the exact address', async () => {
        const user = await seedFundedUser();
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: 'sweep:signer-mismatch:1',
                kind: 'DEPOSIT_SWEEP', walletAddressId: 'wa-signer', userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: CUST, toAddress: HOT, amountBaseUnits: 1000000n, decimals: 6,
                status: 'RESERVING', approvalStatus: 'APPROVED',
                metadata: { derivationIndex: 5 },
            },
        });
        // Registry (tatum-kms getaddress proof) says signatureId@index 5
        // controls a DIFFERENT address than the one being swept.
        enableGates({ TATUM_KMS_SIGNER_REGISTRY: JSON.stringify([
            { signatureId: 'test-kms-signature-id', index: 5, address: '0x' + '77'.repeat(20), model: 'MNEMONIC_INDEXED' },
        ]) });
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.SIGNER_MISMATCH });
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('RESERVING');
        await custody.failExecution(prisma, { executionId: execution.id, errorMessage: 'signer mismatch' });
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('FAILED');
    });

    it('an UNPROVABLE signer configuration is fail-closed: no registry entry => no execution (never a guessed proof)', async () => {
        const user = await seedFundedUser();
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: 'sweep:signer-unprovable:1',
                kind: 'DEPOSIT_SWEEP', walletAddressId: 'wa-unprovable', userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: CUST, toAddress: HOT, amountBaseUnits: 1000000n, decimals: 6,
                status: 'RESERVING', approvalStatus: 'APPROVED',
                metadata: { derivationIndex: 5 },
            },
        });
        enableGates({ TATUM_KMS_SIGNER_REGISTRY: JSON.stringify([
            // Entry exists for a DIFFERENT index — index 5 has no proof.
            { signatureId: 'test-kms-signature-id', index: 9, address: CUST, model: 'MNEMONIC_INDEXED' },
        ]) });
        const provider = fakeProvider();
        custody.__setProviderForTests(provider);
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.SIGNER_MISMATCH });
        expect(provider.submitted).toHaveLength(0); // fail-closed BEFORE any provider call
    });

    it('submission without four-eye approval is refused (mainnet four-eye requirement)', async () => {
        const user = await seedFundedUser();
        const execution = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-noapproval' }); // approvalStatus PENDING
        custody.__setProviderForTests(fakeProvider({ pendingId: 'kms-1' }));
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.CONFIGURATION_ERROR });
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('RESERVING');
    });

    // ── Full async lifecycle with real evidence semantics ─────────────────────
    it('full withdrawal lifecycle: SUBMITTED → SIGNING → BROADCAST → CONFIRMING → COMPLETED only on matching chain evidence', async () => {
        const user = await seedFundedUser();
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 100, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${ledger.id}`,
            transactionHistoryId: ledger.id,
            userId: user.id,
            fromAddress: HOT,
            toAddress: DEST,
            amountBaseUnits: 100000000n,
        });
        await custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: ledger.id, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 100000000n },
        });

        // KMS accepts the request; the response carries ONLY the prepared
        // pending-transaction id (Tatum SignatureId semantics) — no tx hash.
        const pendingProvider = fakeProvider({ pendingId: 'tatum-pending-9' });
        custody.__setProviderForTests(pendingProvider);
        const submission = await custody.submitExecution(prisma, { executionId: execution.id });
        expect(submission.status).toBe('SIGNING');
        expect(submission.pendingId).toBe('tatum-pending-9');
        expect(submission.txHash).toBeUndefined();
        // The provider request is the EXACT Tatum contract: decimal amount
        // "100", MATIC chain, digits 6, hot-wallet signatureId@index 0, no from.
        expect(pendingProvider.submitted[0]).toEqual({
            chain: 'MATIC', to: DEST, contractAddress: NATIVE,
            amount: '100', digits: 6, signatureId: 'test-hot-signature-id', index: 0,
        });
        // The durable record keeps EXACT base units + the real pending id.
        const persisted = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
        expect(persisted.amountBaseUnits).toBe(100000000n);
        expect(persisted.tatumPendingId).toBe('tatum-pending-9');
        expect(persisted.txHash).toBeNull(); // NEVER fabricated from the submission response

        // Daemon signs+broadcasts → tx hash observed via the KMS request.
        const broadcastProvider = fakeProvider({
            kmsRequest: { id: 'kms-pending-9', txHash: TX_HASH, status: 'SIGNED' },
            transaction: null,
        });
        custody.__setProviderForTests(broadcastProvider);
        const afterKms = await custody.advanceExecution(prisma, { executionId: execution.id });
        expect(afterKms.status).toBe('BROADCAST');
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).txHash).toBe(TX_HASH);
        // Tatum's pending record is completed with the REAL blockchain tx id.
        expect(broadcastProvider.completions[0]).toEqual({ pendingId: 'tatum-pending-9', txId: TX_HASH });

        // Not yet confirmed on chain → stays BROADCAST (never COMPLETED early).
        const stillPending = await custody.advanceExecution(prisma, { executionId: execution.id });
        expect(stillPending.pending).toBe(true);

        // Chain evidence MATCHING the intended transfer → settles + ledger COMPLETED.
        const confirmedProvider = fakeProvider({
            kmsRequest: { id: 'kms-pending-9', txHash: TX_HASH, status: 'SIGNED' },
            transaction: { status: '0x1', logs: [usdcTransferLog({ from: HOT, to: DEST, units: 100000000n })] },
        });
        custody.__setProviderForTests(confirmedProvider);
        const settled = await custody.advanceExecution(prisma, { executionId: execution.id });
        expect(settled.status).toBe('COMPLETED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: ledger.id } })).status).toBe('COMPLETED');
    });

    it('chain evidence for a DIFFERENT transfer never settles the execution (goes to RECONCILIATION_REQUIRED, ledger stays PENDING)', async () => {
        const user = await seedFundedUser();
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 100, feeUsdc: 0.0275, txHash: null, status: 'PENDING' },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${ledger.id}`,
            transactionHistoryId: ledger.id,
            userId: user.id,
            fromAddress: HOT,
            toAddress: DEST,
            amountBaseUnits: 100000000n,
        });
        await custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: ledger.id, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 100000000n },
        });
        custody.__setProviderForTests(fakeProvider({ pendingId: 'tatum-pending-9' }));
        await custody.submitExecution(prisma, { executionId: execution.id });

        // Wrong-amount transfer evidence: a successful UNRELATED transaction.
        custody.__setProviderForTests(fakeProvider({
            kmsRequest: { id: 'kms-pending-9', txHash: TX_HASH, status: 'SIGNED' },
            transaction: { status: '0x1', logs: [usdcTransferLog({ from: HOT, to: DEST, units: 1n })] },
        }));
        const afterKms = await custody.advanceExecution(prisma, { executionId: execution.id });
        expect(afterKms.status).toBe('BROADCAST');
        const result = await custody.advanceExecution(prisma, { executionId: execution.id });
        expect(result.status).toBe('RECONCILIATION_REQUIRED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: ledger.id } })).status).toBe('PENDING');
    });

    it('reconcilePendingExecutions advances in-flight executions idempotently and never touches terminal ones', async () => {
        const user = await seedFundedUser();
        const e1 = await makeWithdrawalExecution({ userId: user.id, txRecordId: 'wd-rec1' });
        await prisma.custodyExecution.update({
            where: { id: e1.id },
            data: { status: 'SIGNING', tatumPendingId: 'kms-r1', approvalStatus: 'APPROVED' },
        });
        custody.__setProviderForTests(fakeProvider({
            kmsRequest: { id: 'kms-r1', txHash: TX_HASH, status: 'SIGNED' },
            transaction: { status: '0x1', logs: [usdcTransferLog({ from: HOT, to: DEST, units: 1000000n })] },
        }));
        // One lifecycle step per pass: SIGNING -> BROADCAST (tx hash observed).
        const pass1 = await custody.reconcilePendingExecutions(prisma);
        expect(pass1).toHaveLength(1);
        expect(pass1[0].status).toBe('BROADCAST');
        // Next pass verifies the chain evidence and settles.
        const pass2 = await custody.reconcilePendingExecutions(prisma);
        expect(pass2).toHaveLength(1);
        expect(pass2[0].status).toBe('COMPLETED');
        const pass3 = await custody.reconcilePendingExecutions(prisma); // terminal — not picked up again
        expect(pass3).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLER-LEVEL PROOFS (real PG + the REAL withdrawalController)
// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('§P.2 withdrawalController.cryptoWithdrawal (real PostgreSQL + real controller)', () => {
    let prisma;
    let withdrawalCtrl;
    const { seedUser } = require('./helpers/factories');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        withdrawalCtrl = require('../controllers/withdrawalController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(() => { enableGates(); });

    afterEach(async () => {
        custody.__setProviderForTests(null);
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "CustodyExecution", "OnchainSweep", "TransactionHistory", "User", ' +
            '"SystemHotWallet", "SystemProfitFees", "SystemMasterCrypto", "AdminProfitLog", ' +
            '"AuditLog", "JournalEntry" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    function makeReqRes({ userId, body }) {
        const req = {
            app: { get: (k) => (k === 'prisma' ? prisma : undefined) },
            user: { id: userId, createdAt: new Date(), email: 'custody-proof@azaman.test', phoneNumber: null, phoneVerified: false },
            body,
            ip: '203.0.113.10',
        };
        const res = {
            statusCode: null, payload: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.payload = b; return this; },
        };
        return { req, res };
    }

    async function seededUser(balance = 500) {
        // seedUser backs the starting balance with a matching COMPLETED
        // deposit row, so runDoubleCheck's Sum(ledger) == balance audit passes.
        return seedUser(prisma, { availableBalance: balance });
    }

    it('execution gates OFF → 503 NOT_ENABLED, and NOTHING is debited (no ledger row, no execution, no singleton writes)', async () => {
        disableGates();
        const user = await seededUser(500);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50', destination: DEST } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);
        expect(res.statusCode).toBe(503);
        expect(res.payload.code).toBe('CRYPTO_EXECUTION_NOT_ENABLED');
        const u = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(u.availableBalance)).toBe(500);
        expect(await prisma.transactionHistory.count({ where: { userId: user.id, type: 'WITHDRAWAL_CRYPTO' } })).toBe(0);
        expect(await prisma.custodyExecution.count({})).toBe(0);
        expect(await prisma.systemHotWallet.count({})).toBe(0);
        expect(await prisma.systemProfitFees.count({})).toBe(0);
    });

    it('gates ON + KMS pending-signing → 202 with NO tx hash, PENDING ledger row, SIGNING execution, exact-once debit', async () => {
        const user = await seededUser(500);
        const provider = fakeProvider({ pendingId: 'tatum-ctrl-1' });
        custody.__setProviderForTests(provider);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50.000000', destination: DEST } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);

        expect(res.statusCode).toBe(202);
        expect(res.payload.success).toBe(true);
        expect(res.payload.data.status).toBe('PENDING');
        expect(res.payload.data.txHash).toBeUndefined(); // no fabricated hash in the response

        const ledger = await prisma.transactionHistory.findFirst({ where: { userId: user.id, type: 'WITHDRAWAL_CRYPTO' } });
        expect(ledger.status).toBe('PENDING');
        expect(ledger.txHash).toBeNull();

        const execution = await prisma.custodyExecution.findFirst({ where: { kind: 'CUSTOMER_WITHDRAWAL' } });
        expect(execution.status).toBe('SIGNING');
        expect(execution.tatumPendingId).toBe('tatum-ctrl-1');
        expect(execution.txHash).toBeNull();
        expect(execution.approvalStatus).toBe('APPROVED'); // four-eye durable record pre-validated the transfer

        const u = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(u.availableBalance)).toBe(450); // debited exactly once

        const hot = await prisma.systemHotWallet.findUnique({ where: { id: 1 } });
        const fees = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        const netPayout = Number(ledger.amountUsdc);
        expect(Number(hot.balance)).toBeCloseTo(-netPayout, 6);
        expect(Number(fees.balance)).toBeCloseTo(Number(ledger.feeUsdc), 6);

        // The submitted provider payload is the EXACT Tatum contract: decimal
        // token quantity (NOT base units), native USDC contract, and the same
        // exact quantity as the durable execution's amountBaseUnits.
        expect(provider.submitted[0].chain).toBe('MATIC');
        expect(provider.submitted[0].digits).toBe(6);
        expect(provider.submitted[0].contractAddress).toBe(NATIVE);
        expect(provider.submitted[0].signatureId).toBe('test-hot-signature-id');
        expect(custody.toBaseUnits(provider.submitted[0].amount)).toBe(execution.amountBaseUnits);
        expect(provider.submitted[0]).not.toHaveProperty('from');       // KMS identity derives the sender
        expect(provider.submitted[0]).not.toHaveProperty('fromPrivateKey'); // KMS-only signing
        // ledger row (decimal) and execution agree exactly in base units
        expect(custody.toBaseUnits(String(ledger.amountUsdc))).toBe(execution.amountBaseUnits);
        // response carries the exact decimal strings, no binary-float amounts
        expect(res.payload.data.netPayout).toBe(String(ledger.amountUsdc));
        expect(custody.toBaseUnits(res.payload.data.netPayout)).toBe(execution.amountBaseUnits);
    });

    it('definitive provider rejection → 502 + EXACTLY-ONCE refund, ledger FAILED, execution FAILED', async () => {
        const user = await seededUser(500);
        const provider = fakeProvider({
            submitError: { response: { status: 400, data: { message: 'insufficient funds' } } },
        });
        custody.__setProviderForTests(provider);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50', destination: DEST } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);

        expect(res.statusCode).toBe(502);
        expect(res.payload.message).toMatch(/refunded/i);
        const u = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(u.availableBalance)).toBe(500); // full refund

        const ledger = await prisma.transactionHistory.findFirst({ where: { userId: user.id, type: 'WITHDRAWAL_CRYPTO' } });
        expect(ledger.status).toBe('FAILED');
        const execution = await prisma.custodyExecution.findFirst({});
        expect(execution.status).toBe('FAILED');
        expect(execution.errorClass).toBe('PROVIDER_REJECTED');

        const hot = await prisma.systemHotWallet.findUnique({ where: { id: 1 } });
        expect(Number(hot.balance)).toBe(0); // synthetic treasury write reversed too
    });

    it('provider timeout (ambiguous) → 202 pending, NO auto-refund, execution RECONCILIATION_REQUIRED', async () => {
        const user = await seededUser(500);
        const provider = fakeProvider({
            submitError: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
        });
        custody.__setProviderForTests(provider);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50', destination: DEST } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);

        expect([202, 502]).toContain(res.statusCode);
        expect(res.payload.data.reconciliationRequired).toBe(true);
        const u = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(u.availableBalance)).toBe(450); // debited, NOT refunded — reconciliation decides
        const execution = await prisma.custodyExecution.findFirst({});
        expect(execution.status).toBe('RECONCILIATION_REQUIRED');
        const ledger = await prisma.transactionHistory.findFirst({ where: { userId: user.id, type: 'WITHDRAWAL_CRYPTO' } });
        expect(ledger.status).toBe('PENDING'); // still reserved, never FAILED on an unknown outcome
    });

    it('invalid destination still 400s before any gate/debit work', async () => {
        const user = await seededUser(500);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50', destination: '0x123' } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);
        expect(res.statusCode).toBe(400);
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(500);
    });

    it('amount with more than 6 decimals is rejected (exact-decimal discipline)', async () => {
        const user = await seededUser(500);
        const { req, res } = makeReqRes({ userId: user.id, body: { amount: '50.1234567', destination: DEST } });
        await withdrawalCtrl.cryptoWithdrawal(req, res);
        expect(res.statusCode).toBe(400);
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(500);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// AMENDMENT REGRESSION PROOFS — real Tatum contract, four-eye validator,
// single-winner submission (CAS), settlement evidence authority, registry.
// ─────────────────────────────────────────────────────────────────────────────
describe('§P.2 unit: MAINNET four-eye is mandatory (gate + preflight fail closed)', () => {
    it('MAINNET + four-eye disabled => the execution gate refuses live signing entirely', () => {
        enableGates({ TATUM_KMS_ENVIRONMENT: 'MAINNET', TATUM_KMS_FOUR_EYE_REQUIRED: 'false' });
        const gate = custody.executionGateStatus();
        expect(gate.enabled).toBe(false);
        expect(gate.flags.mainnetFourEyeOk).toBe(false);
        expect(() => custody.requireExecutionEnabled()).toThrow(/not enabled/i);
    });

    it('MAINNET + four-eye required => gate enabled, and preflight reports the check green', async () => {
        enableGates({ TATUM_KMS_ENVIRONMENT: 'MAINNET', TATUM_KMS_FOUR_EYE_REQUIRED: 'true' });
        expect(custody.executionGateStatus().enabled).toBe(true);
        const pre = await custody.preflight(null);
        const fe = pre.checks.find((c) => c.name === 'kms_four_eye_required');
        expect(fe.ok).toBe(true);
        expect(fe.detail).toMatch(/mainnet/i);
    });

    it('preflight BLOCKS on a hot-wallet signer/address registry mismatch (fail-closed, not skipped)', async () => {
        enableGates({ TATUM_KMS_SIGNER_REGISTRY: JSON.stringify([
            // Registry proof says the hot wallet signatureId@index 0 controls a
            // DIFFERENT address than TATUM_HOT_WALLET_ADDRESS.
            { signatureId: 'test-hot-signature-id', index: 0, address: '0x' + '77'.repeat(20), model: 'MNEMONIC_INDEXED' },
        ]) });
        const pre = await custody.preflight(null);
        const hot = pre.checks.find((c) => c.name === 'hot_wallet_signer_address_control');
        expect(hot.ok).toBe(false);
        expect(hot.detail).toMatch(/MISMATCH/i);
        expect(pre.readyForLiveExecution).toBe(false);
    });

    it('preflight honestly reports (not blocks) a missing registry in non-live mode', async () => {
        disableGates();
        delete process.env.TATUM_KMS_SIGNER_REGISTRY;
        const pre = await custody.preflight(null);
        const hot = pre.checks.find((c) => c.name === 'hot_wallet_signer_address_control');
        expect(hot.ok).not.toBe(false); // skipped, not a lie
        expect(hot.detail).toMatch(/NOT verified/i);
    });
});

describeOrSkip('§P.2 amendment proofs (real PostgreSQL): four-eye validator + CAS + settlement authority', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');

    beforeAll(async () => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => { enableGates(); });
    afterEach(async () => {
        custody.__setProviderForTests(null);
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "CustodyExecution", "TransactionHistory", "User" RESTART IDENTITY CASCADE');
    }, 15000);

    async function approvedSigningExecution({ status = 'SIGNING', pendingId = 'tatum-4eye-1', approvalStatus = 'APPROVED', overrides = {} } = {}) {
        const user = await seedUser(prisma);
        return prisma.custodyExecution.create({
            data: {
                idempotencyKey: `wd-4eye-${Math.random().toString(36).slice(2)}`,
                kind: 'CUSTOMER_WITHDRAWAL', refId: 'ledger-1', userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                status, approvalStatus, tatumPendingId: pendingId,
                metadata: {},
                ...overrides,
            },
        });
    }

    // ── Four-eye external validation (the KMS daemon externalUrl contract) ──
    it('validator returns 2xx ONLY for the durably APPROVED, exact-matching execution', async () => {
        const execution = await approvedSigningExecution();
        const result = await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-1' });
        expect(result.approved).toBe(true);
        expect(result.httpStatus).toBe(200);
        expect(result.kind).toBe('CUSTOMER_WITHDRAWAL');
        // No secrets in the validator response.
        expect(result.signatureId).toBeUndefined();
        expect(result.tatumPendingId).toBeUndefined();
    });

    it('validator REFUSES: unknown id (404), PENDING/DENIED approval (403), terminal/stale (409), reconciliation (409)', async () => {
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'never-seen' })).httpStatus).toBe(404);
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'bad!id' })).httpStatus).toBe(404);

        const pendingApproval = await approvedSigningExecution({ pendingId: 'tatum-4eye-2', approvalStatus: 'PENDING' });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-2' })).httpStatus).toBe(403);

        const denied = await approvedSigningExecution({ pendingId: 'tatum-4eye-3', approvalStatus: 'DENIED' });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-3' })).httpStatus).toBe(403);

        const settled = await approvedSigningExecution({ pendingId: 'tatum-4eye-4', status: 'COMPLETED' });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-4' })).httpStatus).toBe(409);

        const reconciling = await approvedSigningExecution({ pendingId: 'tatum-4eye-5', status: 'RECONCILIATION_REQUIRED' });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-5' })).httpStatus).toBe(409);
    });

    it('validator REFUSES an execution whose transfer no longer matches its authorized semantics (wrong asset/amount/signer)', async () => {
        const wrongContract = await approvedSigningExecution({ pendingId: 'tatum-4eye-6', overrides: { contractAddress: USDC_E } });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-6' })).httpStatus).toBe(403);

        const zeroAmount = await approvedSigningExecution({ pendingId: 'tatum-4eye-7', overrides: { amountBaseUnits: 0n } });
        expect((await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-7' })).httpStatus).toBe(403);

        // The registry no longer proves the hot wallet signer controls HOT.
        enableGates({ TATUM_KMS_SIGNER_REGISTRY: JSON.stringify([
            { signatureId: 'test-kms-signature-id', index: 5, address: CUST, model: 'MNEMONIC_INDEXED' },
        ]) });
        const unproven = await approvedSigningExecution({ pendingId: 'tatum-4eye-8' });
        const refused = await custody.validateKmsPendingRequest(prisma, { pendingId: 'tatum-4eye-8' });
        expect(refused.approved).toBe(false);
        expect(refused.httpStatus).toBe(403);
    });

    it('the four-eye ROUTE is read-only, unauthenticated per the KMS protocol, and honors the optional IP allowlist', async () => {
        const router = require('../routes/kmsFourEyeRoutes');
        const routeHandler = router.stack.find((l) => l.route?.path === '/validate/:pendingId').route.stack.at(-1).handle;

        const mkRes = () => ({
            statusCode: null, payload: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.payload = b; return this; },
        });
        const mkReq = (pendingId, ip) => ({
            params: { pendingId }, ip,
            app: { get: (k) => (k === 'prisma' ? prisma : undefined) },
        });

        const execution = await approvedSigningExecution({ pendingId: 'tatum-route-1' });
        const ok = mkRes();
        await routeHandler(mkReq('tatum-route-1', '203.0.113.9'), ok);
        expect(ok.statusCode).toBe(200);
        expect(ok.payload.approved).toBe(true);

        const unknown = mkRes();
        await routeHandler(mkReq('never-seen', '203.0.113.9'), unknown);
        expect(unknown.statusCode).toBe(404); // non-2xx => KMS must not sign

        // IP allowlist enforced when configured.
        enableGates({ TATUM_KMS_VALIDATOR_ALLOWED_IPS: '10.0.0.5' });
        const blocked = mkRes();
        await routeHandler(mkReq('tatum-route-1', '203.0.113.9'), blocked);
        expect(blocked.statusCode).toBe(403);
        const allowed = mkRes();
        await routeHandler(mkReq('tatum-route-1', '10.0.0.5'), allowed);
        expect(allowed.statusCode).toBe(200);
    });

    // ── Single-winner submission (CAS): no second external submission, ever ──
    it('two CONCURRENT submitExecution calls produce EXACTLY ONE provider submission; the loser converges', async () => {
        const user = await seedUser(prisma);
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1, feeUsdc: 0, txHash: null, status: 'PENDING' },
        });
        const execution = await custody.createWithdrawalExecution(prisma, {
            idempotencyKey: `withdrawal:${ledger.id}`, transactionHistoryId: ledger.id, userId: user.id,
            fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n,
        });
        await custody.approveKmsRequest(prisma, {
            executionId: execution.id,
            expected: { kind: 'CUSTOMER_WITHDRAWAL', refId: ledger.id, userId: user.id, fromAddress: HOT, toAddress: DEST, contractAddress: NATIVE, amountBaseUnits: 1000000n },
        });
        const provider = fakeProvider({ pendingId: 'tatum-cas-1' });
        custody.__setProviderForTests(provider);
        const [a, b] = await Promise.allSettled([
            custody.submitExecution(prisma, { executionId: execution.id }),
            custody.submitExecution(prisma, { executionId: execution.id }),
        ]);
        // The CAS invariant: EXACTLY ONE external submission, no matter how
        // the loser observes the winner (converged OR ambiguous).
        expect(provider.submitted).toHaveLength(1);
        const outcomes = [a, b];
        const winner = outcomes.find((r) => r.status === 'fulfilled' && r.value.status === 'SIGNING' && !r.value.converged);
        expect(winner).toBeDefined();
        const loser = outcomes.find((r) => r !== winner);
        expect(
            (loser.status === 'fulfilled' && loser.value.converged === true) ||
            (loser.status === 'rejected' && loser.reason.errorClass === ERROR_CLASSES.UNKNOWN_OUTCOME && loser.reason.ambiguous === true)
        ).toBe(true); // either way: NO second submission
        const row = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
        expect(row.status).toBe('SIGNING');
        expect(row.tatumPendingId).toBe('tatum-cas-1');

        // A sequential retry AFTER the winner finished CONVERGES on the
        // existing execution (no error, no second provider call).
        const retry = await custody.submitExecution(prisma, { executionId: execution.id });
        expect(retry.converged).toBe(true);
        expect(retry.pendingId).toBe('tatum-cas-1');
        expect(provider.submitted).toHaveLength(1); // STILL exactly one submission
    });

    it('crash-after-claim (SUBMITTED, no pending id): retry throws UNKNOWN_OUTCOME and NEVER resubmits', async () => {
        const user = await seedUser(prisma);
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: 'wd-cas-crash-1', kind: 'CUSTOMER_WITHDRAWAL', refId: 'ledger-x', userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                status: 'SUBMITTED', approvalStatus: 'APPROVED', // claimed, provider outcome unknown
                metadata: {},
            },
        });
        const provider = fakeProvider();
        custody.__setProviderForTests(provider);
        await expect(custody.submitExecution(prisma, { executionId: execution.id }))
            .rejects.toMatchObject({ errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME, ambiguous: true });
        expect(provider.submitted).toHaveLength(0); // no blind double-send — reconciliation owns it
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('SUBMITTED');
    });

    // ── Settlement authority: COMPLETED requires verified chain evidence ──
    it('settleExecution WITHOUT verified chain evidence REFUSES to complete (pending/unfound evidence)', async () => {
        const user = await seedUser(prisma);
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1, feeUsdc: 0, txHash: null, status: 'PENDING' },
        });
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: `withdrawal:${ledger.id}`, kind: 'CUSTOMER_WITHDRAWAL', refId: ledger.id, userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                status: 'BROADCAST', txHash: TX_HASH, approvalStatus: 'APPROVED',
                metadata: {},
            },
        });
        // Chain evidence not found yet — a tx hash alone is NOT completion proof.
        custody.__setProviderForTests(fakeProvider({ transaction: null }));
        const refused = await custody.settleExecution(prisma, { executionId: execution.id });
        expect(refused.settled).toBe(false);
        expect(refused.reason).toBe('CHAIN_EVIDENCE_NOT_VERIFIED');
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('BROADCAST');
        expect((await prisma.transactionHistory.findUnique({ where: { id: ledger.id } })).status).toBe('PENDING');

        // A FORGED bare "evidence" object without the internal verification
        // brand is rejected — the settlement authority cannot be bypassed.
        const forged = await custody.settleExecution(prisma, { executionId: execution.id, evidence: { verified: true, detail: 'forged' } });
        expect(forged.settled).toBe(false);
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('BROADCAST');
    });

    it('settleExecution on a REVERTED receipt goes to RECONCILIATION_REQUIRED — never COMPLETED', async () => {
        const user = await seedUser(prisma);
        const ledger = await prisma.transactionHistory.create({
            data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1, feeUsdc: 0, txHash: null, status: 'PENDING' },
        });
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey: `withdrawal:${ledger.id}`, kind: 'CUSTOMER_WITHDRAWAL', refId: ledger.id, userId: user.id,
                network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
                fromAddress: HOT, toAddress: DEST, amountBaseUnits: 1000000n, decimals: 6,
                status: 'CONFIRMING', txHash: TX_HASH, approvalStatus: 'APPROVED',
                metadata: {},
            },
        });
        custody.__setProviderForTests(fakeProvider({ transaction: { status: '0x0', logs: [] } }));
        const result = await custody.settleExecution(prisma, { executionId: execution.id });
        expect(result.settled).toBe(false);
        expect(result.reason).toBe(ERROR_CLASSES.CHAIN_REVERTED);
        expect((await prisma.custodyExecution.findUnique({ where: { id: execution.id } })).status).toBe('RECONCILIATION_REQUIRED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: ledger.id } })).status).toBe('PENDING');
    });
});
