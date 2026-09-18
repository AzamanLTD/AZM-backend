// __tests__/custody-accounting.test.js
// =============================================================================
// Financial architecture §P.3 — custody accounting, evidence, PoR rewrite.
//
// Layers:
//  - UNIT (no DB): exact base-unit ↔ Decimal conversion; provider response
//    parsing (fail-closed); pure liability/report composition matrix
//    (fully-backed, unclassified exposure, restricted-obligation boundary,
//    fail-closed evidence); legacy synthetic coverage surface unchanged.
//  - REAL POSTGRESQL proofs: custody account identity convergence; registry
//    authority retirement; deposit candidate idempotency; transaction-evidence
//    verification lifecycle (verify, wrong-contract USDC.e rejection, amount /
//    address / direction / confirmation mismatches, provider-unavailable
//    fail-closed, concurrent double-verify exactly-once journal); balance
//    evidence supersession / out-of-order / convergence races; execution-
//    linked movements via settleExecution (atomic with settlement, rollback on
//    missing configuration, exactly-once); backfill idempotency; the full PoR
//    snapshot matrix (evidence-backed numerator, synthetic singletons excluded,
//    X/Y/Z separation, EVIDENCE_UNAVAILABLE fail-closed, per-user Merkle
//    proofs still verify, concurrent snapshots each count each account once).
//
// The Tatum HTTP surface is a DETERMINISTIC FAKE injected through the real
// provider adapters — these tests prove the accounting invariants and the
// OpenAPI response normalization, NOT that a blockchain was queried.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[custody-accounting] TEST_DATABASE_URL not set — skipping DB proofs.');

const { Prisma, PrismaClient } = require('@prisma/client');
const custody = require('../services/tatumCustodyExecutionService');
const accounting = require('../services/custodyAccountingService');
const integrity = require('../services/proofOfReservesIntegrityService');
const ledger = require('../services/ledgerService');
const reconciliation = require('../services/ledgerReconciliationService');
const restrictedObligations = require('../services/restrictedObligationService');
const {
    createTatumTxByHashProvider,
    createTatumTokenBalanceProvider,
    SOURCE_TX,
    SOURCE_BALANCE,
    CustodyEvidenceError,
    parseBaseUnitsNonNegative,
    decimalStringToBaseUnits,
} = require('../services/custodyEvidenceProvider');

const HOT = '0x' + '11'.repeat(20);
const CUST = '0x' + '22'.repeat(20);
const OTHER = '0x' + '55'.repeat(20);
const NATIVE = custody.CANONICAL.contractAddress;
const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const TX1 = '0x' + 'aa'.repeat(32);
const TX2 = '0x' + 'bb'.repeat(32);

const SAVED_ENV = {};
const ENV_KEYS = ['TATUM_PROVIDER', 'TATUM_API_KEY', 'TATUM_KMS_ENABLED', 'TATUM_CRYPTO_EXECUTION_ENABLED',
    'TATUM_KMS_SIGNATURE_ID', 'TATUM_KMS_CHAIN', 'TATUM_KMS_ENVIRONMENT', 'TATUM_KMS_FOUR_EYE_REQUIRED',
    'TATUM_HOT_WALLET_SIGNATURE_ID', 'TATUM_HOT_WALLET_INDEX', 'TATUM_HOT_WALLET_ADDRESS',
    'TATUM_TREASURY_ADDRESS', 'TATUM_KMS_SIGNER_REGISTRY', 'TATUM_KMS_VALIDATOR_ALLOWED_IPS', 'TATUM_BASE_URL',
    'CUSTODY_EVIDENCE_MAX_AGE_MINUTES'];
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
    process.env.TATUM_KMS_SIGNER_REGISTRY = JSON.stringify([
        { signatureId: 'test-kms-signature-id', index: 5, address: CUST, model: 'MNEMONIC_INDEXED' },
        { signatureId: 'test-hot-signature-id', index: 0, address: HOT, model: 'MNEMONIC_INDEXED' },
    ]);
    delete process.env.TATUM_KMS_VALIDATOR_ALLOWED_IPS;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

// ── deterministic fake Tatum HTTP layers (injected into the REAL adapters) ──
function fakeTxHttp({ entries, status = 200 } = {}) {
    return {
        get: async (url, config) => {
            if (status !== 200) {
                const err = new Error('HTTP ' + status);
                err.response = { status };
                throw err;
            }
            return { data: entries };
        },
    };
}
function fakeBalanceHttp({ balance, status = 200 } = {}) {
    return {
        get: async () => {
            if (status !== 200) {
                const err = new Error('HTTP ' + status);
                err.response = { status };
                throw err;
            }
            return { data: { balance } };
        },
    };
}
// Raw Tatum v4 TxData row (OpenAPI shape) — normalized by the REAL adapter.
function rawTxEntry({ hash = TX1, address = CUST, counterAddress = OTHER, tokenAddress = NATIVE,
    chain = 'polygon-mainnet', transactionType = 'fungible',
    transactionSubtype = 'incoming', amount = '100.123456', blockNumber = 48219430, timestamp = 1758000000 } = {}) {
    return {
        chain,
        hash,
        address,
        counterAddress,
        tokenAddress,
        blockNumber,
        transactionType,
        transactionSubtype,
        amount,
        timestamp,
    };
}

const D = (v) => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
// UNIT LAYER (no database)
// ─────────────────────────────────────────────────────────────────────────────

describe('§P.3 unit: exact base-unit ↔ Decimal conversion', () => {
    it('renders exact decimal strings from base units (never via float)', () => {
        expect(accounting.decimalStringFromBaseUnits(100123456n)).toBe('100.123456');
        expect(accounting.decimalStringFromBaseUnits(1n)).toBe('0.000001');
        expect(accounting.decimalStringFromBaseUnits(0n)).toBe('0');
        expect(accounting.decimalStringFromBaseUnits(42000000n)).toBe('42');
        expect(accounting.decimalStringFromBaseUnits(5000000n)).toBe('5');
        expect(accounting.decimalStringFromBaseUnits(-150n)).toBe('-0.00015');
        expect(accounting.decimalStringFromBaseUnits(9007199254740993000000n)).toBe('9007199254740993'); // above float precision, still exact
    });

    it('requires BigInt input (a Number would already be lossy)', () => {
        expect(() => accounting.decimalStringFromBaseUnits(100123456)).toThrow(/BigInt/);
        expect(() => accounting.decimalStringFromBaseUnits('100')).toThrow(/BigInt/);
    });

    it('produces exact Prisma.Decimal values above float precision', () => {
        const dec = accounting.decimalFromBaseUnits(123456789012345678n);
        expect(dec.toString()).toBe('123456789012.345678');
        expect(dec instanceof Prisma.Decimal).toBe(true);
    });
});

describe('§P.3 unit: provider response parsing fails closed', () => {
    it('accepts exact non-negative integer base-unit strings and rejects everything else', () => {
        expect(parseBaseUnitsNonNegative('0')).toBe(0n);
        expect(parseBaseUnitsNonNegative('150000000')).toBe(150000000n);
        expect(() => parseBaseUnitsNonNegative('100.5')).toThrow(CustodyEvidenceError);
        expect(() => parseBaseUnitsNonNegative('-1')).toThrow(CustodyEvidenceError);
        expect(() => parseBaseUnitsNonNegative('abc')).toThrow(CustodyEvidenceError);
        expect(() => parseBaseUnitsNonNegative('')).toThrow(CustodyEvidenceError);
        expect(() => parseBaseUnitsNonNegative('1e6')).toThrow(CustodyEvidenceError);
        expect(() => parseBaseUnitsNonNegative(null)).toThrow(CustodyEvidenceError);
    });

    it('converts exact decimal amounts and rejects precision overflow', () => {
        expect(decimalStringToBaseUnits('100.123456', 6)).toBe(100123456n);
        expect(decimalStringToBaseUnits('7.5', 6)).toBe(7500000n);
        expect(decimalStringToBaseUnits('0.000001', 6)).toBe(1n);
        expect(() => decimalStringToBaseUnits('100.1234567', 6)).toThrow(CustodyEvidenceError);
        expect(() => decimalStringToBaseUnits('1.2.3', 6)).toThrow(CustodyEvidenceError);
        expect(() => decimalStringToBaseUnits('-5', 6)).toThrow(CustodyEvidenceError);
    });
});

describe('§P.4 wave-3 unit: pure liability report composition — denominator authority', () => {
    const compose = integrity.composeLiabilityReport;
    // §P.4 wave-3: the denominator is defined ONCE (customer + restricted)
    // and every field derives from it. Flows are diagnostic evidence ONLY.

    it('A: 100 liability, no restriction → fully backed when 100 real reserve exists', () => {
        const r = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(100),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.effectiveObligationTotal.toString()).toBe('100'); // THE denominator
        expect(r.isFullyBacked).toBe(true);
        expect(r.liabilityAttestation).toBe('COMPLETE');
        expect(r.reserveRatioPercent.toString()).toBe('100'); // same denominator
        expect(r.coverageOfTotalUsdcObligation.toString()).toBe('1');
        expect(r.flowReconciliationDifference.toString()).toBe('0');
        expect(r.classificationFailure).toBe(null);
    });

    it('B: pending external withdrawal — customer 90 + restricted 10 = effective 100, no false flow failure, exactly-once counting', () => {
        const r = compose({
            customerLiabilityTotal: D(90),   // reservation moved 10 OUT of available
            restrictedObligationsTotal: D(10),
            flowLiabilityTotal: D(100),      // flows legitimately still total the pre-reservation amount
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(100),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.effectiveObligationTotal.toString()).toBe('100'); // counted exactly once
        // THE pre-wave-3 false failure: flows (100) > mixed pool (90) fired
        // LIABILITY_FLOW_EXCEEDS_MIXED_POOL. Against the EFFECTIVE
        // denominator the state is exactly reconciled.
        expect(r.classificationFailure).toBe(null);
        expect(r.flowReconciliationDifference.toString()).toBe('0');
        expect(r.liabilityAttestation).toBe('COMPLETE');
        expect(r.isFullyBacked).toBe(true); // 100 real reserve satisfies the invariant
        expect(r.reserveRatioPercent.toString()).toBe('100');
        // The restricted component is reported separately, never folded into
        // the customer liability and never double counted.
        expect(r.customerLiabilityTotal.toString()).toBe('90');
        expect(r.restrictedObligationsTotal.toString()).toBe('10');
    });

    it('C: internal reclassification stays inside customer liability — restricted denominator unchanged', () => {
        // 90 available + 10 escrow-locked (internal bucket move): total
        // customer obligation unchanged, restricted component unchanged.
        const before = compose({
            customerLiabilityTotal: D(90),
            restrictedObligationsTotal: D(10),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(100),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        const after = compose({
            customerLiabilityTotal: D(90), // same total — bucket composition is internal
            restrictedObligationsTotal: D(10), // restricted denominator does NOT grow
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(100),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(after.effectiveObligationTotal.eq(before.effectiveObligationTotal)).toBe(true);
        expect(after.restrictedObligationsTotal.toString()).toBe('10');
        expect(after.isFullyBacked).toBe(true);
    });

    it('D: insufficient reserve fails closed with the EXACT effective denominator', () => {
        const r = compose({
            customerLiabilityTotal: D(90),
            restrictedObligationsTotal: D(10),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(99), // 1 short of the effective 100
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.isFullyBacked).toBe(false);
        expect(r.effectiveObligationTotal.toString()).toBe('100'); // exact denominator preserved
        expect(r.reserveRatioPercent.toString()).toBe('99'); // same denominator, honest ratio
        expect(r.coverageOfTotalUsdcObligation.toString()).toBe('0.99');
        expect(r.liabilityAttestation).toBe('COMPLETE'); // authority is fine — the RESERVE is short
    });

    it('restricted obligations UNMODELED (null): denominator unknown — fail closed, never invented as zero', () => {
        const r = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: null,
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(150),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.effectiveObligationTotal).toBe(null); // denominator unknown
        expect(r.isFullyBacked).toBe(false);
        expect(r.restrictedObligationsAvailable).toBe(false);
        expect(r.reserveRatioPercent.toString()).toBe('0'); // unknown denominator never looks trustworthy
        // Attestation still classifies the flow evidence honestly.
        expect(r.liabilityAttestation).toBe('COMPLETE');
        // Once restricted obligations become authoritative, the same healthy
        // state IS fully backed — the gate is the unknown boundary itself.
        const modeled = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(150),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(modeled.restrictedObligationsAvailable).toBe(true);
        expect(modeled.isFullyBacked).toBe(true);
    });

    it('authority holds liability the flows cannot explain → INCOMPLETE (unclassified exposure, exact)', () => {
        const r = compose({
            customerLiabilityTotal: D(130), // 30 above what the flows explain
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(150),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.unclassifiedExposure.toString()).toBe('30');
        expect(r.flowReconciliationDifference.toString()).toBe('-30'); // signed exact
        expect(r.liabilityAttestation).toBe('INCOMPLETE');
        expect(r.isFullyBacked).toBe(false); // never silently dropped from the attestation
    });

    it('flows exceeding the EFFECTIVE denominator (not the bare pool) → explicit failure, UNATTESTABLE, never a falsely clean zero', () => {
        // X_flows = 150, customer pool = 100, restricted = 0 → effective 100.
        // The flows claim more than the authority covers — an inconsistent
        // history that must fail closed. (Pre-wave-3 this fired against the
        // bare mixed pool; the comparison base is now the full denominator.)
        const r = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(150),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(200),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.classificationFailure).toBe('LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION');
        expect(r.liabilityAttestation).toBe('UNATTESTABLE');
        expect(r.isFullyBacked).toBe(false);
        expect(r.unclassifiedExposure).toBe(null); // NOT reinterpreted as zero
        expect(r.flowReconciliationDifference.toString()).toBe('50'); // exact signed diagnostic
        // The denominator fields stay consistent with the authority.
        expect(r.effectiveObligationTotal.toString()).toBe('100');
        expect(r.reserveRatioPercent.toString()).toBe('200'); // A/effective*100 — SAME denominator
        // The boundary case flows == effective is NOT a failure.
        const reconciled = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(200),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(reconciled.classificationFailure).toBe(null);
        expect(reconciled.unclassifiedExposure.toString()).toBe('0');
        expect(reconciled.liabilityAttestation).toBe('COMPLETE');
        expect(reconciled.isFullyBacked).toBe(true);
    });

    it('flows unavailable (invalid classification) → UNATTESTABLE, fail closed', () => {
        const r = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: null,
            flowClassificationStatus: null,
            eligibleReserveTotal: D(150),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.liabilityAttestation).toBe('UNATTESTABLE');
        expect(r.isFullyBacked).toBe(false);
        expect(r.flowReconciliationDifference).toBe(null);
        expect(r.classificationFailure).toBe(null); // flows are diagnostics — no false authority failure
        expect(r.effectiveObligationTotal.toString()).toBe('100'); // authority still exact
    });

    it('unhealthy evidence is not fully backed even when A >= effective', () => {
        const r = compose({
            customerLiabilityTotal: D(100),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(100),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(150),
            evidenceHealthy: false, evidenceStatus: 'EVIDENCE_UNAVAILABLE',
        });
        expect(r.isFullyBacked).toBe(false);
    });

    it('zero effective obligation: ratio 100, fully backed only once restricted is modeled', () => {
        const r = compose({
            customerLiabilityTotal: D(0),
            restrictedObligationsTotal: null,
            flowLiabilityTotal: D(0),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(10),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(r.isFullyBacked).toBe(false); // restricted component still unknown
        expect(r.coverageOfTotalUsdcObligation).toBe(null); // undefined coverage is explicit
        const modeled = compose({
            customerLiabilityTotal: D(0),
            restrictedObligationsTotal: D(0),
            flowLiabilityTotal: D(0),
            flowClassificationStatus: 'OK',
            eligibleReserveTotal: D(10),
            evidenceHealthy: true, evidenceStatus: 'HEALTHY',
        });
        expect(modeled.reserveRatioPercent.toString()).toBe('100');
        expect(modeled.isFullyBacked).toBe(true);
    });
});
describe('§P.3 unit: legacy synthetic coverage surface is unchanged and labeled', () => {
    it('fiat liquidity is still never counted as reserve backing, and is marked non-authoritative', () => {
        const result = integrity.calculateReserveCoverage({
            systemCrypto: 60, hotWallet: 40, fiatPool: 1000, liabilities: 200,
        });
        expect(result.totalReserves).toBe(100);
        expect(result.reserveRatio).toBe(0.5);
        expect(result.fiatPool).toBe(1000);
        expect(result.authoritative).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL POSTGRESQL PROOFS
// ─────────────────────────────────────────────────────────────────────────────

describeOrSkip('§P.3 custody accounting (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "CustodyEvidence", "CustodyMovement", "CustodyAccount", "CustodyExecution", ' +
        '"OnchainSweep", "TransactionHistory", "WalletAddress", "User", "SystemHotWallet", ' +
        '"SystemMasterCrypto", "SystemFiatPool", "JournalEntry", "LedgerTransaction", "LedgerAccount", "ProofOfReservesSnapshot", ' +
        '"ProofOfReservesLeaf", "RestrictedObligation" RESTART IDENTITY CASCADE'
    );
    // 30s hook timeout: TRUNCATE of 14 tables must survive GitHub-hosted
    // runners with throttled disk (observed 20x fsync slowdown, e.g. CI run
    // 35272208092) — the default 5s turned a slow host into a full battery
    // failure cascade. Same rationale as the explicit 15s afterEach below.
    beforeEach(async () => {
        enableGates();
        process.env.CUSTODY_EVIDENCE_MAX_AGE_MINUTES = '15';
        await TRUNCATE_ALL(); // hermetic: never inherit battery leftovers
    }, 30000);
    afterEach(async () => {
        custody.__setProviderForTests(null);
        await TRUNCATE_ALL();
    }, 30000);

    async function seedRegistryAddress(userId, { address = CUST, status = 'ACTIVE' } = {}) {
        return prisma.walletAddress.create({
            data: {
                userId,
                network: 'POLYGON',
                asset: 'USDC',
                contractAddress: NATIVE,
                address: address.toLowerCase(),
                status,
            },
        });
    }

    async function recordCandidate({ registry, txHash = TX1, units = 100123456n } = {}) {
        return prisma.$transaction(async (tx) =>
            accounting.recordDepositCandidate(tx, {
                walletAddress: registry,
                txHash,
                amountBaseUnits: units,
                transactionHistoryId: null,
                creditedAmountDecimalString: accounting.decimalStringFromBaseUnits(units),
            }));
    }

    function txProviderWith(entries) {
        return createTatumTxByHashProvider({ http: fakeTxHttp({ entries }), apiKey: 'k' });
    }
    function balanceProviderWith(balance) {
        return createTatumTokenBalanceProvider({ http: fakeBalanceHttp({ balance }), apiKey: 'k' });
    }

    // Per-address balance provider for createSnapshot runs: answers ONLY the
    // mapped addresses and observes "now", so every account served is fresh.
    function stubProviderMap(map) {
        const seen = [];
        return {
            source: 'TATUM_V3_TOKEN_BALANCE',
            async getBalance({ network, contractAddress, address, decimals }) {
                const addr = address.toLowerCase();
                if (!(addr in map)) {
                    throw new (require('../services/custodyEvidenceProvider').CustodyEvidenceError)('PROVIDER_UNAVAILABLE', 'no balance for ' + addr);
                }
                seen.push(addr);
                const spec = map[addr];
                const balance = typeof spec === 'object' ? spec.balance : spec;
                const ageMs = typeof spec === 'object' && spec.ageMs ? spec.ageMs : 0;
                return {
                    source: 'TATUM_V3_TOKEN_BALANCE', scope: 'ACCOUNT_BALANCE',
                    network, asset: 'USDC',
                    contractAddress: contractAddress.toLowerCase(),
                    address: addr,
                    balanceBaseUnits: BigInt(balance),
                    observedAt: new Date(Date.now() - ageMs), blockReference: null, raw: {},
                };
            },
        };
    }

    // Stub balance provider with a pinned observedAt (the real adapter's own
    // normalization path is proven by the provider-level tests above; here we
    // need deterministic observation times).
    function stubBalance(balance, observedAt) {
        return {
            source: SOURCE_BALANCE,
            async getBalance({ network, contractAddress, address }) {
                return {
                    source: SOURCE_BALANCE, scope: 'ACCOUNT_BALANCE',
                    network, asset: 'USDC',
                    contractAddress: contractAddress.toLowerCase(),
                    address: address.toLowerCase(),
                    balanceBaseUnits: BigInt(balance),
                    observedAt, blockReference: null, raw: { balance },
                };
            },
        };
    }

    // ── 1. Custody account identity ───────────────────────────────────────────
    describe('custody accounts: identity + registry authority', () => {
        it('ensureDepositAccount is idempotent and converges on the unique identity', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const a = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const b = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            expect(a.id).toBe(b.id);
            expect(a.tier).toBe('USER_DEPOSIT_ADDRESS');
            expect(a.status).toBe('ACTIVE');
            expect(a.address).toBe(CUST);
            expect(a.contractAddress).toBe(NATIVE);
            expect(a.walletAddressId).toBe(registry.id);

            // A duplicate registry row for the same address is structurally
            // impossible (§P.1 unique (address, network)) — re-issue is an update.
            await expect(seedRegistryAddress(user.id)).rejects.toMatchObject({ code: 'P2002' });
            // Re-ensuring after any registry metadata update converges the SAME account.
            const refreshed = await prisma.walletAddress.update({
                where: { id: registry.id },
                data: { lastObservedAt: new Date() },
            });
            const c = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: refreshed }));
            expect(c.id).toBe(a.id);
            expect(c.walletAddressId).toBe(registry.id);
            expect(await prisma.custodyAccount.count()).toBe(1);
        });

        it('distinct addresses are distinct accounts; identity collision is impossible', async () => {
            const u1 = await seedUser(prisma);
            const u2 = await seedUser(prisma);
            const r1 = await seedRegistryAddress(u1.id, { address: CUST });
            const r2 = await seedRegistryAddress(u2.id, { address: OTHER });
            await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: r1 }));
            await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: r2 }));
            await expect(prisma.$transaction((tx) => tx.custodyAccount.create({
                data: {
                    tier: 'USER_DEPOSIT_ADDRESS', network: 'POLYGON', asset: 'USDC',
                    contractAddress: NATIVE, address: CUST.toLowerCase(), status: 'ACTIVE',
                },
            }))).rejects.toMatchObject({ code: 'P2002' });
            expect(await prisma.custodyAccount.count()).toBe(2);
        });

        it('retiring the registry row retires the custody account and removes it from the reserve set', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            let eligible = await accounting.syncAndListEligibleAccounts(prisma, { hotWalletAddress: HOT, hotWalletContractAddress: NATIVE });
            expect(eligible.map((a) => a.id)).toContain(account.id);

            await prisma.walletAddress.update({ where: { id: registry.id }, data: { status: 'RETIRED' } });
            eligible = await accounting.syncAndListEligibleAccounts(prisma, { hotWalletAddress: HOT, hotWalletContractAddress: NATIVE });
            expect(eligible.map((a) => a.id)).not.toContain(account.id);
            const after = await prisma.custodyAccount.findUnique({ where: { id: account.id } });
            expect(after.status).toBe('RETIRED');
        });

        it('hot wallet account is idempotent and only the configured address is eligible', async () => {
            const hot = await prisma.$transaction((tx) => accounting.ensureHotWalletAccount(tx, {
                address: HOT, network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
            }));
            const hot2 = await prisma.$transaction((tx) => accounting.ensureHotWalletAccount(tx, {
                address: HOT, network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE,
            }));
            expect(hot.id).toBe(hot2.id);
            expect(hot.tier).toBe('MASTER_HOT_WALLET');

            // A stale hot-wallet custody account for a DIFFERENT address is not eligible.
            await prisma.custodyAccount.create({
                data: { tier: 'MASTER_HOT_WALLET', network: 'POLYGON', asset: 'USDC', contractAddress: NATIVE, address: OTHER.toLowerCase(), status: 'ACTIVE' },
            });
            const eligible = await accounting.syncAndListEligibleAccounts(prisma, { hotWalletAddress: HOT, hotWalletContractAddress: NATIVE });
            const hotAccounts = eligible.filter((a) => a.tier === 'MASTER_HOT_WALLET');
            expect(hotAccounts.length).toBe(1);
            expect(hotAccounts[0].id).toBe(hot.id);
        });
    });

    // ── 2. Deposit candidates ─────────────────────────────────────────────────
    describe('deposit candidates: idempotent, candidate-only', () => {
        it('records a CANDIDATE keyed by deposit:POLYGON:<txHash>; duplicates converge', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const first = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            expect(first.isNew).toBe(true);
            expect(first.movement.status).toBe('CANDIDATE');
            expect(first.movement.kind).toBe('DEPOSIT_IN');
            expect(first.movement.evidenceSource).toBe('TATUM_WEBHOOK');
            expect(first.movement.amountBaseUnits).toBe(100123456n);
            expect(first.movement.txHash).toBe(TX1);
            expect(first.movement.verifiedAt).toBe(null);

            const dup = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            expect(dup.isNew).toBe(false);
            expect(dup.movement.id).toBe(first.movement.id);
            expect(await prisma.custodyMovement.count()).toBe(1);
            // A webhook credit creates NO evidence row and NO journal row.
            expect(await prisma.custodyEvidence.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);
        });

        it('rejects non-positive, non-BigInt, or missing identities (fail-closed)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            await expect(recordCandidate({ registry, units: 0n })).rejects.toThrow(/positive amountBaseUnits/);
            await expect(recordCandidate({ registry, units: -5n })).rejects.toThrow(/positive amountBaseUnits/);
            await expect(recordCandidate({ registry, units: '100' })).rejects.toThrow(/BigInt|positive/);
        });
    });

    // ── 3. Transaction-evidence verification lifecycle ────────────────────────
    describe('verifyDepositMovement: transaction evidence is the ONLY verification path', () => {
        it('verifies a genuine inbound native-USDC transfer: VERIFIED + evidence + no duplicate journal', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });

            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100.123456' })]);
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });

            expect(result.verified).toBe(true);
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('VERIFIED');
            expect(after.fromAddress).toBe(OTHER);
            expect(after.evidenceSource).toBe(SOURCE_TX);
            expect(after.evidenceId).not.toBe(null);
            expect(after.verificationDetail.blockNumber).toBe(48219430);

            // Evidence row: TRANSACTION scope, bound to the account + block reference.
            const evidence = await prisma.custodyEvidence.findUnique({ where: { id: after.evidenceId } });
            expect(evidence.scope).toBe('TRANSACTION');
            expect(evidence.source).toBe(SOURCE_TX);
            expect(evidence.txHash).toBe(TX1);
            expect(evidence.blockReference).toBe('48219430');
            expect(evidence.amountBaseUnits).toBe(100123456n);

            // JOURNAL RECONCILIATION (§P.3): the deposit's economic journal
            // representation already exists exactly once (journalIntegration
            // recorded the customer credit at webhook time). Custody
            // verification deliberately posts NO JournalEntry — a second
            // representation of the same economic event would double-count
            // the ledger. Assert exactly that: zero custody journal rows.
            expect(await prisma.journalEntry.count({
                where: { OR: [{ entryType: { in: ['CUSTODY_DEPOSIT', 'CUSTODY_WITHDRAWAL', 'CUSTODY_SWEEP'] } }, { relatedEntity: 'custodyMovement' }] },
            })).toBe(0);
            const trialSums = await prisma.journalEntry.aggregate({ _sum: { debit: true, credit: true } });
            if (trialSums._sum.debit != null) { // empty journal (this test posts none) is trivially balanced
                expect(trialSums._sum.debit.minus(trialSums._sum.credit).isZero()).toBe(true);
            }
        });

        it('a BALANCE provider can never verify a movement (structural separation)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry });
            await expect(accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: balanceProviderWith('100123456') }))
                .rejects.toThrow(/TATUM_V4_TX_BY_HASH/);
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('CANDIDATE');
        });

        it.each([
            ['WRONG_CONTRACT', (addr) => [rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), tokenAddress: USDC_E, amount: '100.123456' })], /WRONG_CONTRACT/],
            ['AMOUNT_MISMATCH', (addr) => [rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '55.000001' })], /AMOUNT_MISMATCH/],
            ['ADDRESS_MISMATCH', (addr) => [rawTxEntry({ hash: TX1, address: OTHER, amount: '100.123456' })], /ADDRESS_MISMATCH/],
            ['NOT_INCOMING', (addr) => [rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), transactionSubtype: 'outgoing', amount: '100.123456' })], /NOT_INCOMING/],
            ['NOT_CONFIRMED', (addr) => [rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), blockNumber: null, amount: '100.123456' })], /NOT_CONFIRMED/],
            ['TX_NOT_FOUND', (addr) => [], /TX_NOT_FOUND/],
        ])('definitive mismatch %s → FAILED with explicit reason, no journal, no evidence', async (_name, buildEntries, reasonRe) => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: txProviderWith(buildEntries()) });
            expect(result.verified).toBe(false);
            expect(result.reason).toMatch(reasonRe);
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('FAILED');
            expect(after.failureReason).toMatch(reasonRe);
            expect(await prisma.journalEntry.count()).toBe(0);
            expect(await prisma.custodyEvidence.count()).toBe(0);
        });

        it('a matching-unrelated transaction (different hash contents) cannot verify the movement', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX2, units: 100123456n });
            // Provider returns an entry for a DIFFERENT hash than requested.
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100.123456' })]);
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(result.verified).toBe(false);
            expect(result.reason).toMatch(/HASH_MISMATCH/); // a different transaction's transfer can never verify this movement
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('FAILED');
        });

        it('provider unavailable → candidate stays CANDIDATE (fail-closed, retryable)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry });
            const provider = createTatumTxByHashProvider({ http: fakeTxHttp({ status: 503 }), apiKey: 'k' });
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(result.verified).toBe(false);
            expect(result.retryable).toBe(true);
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('CANDIDATE');
            expect(after.failureReason).toBe(null);
        });

        it('concurrent double-verify converges: exactly one VERIFIED transition and one evidence row, no custody journal', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100.123456' })]);
            const [a, b] = await Promise.all([
                accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider }),
                accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider }),
            ]);
            expect(a.verified || b.verified).toBe(true);
            expect(await prisma.custodyEvidence.count({ where: { scope: 'TRANSACTION' } })).toBe(1); // exactly one evidence, never two
            expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0); // no custody journal at all
        });

        it('re-verifying an already-verified movement is a no-op', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100.123456' })]);
            await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            const again = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(again.alreadyVerified).toBe(true);
            expect(await prisma.custodyEvidence.count({ where: { scope: 'TRANSACTION' } })).toBe(1); // no duplicate evidence
            expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0); // and never any custody journal
        });

        it('batch verify processes candidates and reports outcomes', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100.123456' })]);
            const results = await accounting.verifyPendingDepositMovements(prisma, { txProvider: provider });
            expect(results.length).toBe(1);
            expect(results[0].verified).toBe(true);
        });
    });

    // ── 4. Balance evidence: supersession, out-of-order, races ────────────────
    describe('balance evidence: accepted/superseded/rejected semantics', () => {
        it('records an ACTIVE observation; a newer one supersedes (never overwrites) it', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));

            const t0 = new Date(Date.now() - 60000);
            const first = await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', t0) });
            expect(first.recorded).toBe(true);
            expect(first.evidence.status).toBe('ACTIVE');
            expect(first.evidence.balanceBaseUnits).toBe(150000000n);
            expect(first.evidence.blockReference).toBe(null); // documented: no block reference

            const newer = await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('200000000', new Date()) });
            expect(newer.recorded).toBe(true);
            const active = await prisma.custodyEvidence.findFirst({ where: { custodyAccountId: account.id, status: 'ACTIVE' } });
            expect(active.balanceBaseUnits).toBe(200000000n);
            const superseded = await prisma.custodyEvidence.findUnique({ where: { id: first.evidence.id } });
            expect(superseded.status).toBe('SUPERSEDED');
            expect(superseded.supersededById).toBe(newer.evidence.id);
            expect(await prisma.custodyEvidence.count({ where: { custodyAccountId: account.id } })).toBe(2); // retained for audit
        });

        it('an exact duplicate observation is idempotent (no second ACTIVE row)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const t = new Date();
            const a = await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', t) });
            const b = await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', t) });
            expect(b.idempotent || b.recorded).toBe(true);
            if (b.idempotent) expect(b.evidence.id).toBe(a.evidence.id);
            expect(await prisma.custodyEvidence.count({ where: { status: 'ACTIVE' } })).toBe(1);
        });

        it('an out-of-order observation is REJECTED and can never silently overwrite a newer value', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const now = new Date();
            await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', now) });
            const stale = await accounting.observeAccountBalance(prisma, {
                account, provider: stubBalance('999999999', new Date(now.getTime() - 30000)),
            });
            expect(stale.recorded).toBe(false);
            expect(stale.reason).toBe('OUT_OF_ORDER_OBSERVATION');
            const active = await prisma.custodyEvidence.findFirst({ where: { custodyAccountId: account.id, status: 'ACTIVE' } });
            expect(active.balanceBaseUnits).toBe(150000000n); // unchanged
            const rejected = await prisma.custodyEvidence.findFirst({ where: { status: 'REJECTED' } });
            expect(rejected.rejectionReason).toBe('OUT_OF_ORDER_OBSERVATION');
            expect(rejected.balanceBaseUnits).toBe(999999999n); // recorded for audit, not aggregated
        });

        it('a malformed balance response fails closed (recorded: false, no evidence row)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const result = await accounting.observeAccountBalance(prisma, { account, provider: balanceProviderWith('100.5') });
            expect(result.recorded).toBe(false);
            expect(result.retryable).toBe(true);
            expect(await prisma.custodyEvidence.count()).toBe(0);
        });

        it('an observation that does not bind to the requested account is rejected', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const evil = {
                source: SOURCE_BALANCE,
                getBalance: async () => ({
                    source: SOURCE_BALANCE, scope: 'ACCOUNT_BALANCE', network: 'POLYGON', asset: 'USDC',
                    contractAddress: NATIVE, address: OTHER, balanceBaseUnits: 5n, observedAt: new Date(),
                    blockReference: null, raw: {},
                }),
            };
            const result = await accounting.observeAccountBalance(prisma, { account, provider: evil });
            expect(result.recorded).toBe(false);
            expect(await prisma.custodyEvidence.count()).toBe(0);
        });

        it('concurrent observations converge on the partial unique ACTIVE index (exactly one ACTIVE)', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            const base = Date.now();
            await Promise.allSettled([
                accounting.observeAccountBalance(prisma, { account, provider: stubBalance('111111111', new Date(base)) }),
                accounting.observeAccountBalance(prisma, { account, provider: stubBalance('222222222', new Date(base + 1)) }),
                accounting.observeAccountBalance(prisma, { account, provider: stubBalance('333333333', new Date(base + 2)) }),
            ]);
            expect(await prisma.custodyEvidence.count({ where: { custodyAccountId: account.id, status: 'ACTIVE' } })).toBe(1);
        });

        it('getFreshAcceptedEvidence expires outside the freshness window', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', new Date(Date.now() - 16 * 60 * 1000)) });
            expect(await accounting.getFreshAcceptedEvidence(prisma, { custodyAccountId: account.id, maxAgeMs: 15 * 60 * 1000 })).toBe(null);
            await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('150000000', new Date()) });
            const fresh = await accounting.getFreshAcceptedEvidence(prisma, { custodyAccountId: account.id, maxAgeMs: 15 * 60 * 1000 });
            expect(fresh.balanceBaseUnits).toBe(150000000n);
        });
    });

    // ── 5. Execution-linked movements ──────────────────────────────────────────
    describe('execution-linked movements: sweeps and withdrawals', () => {
        it('settleExecution atomically creates the VERIFIED withdrawal movement; no duplicate journal representation', async () => {
            const user = await seedUser(prisma);
            const ledger = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1.0, feeUsdc: 0, txHash: null, status: 'PENDING' },
            });
            const execution = await custody.createWithdrawalExecution(prisma, {
                idempotencyKey: `withdrawal:${ledger.id}`,
                transactionHistoryId: ledger.id,
                userId: user.id,
                fromAddress: HOT, toAddress: OTHER, amountBaseUnits: 1000000n, feeChargeBaseUnits: 0n,
            });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'CONFIRMING', txHash: TX1 } });
            custody.__setProviderForTests({
                name: 'FAKE',
                async submitTokenTransfer() { return { pendingId: 'p', txHash: null }; },
                async getTransaction() { return { status: '0x1', logs: [] }; },
            });
            // Chain evidence: HOT -> OTHER for 1.0 USDC (native contract).
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
                            data: '0x' + BigInt(1000000n).toString(16).padStart(64, '0'),
                        }],
                    };
                },
            });
            const result = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(result.settled).toBe(true);

            const movement = await prisma.custodyMovement.findFirst({ where: { custodyExecutionId: execution.id } });
            expect(movement).not.toBe(null);
            expect(movement.kind).toBe('WITHDRAWAL_OUT');
            expect(movement.status).toBe('VERIFIED');
            expect(movement.amountBaseUnits).toBe(1000000n);
            expect(movement.toAddress).toBe(OTHER.toLowerCase());
            expect(movement.destinationAccountId).toBe(null); // external — never a custody account
            const hotAccount = await prisma.custodyAccount.findUnique({ where: { id: movement.sourceAccountId } });
            expect(hotAccount.tier).toBe('MASTER_HOT_WALLET');
            expect(hotAccount.address).toBe(HOT);

            // The withdrawal's economic journal representation already exists
            // exactly once (journalIntegration.recordWithdrawal runs at
            // withdrawal initiation, referencing the execution). Settlement
            // must NOT create a second one — assert zero custody journal rows.
            expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0);
        });

        it('settlement failure rolls the movement back WITH the settlement (atomicity)', async () => {
            const user = await seedUser(prisma);
            const ledger = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 1.0, feeUsdc: 0, txHash: null, status: 'PENDING' },
            });
            const execution = await custody.createWithdrawalExecution(prisma, {
                idempotencyKey: `withdrawal:${ledger.id}`,
                transactionHistoryId: ledger.id,
                userId: user.id,
                fromAddress: HOT, toAddress: OTHER, amountBaseUnits: 1000000n, feeChargeBaseUnits: 0n,
            });
            await prisma.custodyExecution.update({ where: { id: execution.id }, data: { status: 'CONFIRMING', txHash: TX1 } });
            // REAL, verifiable chain evidence: HOT -> OTHER for 1.0 native USDC.
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
                            data: '0x' + BigInt(1000000n).toString(16).padStart(64, '0'),
                        }],
                    };
                },
            });
            // Break ONLY the custody-accounting prerequisite: hot wallet unset.
            enableGates({ TATUM_HOT_WALLET_ADDRESS: undefined });
            await expect(custody.settleExecution(prisma, { executionId: execution.id })).rejects.toThrow(/hot wallet|configuration|CONFIGURATION/i);
            // The WHOLE settlement rolled back: not COMPLETED, no movement, no journal.
            const after = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
            expect(after.status).not.toBe('COMPLETED');
            expect(await prisma.custodyMovement.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);

            // Restore configuration: the settlement (and its movement) completes.
            enableGates();
            const result = await custody.settleExecution(prisma, { executionId: execution.id });
            expect(result.settled).toBe(true);
            expect(await prisma.custodyMovement.count({ where: { custodyExecutionId: execution.id } })).toBe(1);
        });

        it('recordExecutionMovement is idempotent per execution and guards the unique index', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const execution = {
                id: 'exec-sweep-1', kind: 'DEPOSIT_SWEEP', network: 'POLYGON', asset: 'USDC',
                contractAddress: NATIVE, walletAddressId: registry.id, userId: user.id,
                fromAddress: CUST, toAddress: HOT, amountBaseUnits: 5000000n, decimals: 6, txHash: TX2, refId: null,
            };
            const first = await prisma.$transaction(async (tx) => accounting.recordExecutionMovement(tx, { execution, hotWalletAddress: HOT }));
            expect(first.isNew).toBe(true);
            expect(first.movement.kind).toBe('SWEEP');
            const dup = await prisma.$transaction(async (tx) => accounting.recordExecutionMovement(tx, { execution, hotWalletAddress: HOT }));
            expect(dup.isNew).toBe(false);
            expect(dup.movement.id).toBe(first.movement.id);

            // No custody journal rows: sweeps are custody-internal, and the
            // existing JournalEntry has no sweep representation to duplicate.
            expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0);
            // The movement is evidence-branded with the execution's own verification.
            expect(first.movement.evidenceSource).toBe('CUSTODY_EXECUTION_VERIFIED_CHAIN');
            const src = await prisma.custodyAccount.findUnique({ where: { id: first.movement.sourceAccountId } });
            expect(src.tier).toBe('USER_DEPOSIT_ADDRESS');
            const dst = await prisma.custodyAccount.findUnique({ where: { id: first.movement.destinationAccountId } });
            expect(dst.tier).toBe('MASTER_HOT_WALLET');
        });

        it('backfill creates movements for settled executions missing one — idempotently', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const execution = await prisma.custodyExecution.create({
                data: {
                    kind: 'DEPOSIT_SWEEP', status: 'COMPLETED', network: 'POLYGON', asset: 'USDC',
                    contractAddress: NATIVE, walletAddressId: registry.id, userId: user.id,
                    fromAddress: CUST, toAddress: HOT, amountBaseUnits: 3000000n, decimals: 6,
                    txHash: TX2, idempotencyKey: 'sweep:backfill:1',
                },
            });
            const first = await accounting.backfillMovementsForCompletedExecutions(prisma, { hotWalletAddress: HOT });
            expect(first.created).toBe(1);
            const second = await accounting.backfillMovementsForCompletedExecutions(prisma, { hotWalletAddress: HOT });
            expect(second.created).toBe(0);
            expect(await prisma.custodyMovement.count({ where: { custodyExecutionId: execution.id } })).toBe(1);
            // Skips cleanly when the hot wallet is not configured.
            const third = await accounting.backfillMovementsForCompletedExecutions(prisma, {});
            expect(third.skipped).toBe(true);
        });
    });

    // ── 6. Liability flow classification + PoR snapshots ───────────────────────
    describe('PoR snapshot: denomination-honest, evidence-backed, fail-closed', () => {
        async function seedAccountWithRegistry({ address = CUST } = {}) {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const registry = await seedRegistryAddress(user.id, { address });
            return { user, registry };
        }

        it('classifies X/Y/Z exactly from authoritative rows (fiat-settled USDC credits INCLUDED, candidates excluded from Y)', async () => {
            const { user } = await seedAccountWithRegistry();
            // Crypto deposit: webhook credited (TransactionHistory COMPLETED) but
            // the movement is only a CANDIDATE → counts in X, NOT in Y.
            await recordCandidateFlow(user, TX1, 100);
            // Fiat deposit settled in USDC units: counted in X (never excluded).
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'DEPOSIT_FIAT', amountUsdc: 50, feeUsdc: 0, txHash: null, status: 'COMPLETED' },
            });
            // Crypto withdrawal: full debit (net + fee) leaves X; net leaves Y.
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 20, feeUsdc: 1, txHash: null, status: 'COMPLETED' },
            });
            const flows = await accounting.classifyUsdcLiabilityFlows(prisma);
            // X = (100 + 50) - (20 + 1) = 129 exactly.
            expect(flows.usdcLiabilityTotal.toString()).toBe('129');
            // Y = 0 verified deposits - 20 net payout = -20 (exact signed).
            expect(flows.evidenceLinkedUsdcObligation.toString()).toBe('-20');
            // Verifying the deposit movement moves the 100 into Y.
            const registry = await prisma.walletAddress.findFirst({ where: { userId: user.id } });
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100000000n });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100' })]);
            await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            const flowsAfter = await accounting.classifyUsdcLiabilityFlows(prisma);
            expect(flowsAfter.evidenceLinkedUsdcObligation.toString()).toBe('80'); // 100 - 20
            expect(flowsAfter.usdcLiabilityTotal.toString()).toBe('129'); // X unchanged
        });

        it('snapshot numerator is exactly the accepted evidence sum — synthetic singletons cannot compensate', async () => {
            const { user, registry } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100); // X = 100 (candidate, unverified)
            // The webhook credit path would also credit the balance — seed a
            // RECONCILED pool (mixed == X) so this test exercises the happy
            // composition, not the X > mixed failure path.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 100 } });
            // Make the synthetic mirrors huge — they must NOT inflate the numerator.
            await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 1000000 }, create: { id: 1, balance: 1000000 } });
            await prisma.systemHotWallet.upsert({ where: { id: 1 }, update: { balance: 1000000 }, create: { id: 1, balance: 1000000 } });
            // Fresh accepted evidence: deposit address 100.5 USDC + hot wallet
            // 50 USDC — served by the per-address provider createSnapshot uses
            // to observe every eligible account.
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '100500000', [HOT]: '50000000' }),
            });
            expect(snapshot.evidenceStatus).toBe('HEALTHY');
            expect(snapshot.eligibleReserveTotal.toString()).toBe('150.5'); // exact evidence sum
            expect(snapshot.usdcLiabilityTotal.toString()).toBe('100');
            expect(snapshot.unclassifiedExposure.toString()).toBe('0'); // mixed pool == X here
            // Evidence healthy + A (150.5) >= X (100) + Z == 0 — the classified
            // invariant is satisfied. Wave-2: restricted obligations are now
            // FULLY MODELED (every writer migrated), so Z is a known quantity
            // here (zero — this scenario seeds no restricted obligation rows
            // and no restricted ledger reclassifications) and the snapshot can
            // assert full backing on the complete denominator.
            expect(snapshot.isFullyBacked).toBe(true); // restricted denominator modeled (Z=0)
            expect(snapshot.liabilityAttestation).toBe('COMPLETE'); // the classified part is complete
            expect(snapshot.breakdown.invariant.blockedBy).toBeNull(); // nothing blocks the invariant
            expect(snapshot.custodyAccountCount).toBe(2);
            expect(snapshot.acceptedEvidenceCount).toBe(2);
            expect(snapshot.missingEvidenceCount).toBe(0);
            expect(snapshot.assetIdentity.contractAddress).toBe(NATIVE);
            expect(snapshot.evidenceLinkedLiabilityTotal.toString()).toBe('0'); // candidate not verified
            // Synthetic mirrors are exposed as display-only, never authoritative.
            expect(snapshot.breakdown.reserves.legacySynthetic.systemMasterCrypto.toString()).toBe('1000000');
            expect(snapshot.breakdown.reserves.legacySynthetic.note).toMatch(/NON-AUTHORITATIVE/);
            // Restricted obligations boundary is explicit. Post wave-2 the
            // restricted total is MODELED (a known quantity), not an unknown
            // null — with no restricted rows in this scenario it is exactly 0.
            expect(snapshot.restrictedObligationsTotal.toString()).toBe('0');
            expect(snapshot.restrictedObligationsAvailable).toBe(true);
        });

        it('X > EFFECTIVE denominator (over-classified flows) fails closed — LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION, never a falsely clean COMPLETE', async () => {
            const { user } = await seedAccountWithRegistry();
            // 150 classified USDC obligation (completed deposit flow)...
            await recordCandidateFlow(user, TX1, 150);
            // ...but the liability AUTHORITY holds only 100 (a partial
            // credit / inconsistent state). The classification EXCEEDS the
            // effective denominator (customer 100 + restricted 0) it is
            // reconciled against. §P.4 wave-3: the comparison base is the
            // EFFECTIVE denominator, not the bare mixed pool.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 100 } });

            // Fresh evidence is HEALTHY and A (200) >= effective (100) — the
            // inconsistent flow history alone must block the attestation.
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '200000000', [HOT]: '0' }),
            });
            expect(snapshot.evidenceStatus).toBe('HEALTHY');              // the evidence is NOT the problem
            expect(snapshot.eligibleReserveTotal.toString()).toBe('200');  // A >= effective and still not attestable
            expect(snapshot.liabilityAttestation).toBe('UNATTESTABLE');    // NOT COMPLETE
            expect(snapshot.isFullyBacked).toBe(false);
            expect(snapshot.unclassifiedExposure).toBe(null);              // the 50-unit deficit is NOT zero
            expect(snapshot.breakdown.usdcObligation.classificationFailure).toBe('LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION');
            expect(snapshot.breakdown.usdcObligation.flowReconciliationDifference).toBe('50'); // exact signed diagnostic
            expect(snapshot.breakdown.invariant.blockedBy).toBe('LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION');
            // §P.4 wave-3: reserveRatio derives from the SAME denominator as
            // the invariant — it honestly reports A/effective (200/100),
            // while the failure is carried by the attestation and blockedBy,
            // never by faking the ratio to a trustworthy-looking zero.
            expect(snapshot.reserveRatio.toString()).toBe('200');
            // The authority fields stay exact — the DENOMINATOR is the
            // projection total (100), never replaced by the failed flows.
            expect(snapshot.usdcLiabilityTotal.toString()).toBe('100');
        });

        it('unclassified exposure (Z > 0) forces INCOMPLETE and not fully backed', async () => {
            const { user, registry } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100); // X = 100
            // Unexplained mixed-pool claim: a direct balance mutation 40 ABOVE
            // what the classified flows explain (legacy AZM conversion path).
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 140 } });

            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '100000000' }),
            });
            expect(snapshot.unclassifiedExposure.toString()).toBe('40');
            expect(snapshot.liabilityAttestation).toBe('INCOMPLETE');
            expect(snapshot.isFullyBacked).toBe(false); // Z is never dropped from the denominator
        });

        it('audit case B: pending withdrawal reservation — restricted obligations rejoin the denominator, NO false flow failure', async () => {
            const { user } = await seedAccountWithRegistry();
            // Deposit credited: X = 100 from the flow history, and the
            // projection holds the full amount (availableBalance 100).
            await recordCandidateFlow(user, TX1, 100);
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 100 } });
            // Pending withdrawal reserves 10: the projection releases it to
            // the restricted bucket (90) and the obligation row holds 10.
            // Pre-wave-3 this state fired a FALSE LIABILITY_FLOW_EXCEEDS
            // failure (X=100 > bare mixed pool 90) — the exact production
            // regression the audit flagged.
            await prisma.$transaction(async (tx) => {
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { decrement: 10 } } });
                const reservation = await ledger.post(tx, {
                    idempotencyKey: `ledger:withdrawal:crypto:test:${TX1}`,
                    entryType: 'CUSTODY_WITHDRAWAL',
                    description: 'test pending withdrawal reservation',
                    reference: `withdrawal:crypto:test:${TX1}`,
                    userId: user.id,
                    lines: [
                        { account: `user:${user.id}:liability`, debit: '10' },
                        { account: 'restricted:reserves', credit: '10' },
                    ],
                });
                await restrictedObligations.createForPendingWithdrawal(tx, {
                    sourceType: 'PENDING_CRYPTO_WITHDRAWAL',
                    reference: `withdrawal:crypto:test:${TX1}`,
                    userId: user.id, amount: '10', asset: 'USDC', network: 'POLYGON',
                    ledgerTransactionId: reservation.transaction.id,
                });
            });

            // A (100) == effective denominator (90 customer + 10 restricted).
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '100000000', [HOT]: '0' }),
            });
            expect(snapshot.breakdown.usdcObligation.classificationStatus).toBe('OK');
            expect(snapshot.breakdown.usdcObligation.classificationFailure).toBeNull();
            expect(snapshot.liabilityAttestation).toBe('COMPLETE'); // NO false failure
            expect(snapshot.isFullyBacked).toBe(true);
            // THE denominator: effective 100 — the reserved 10 is still owed.
            expect(snapshot.usdcLiabilityTotal.toString()).toBe('100');
            expect(snapshot.breakdown.usdcObligation.customerLiabilityTotal.toString()).toBe('90');
            expect(snapshot.breakdown.usdcObligation.restrictedObligationsTotal.toString()).toBe('10');
            expect(snapshot.restrictedObligationsTotal.toString()).toBe('10');
            expect(snapshot.breakdown.usdcObligation.flowReconciliationDifference.toString()).toBe('0');
            expect(snapshot.unclassifiedExposure.toString()).toBe('0');
            expect(snapshot.breakdown.invariant.blockedBy).toBeNull();
        });

        it('no accepted fresh evidence → EVIDENCE_UNAVAILABLE and NOT fully backed (fail-closed)', async () => {
            const { user, registry } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            const { snapshot } = await integrity.createSnapshot({ balanceProvider: null });
            expect(snapshot.evidenceStatus).toBe('EVIDENCE_UNAVAILABLE');
            expect(snapshot.isFullyBacked).toBe(false);
            expect(snapshot.eligibleReserveTotal.toString()).toBe('0');
            expect(snapshot.missingEvidenceCount).toBe(snapshot.custodyAccountCount);
        });

        it('stale evidence does not feed the numerator (freshness window)', async () => {
            const { user } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            // The provider answers, but its (only) observation for the deposit
            // address is 17 minutes old — beyond the 15-minute freshness
            // window. It is RECORDED (audit) but NOT aggregated.
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({
                    [CUST]: { balance: '100000000', ageMs: 17 * 60 * 1000 },
                    [HOT]: '50000000',
                }),
            });
            expect(snapshot.evidenceStatus).toBe('PARTIAL');
            expect(snapshot.missingEvidenceCount).toBe(1);
            expect(snapshot.evidenceSummary.missing[0].reason).toBe('STALE_EVIDENCE');
            expect(snapshot.eligibleReserveTotal.toString()).toBe('50'); // only the fresh hot-wallet evidence
            expect(snapshot.isFullyBacked).toBe(false); // 50 < 100 outstanding
        });

        it('retired registry addresses never enter the reserve set', async () => {
            const { user, registry } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('100000000', new Date()) });
            await prisma.walletAddress.update({ where: { id: registry.id }, data: { status: 'RETIRED' } });
            const { snapshot } = await integrity.createSnapshot({ balanceProvider: stubProviderMap({ [HOT]: '100000000' }) });
            // The retired deposit address is gone from the reserve set — only
            // the (freshly observed) hot wallet remains eligible.
            expect(snapshot.custodyAccountCount).toBe(1);
            expect(snapshot.evidenceSummary.accepted.map((a) => a.tier)).toEqual(['MASTER_HOT_WALLET']);
            expect(snapshot.eligibleReserveTotal.toString()).toBe('100');
            expect(snapshot.evidenceSummary.accepted.every((a) => a.tier !== 'USER_DEPOSIT_ADDRESS')).toBe(true);
        });

        it('concurrent snapshots each count every custody account exactly once', async () => {
            const { user, registry } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
            await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('100000000', new Date()) });
            const provider = stubProviderMap({ [CUST]: '100000000', [HOT]: '0' });
            const [s1, s2] = await Promise.all([
                integrity.createSnapshot({ balanceProvider: provider }),
                integrity.createSnapshot({ balanceProvider: provider }),
            ]);
            for (const { snapshot } of [s1, s2]) {
                expect(snapshot.eligibleReserveTotal.toString()).toBe('100');
                const ids = snapshot.evidenceSummary.accepted.map((a) => a.accountId);
                expect(new Set(ids).size).toBe(ids.length); // no double counting
                expect(snapshot.evidenceStatus === 'HEALTHY' || snapshot.evidenceStatus === 'PARTIAL').toBe(true); // CONCURRENT_OBSERVATION may converge one account to the fresh winner
            }
        });

        it('per-user Merkle proofs still verify over the new snapshot', async () => {
            const { user } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 100 } }); // as the webhook credit path does
            const { snapshot } = await integrity.createSnapshot({ balanceProvider: stubProviderMap({ [CUST]: '0', [HOT]: '0' }) });
            const proof = await integrity.verifyUser(user.id, snapshot.id);
            expect(proof.verified).toBe(true);
            expect(proof.yourBalance.available.toString()).toBe('100');
        });

        it('getLatestSnapshot + integrity report expose the additive §P.3 fields', async () => {
            const { user } = await seedAccountWithRegistry();
            await recordCandidateFlow(user, TX1, 100);
            // Reconcile the pool with the classified flow (as the webhook
            // credit path does) — mixed == X == 100.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 100 } });
            // No provider at all and no TATUM_API_KEY → the whole snapshot is
            // EVIDENCE_UNAVAILABLE and cannot claim full backing.
            const savedKey = process.env.TATUM_API_KEY;
            delete process.env.TATUM_API_KEY;
            await integrity.createSnapshot({ balanceProvider: null });
            process.env.TATUM_API_KEY = savedKey;
            const latest = await integrity.getLatestSnapshot();
            expect(latest.usdcLiabilityTotal).toBe('100');
            expect(latest.liabilityAttestation).toBe('COMPLETE'); // liability composition itself succeeded
            expect(latest.evidenceStatus).toBe('EVIDENCE_UNAVAILABLE');
            expect(latest.assetIdentity.network).toBe('POLYGON');
            const report = await integrity.getIntegrityReport();
            expect(report.snapshot.usdcLiabilityTotal).toBe('100');
            expect(report.snapshot.unclassifiedExposure).toBe('0');
            expect(report.status).toBe('EXCEPTION'); // no accepted evidence → not fully backed
            expect(report.journal.balanced).toBe(true);
        });

        // helper: candidate + its credited TransactionHistory row
        async function recordCandidateFlow(user, txHash, usdcAmount) {
            const registry = await prisma.walletAddress.findFirst({ where: { userId: user.id } });
            const row = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: usdcAmount, feeUsdc: 0, txHash, status: 'COMPLETED' },
            });
            const dec = new Prisma.Decimal(usdcAmount).toFixed(6);
            const [int, frac = ''] = dec.split('.');
            const units = BigInt(int + frac.padEnd(6, '0'));
            const { movement } = await prisma.$transaction(async (tx) =>
                accounting.recordDepositCandidate(tx, {
                    walletAddress: registry, txHash, amountBaseUnits: units,
                    transactionHistoryId: row.id, creditedAmountDecimalString: dec,
                }));
            return movement;
        }

    // ── 7. Audit regressions: scoped evidence uniqueness, returned-record binding,
    //       fail-closed composition, exact webhook money, non-double-counting ──
    describe('audit regressions: interaction invariants the isolated tests missed', () => {

        it('balance evidence + TWO verified deposits on one address coexist; exactly one ACTIVE ACCOUNT_BALANCE remains', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const account = await prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));

            // Balance observation FIRST — under the old unscoped unique index
            // this would have permanently blocked every transaction evidence row.
            const bal = await accounting.observeAccountBalance(prisma, { account, provider: stubBalance('250000000', new Date()) });
            expect(bal.recorded).toBe(true);

            // Two separate verified deposits into the SAME custody address.
            const { movement: m1 } = await recordCandidate({ registry, txHash: TX1, units: 100000000n });
            const { movement: m2 } = await recordCandidate({ registry, txHash: TX2, units: 50123456n });
            const p1 = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100' })]);
            const p2 = txProviderWith([rawTxEntry({ hash: TX2, address: CUST.toLowerCase(), amount: '50.123456' })]);
            const r1 = await accounting.verifyDepositMovement(prisma, { movementId: m1.id }, { txProvider: p1 });
            const r2 = await accounting.verifyDepositMovement(prisma, { movementId: m2.id }, { txProvider: p2 });
            expect(r1.verified).toBe(true);
            expect(r2.verified).toBe(true);

            // Both transaction evidence rows exist and are ACTIVE — the
            // single-active rule applies ONLY to ACCOUNT_BALANCE evidence.
            const txEvidence = await prisma.custodyEvidence.findMany({
                where: { custodyAccountId: account.id, scope: 'TRANSACTION', status: 'ACTIVE' },
            });
            expect(txEvidence.length).toBe(2);
            expect(txEvidence.map((e) => e.txHash).sort()).toEqual([TX1, TX2].sort());

            // Exactly ONE accepted balance observation — transaction evidence
            // never occupies or displaces the balance slot.
            const activeBalances = await prisma.custodyEvidence.findMany({
                where: { custodyAccountId: account.id, scope: 'ACCOUNT_BALANCE', status: 'ACTIVE' },
            });
            expect(activeBalances.length).toBe(1);
            expect(activeBalances[0].balanceBaseUnits).toBe(250000000n);

            // getFreshAcceptedEvidence answers with the BALANCE observation —
            // never with a transaction evidence row, no matter what exists.
            const fresh = await accounting.getFreshAcceptedEvidence(prisma, {
                custodyAccountId: account.id, maxAgeMs: 15 * 60 * 1000,
            });
            expect(fresh.id).toBe(activeBalances[0].id);
            expect(fresh.balanceBaseUnits).toBe(250000000n);
            expect(fresh.scope).toBe('ACCOUNT_BALANCE');
        });

        it('a wrong returned CHAIN cannot verify — the request endpoint is not the proof', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            // The provider was asked about polygon-mainnet, but the RETURNED
            // record claims eth-mainnet — a different chain's transfer can
            // never verify this movement.
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), chain: 'eth-mainnet' })]);
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(result.verified).toBe(false);
            expect(result.reason).toContain('CHAIN_MISMATCH');
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('FAILED');
            expect(after.failureReason).toContain('CHAIN_MISMATCH');
            expect(await prisma.custodyEvidence.count({ where: { scope: 'TRANSACTION' } })).toBe(0);
        });

        it('a returned NATIVE-coin transfer (transactionType native) cannot verify a fungible USDC deposit', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            const { movement } = await recordCandidate({ registry, txHash: TX1, units: 100123456n });
            // Same address/amount/block/hash, but the returned entry is a
            // native MATIC transfer, not an ERC-20 fungible transfer.
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), transactionType: 'native' })]);
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(result.verified).toBe(false);
            expect(result.reason).toContain('WRONG_TRANSACTION_TYPE');
            expect(await prisma.custodyMovement.findUnique({ where: { id: movement.id } })).toMatchObject({
                status: 'FAILED', failureReason: expect.stringContaining('WRONG_TRANSACTION_TYPE'),
            });
        });

        it('mixed-case tx hashes verify — normalization on BOTH sides, never case-sensitive luck', async () => {
            const user = await seedUser(prisma);
            const registry = await seedRegistryAddress(user.id);
            // Candidate recorded with the mixed-case hash a webhook may deliver.
            const mixedHash = '0x' + 'AA'.repeat(32); // uppercase
            const { movement } = await recordCandidate({ registry, txHash: mixedHash, units: 100123456n });
            // The provider returns the SAME transaction with the opposite case.
            const provider = txProviderWith([rawTxEntry({ hash: mixedHash.toLowerCase(), address: CUST.toLowerCase(), amount: '100.123456' })]);
            const result = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(result.verified).toBe(true);
            const after = await prisma.custodyMovement.findUnique({ where: { id: movement.id } });
            expect(after.status).toBe('VERIFIED');
            const evidence = await prisma.custodyEvidence.findUnique({ where: { id: after.evidenceId } });
            expect(evidence.txHash.toLowerCase()).toBe(mixedHash.toLowerCase());
        });

        it('negative liability flow (completed debits exceed credits) fails closed — never floored to a valid zero', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await seedRegistryAddress(user.id);
            // Audit's exact scenario: credits = 0, completed USDC withdrawals = 100.
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_CRYPTO', amountUsdc: 100, feeUsdc: 0, txHash: TX1, status: 'COMPLETED' },
            });
            const flows = await accounting.classifyUsdcLiabilityFlows(prisma);
            expect(flows.liabilityClassificationStatus).toBe('NEGATIVE_LIABILITY_FLOW');
            expect(flows.usdcLiabilityTotal).toBe(null); // invalid — not a valid 0
            expect(flows.usdcLiabilityTotalSigned.toString()).toBe('-100'); // diagnostics keep the signed truth

            // Even with HEALTHY fresh evidence and A >= |raw|, the snapshot
            // cannot become COMPLETE or fully backed: the classification itself
            // is untrustworthy and must be exposed as an explicit failure.
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '150000000', [HOT]: '0' }),
            });
            expect(snapshot.liabilityAttestation).toBe('UNATTESTABLE');
            expect(snapshot.isFullyBacked).toBe(false);
            // §P.4 wave-3: the DENOMINATOR is the projection total (user
            // holds 0), never replaced by the invalid flows — and never
            // silently 0-by-invention: the projection itself IS 0 here,
            // and restricted obligations (persisted, §P.4) are modeled.
            expect(snapshot.usdcLiabilityTotal.toString()).toBe('0');
            // The invalid flow classification is still exposed as the
            // explicit reason the attestation is UNATTESTABLE.
            expect(snapshot.breakdown.usdcObligation.classificationStatus).toBe('NEGATIVE_LIABILITY_FLOW');
            expect(snapshot.breakdown.usdcObligation.flowLiabilityTotal).toBe(null); // invalid flows never reach any authority field
            expect(snapshot.breakdown.usdcObligation.components.usdcDebits.toString()).toBe('100'); // signed diagnostics retained
        });

        it('combined lifecycle: balance evidence + multiple verified deposits + PoR — transaction evidence never pollutes the reserve numerator', async () => {
            const { user, registry } = await seedAccountWithRegistry({ address: CUST });
            // Deposit credits journaled in TransactionHistory (X components).
            await recordCandidateFlow(user, TX1, 100);
            await recordCandidateFlow(user, TX2, 40);
            // Webhook credit path credits the balance too — reconcile the
            // mixed pool with the classified flows (mixed == X == 140) so the
            // lifecycle exercises the healthy composition.
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 140 } });
            // Verify BOTH deposit candidates against genuine chain evidence.
            const p1 = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100' })]);
            const p2 = txProviderWith([rawTxEntry({ hash: TX2, address: CUST.toLowerCase(), amount: '40' })]);
            const m1 = await prisma.custodyMovement.findUnique({ where: { idempotencyKey: `deposit:POLYGON:${TX1.toLowerCase()}` } });
            const m2 = await prisma.custodyMovement.findUnique({ where: { idempotencyKey: `deposit:POLYGON:${TX2.toLowerCase()}` } });
            expect((await accounting.verifyDepositMovement(prisma, { movementId: m1.id }, { txProvider: p1 })).verified).toBe(true);
            expect((await accounting.verifyDepositMovement(prisma, { movementId: m2.id }, { txProvider: p2 })).verified).toBe(true);

            // Snapshot with fresh balance observations for both accounts.
            const { snapshot } = await integrity.createSnapshot({
                balanceProvider: stubProviderMap({ [CUST]: '140500000', [HOT]: '10000000' }),
            });
            // X = 140 (two credits, no debits); Y = 140 (both verified).
            expect(snapshot.usdcLiabilityTotal.toString()).toBe('140');
            expect(snapshot.evidenceLinkedLiabilityTotal.toString()).toBe('140');
            expect(snapshot.unclassifiedExposure.toString()).toBe('0');
            expect(snapshot.liabilityAttestation).toBe('COMPLETE');
            // The numerator is EXACTLY the sum of accepted balance evidence
            // (140.5 + 10) — the 140 of transaction evidence adds nothing.
            expect(snapshot.eligibleReserveTotal.toString()).toBe('150.5');
            expect(snapshot.acceptedEvidenceCount).toBe(2);
            // Two TRANSACTION evidence rows + two ACTIVE balance rows coexist.
            expect(await prisma.custodyEvidence.count({ where: { scope: 'TRANSACTION', status: 'ACTIVE' } })).toBe(2);
            expect(await prisma.custodyEvidence.count({ where: { scope: 'ACCOUNT_BALANCE', status: 'ACTIVE' } })).toBe(2);
            // And the whole lifecycle posted ZERO duplicate journal rows.
            expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0);
            // Wave-2: restricted obligations are modeled — with no restricted
            // rows seeded here, nothing blocks the invariant.
            expect(snapshot.breakdown.invariant.blockedBy).toBeNull();
        });

        it('exactWebhookAmountToBaseUnits: beyond safe-integer precision stays exact (raw string → BigInt, no floats)', () => {
            // 90071992547409.93 USDC — the float round-trip Number(x.toFixed(6))
            // corrupts this; exact parsing must not.
            expect(accounting.exactWebhookAmountToBaseUnits('90071992547409.93', 6)).toBe(90071992547409930000n);
            expect(accounting.exactWebhookAmountToBaseUnits('90071992547409.93', 6)).toBe(90071992547409930000n); // stable, not approximate
            // Round-trip through the exact decimal string preserves the quantity.
            expect(accounting.decimalStringFromBaseUnits(90071992547409930000n, 6)).toBe('90071992547409.93');
            // Trailing zeros beyond token precision are the SAME exact quantity.
            expect(accounting.exactWebhookAmountToBaseUnits('1.5000000', 6)).toBe(1500000n);
            // Fail closed: more than 6 significant decimals is not a USDC quantity.
            expect(() => accounting.exactWebhookAmountToBaseUnits('0.0000001', 6)).toThrow(/not exactly representable/);
            // Fail closed: malformed, scientific notation, negative, zero.
            expect(() => accounting.exactWebhookAmountToBaseUnits('1e3', 6)).toThrow();
            expect(() => accounting.exactWebhookAmountToBaseUnits('-5', 6)).toThrow();
            expect(() => accounting.exactWebhookAmountToBaseUnits('0', 6)).toThrow();
            expect(() => accounting.exactWebhookAmountToBaseUnits('', 6)).toThrow();
            expect(() => accounting.exactWebhookAmountToBaseUnits('12.3.4', 6)).toThrow();
        });
    });

    // ── 9. Custody clearing reconciliation read model (§P.4 wave-3) ──────────
    // The ledger must self-describe the custody lifecycle: every webhook
    // credit is PROVISIONAL (unverified clearing) until independent
    // transaction evidence reclassifies it (verified custody) or a
    // definitive rejection quarantines it (rejected suspense). This block
    // proves the reconciliation read model tracks all three states exactly,
    // flags tampering, and never invents clearing for service-direct flows.
    describe('custody clearing reconciliation read model (§P.4 wave-3)', () => {

        // The COMPLETE migrated webhook credit path, exactly as the deposit
        // controller performs it: TransactionHistory row, provisional journal
        // linked to that row, custody candidate, projection credit.
        async function webhookCredit(user, txHash, usdcAmount) {
            const dec = new Prisma.Decimal(usdcAmount).toFixed(6);
            const [int, frac = ''] = dec.split('.');
            const units = BigInt(int + frac.padEnd(6, '0'));
            const registry = await prisma.walletAddress.findFirst({ where: { userId: user.id } });
            return prisma.$transaction(async (tx) => {
                const row = await tx.transactionHistory.create({
                    data: { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: usdcAmount, feeUsdc: 0, txHash, status: 'COMPLETED' },
                });
                const post = await ledger.post(tx, {
                    idempotencyKey: `ledger:deposit:crypto:${txHash}`,
                    entryType: 'CUSTODY_DEPOSIT',
                    description: 'test provisional webhook credit',
                    reference: txHash,
                    userId: user.id, relatedEntity: 'transactionHistory', relatedEntityId: row.id,
                    lines: [
                        { account: 'clearing:custody:unverified:usdc', debit: dec },
                        { account: `user:${user.id}:liability`, credit: dec },
                    ],
                });
                const { movement } = await accounting.recordDepositCandidate(tx, {
                    walletAddress: registry, txHash, amountBaseUnits: units,
                    transactionHistoryId: row.id, creditedAmountDecimalString: dec,
                });
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { increment: dec } } });
                return { row, post, movement };
            });
        }

        it('CANDIDATE with provisional journal: unverified clearing holds the full amount, zero authoritative custody, no exceptions', async () => {
            const { user } = await seedAccountWithRegistry();
            await webhookCredit(user, TX1, 7.5);
            const result = await reconciliation.reconcileCustodyPostings(prisma);
            expect(result.exceptions).toEqual([]);
            expect(result.custody.verifiedWithJournal).toEqual({ count: 0, total: '0.00000000' });
            expect(result.unverified.candidateWithJournal).toEqual({ count: 1, total: '7.50000000' });
            expect(result.rejected.failedWithJournal).toEqual({ count: 0, total: '0.00000000' });
        });

        it('VERIFIED: independent evidence reclassifies into authoritative custody — the read model follows exactly', async () => {
            const { user } = await seedAccountWithRegistry();
            await webhookCredit(user, TX1, 100);
            // Real verification path with deterministic chain evidence.
            const movement = await prisma.custodyMovement.findFirst({ where: { txHash: TX1 } });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '100' })]);
            const r = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(r.verified).toBe(true);
            const result = await reconciliation.reconcileCustodyPostings(prisma);
            expect(result.exceptions).toEqual([]);
            expect(result.custody.verifiedWithJournal).toEqual({ count: 1, total: '100.00000000' });
            expect(result.unverified.candidateWithJournal).toEqual({ count: 0, total: '0.00000000' });
        });

        it('FAILED: definitive rejection quarantines into rejected suspense — never silently dropped', async () => {
            const { user } = await seedAccountWithRegistry();
            await webhookCredit(user, TX1, 50.123456);
            // Evidence disagrees on amount: definitive rejection.
            const movement = await prisma.custodyMovement.findFirst({ where: { txHash: TX1 } });
            const provider = txProviderWith([rawTxEntry({ hash: TX1, address: CUST.toLowerCase(), amount: '12' })]);
            const r = await accounting.verifyDepositMovement(prisma, { movementId: movement.id }, { txProvider: provider });
            expect(r.verified).toBe(false);
            const result = await reconciliation.reconcileCustodyPostings(prisma);
            expect(result.exceptions).toEqual([]);
            expect(result.custody.verifiedWithJournal).toEqual({ count: 0, total: '0.00000000' });
            expect(result.unverified.candidateWithJournal).toEqual({ count: 0, total: '0.00000000' });
            expect(result.rejected.failedWithJournal).toEqual({ count: 1, total: '50.12345600' });
        });

        it('service-direct movements (no provisional journal) are reported withoutJournal — clearing is never invented for them', async () => {
            const { user } = await seedAccountWithRegistry();
            // Service-direct candidate: no webhook credit, no journal.
            await recordCandidateFlow(user, TX1, 30);
            const result = await reconciliation.reconcileCustodyPostings(prisma);
            expect(result.exceptions).toEqual([]);
            expect(result.unverified.candidateWithJournal).toEqual({ count: 0, total: '0.00000000' });
            expect(result.unverified.candidateWithoutJournal).toEqual({ count: 1, total: '30.00000000' });
        });

        it('a tampered custody asset (posting with no movement behind it) is flagged CUSTODY_LEDGER_DISAGREEMENT with the exact signed difference', async () => {
            const { user } = await seedAccountWithRegistry();
            await webhookCredit(user, TX1, 25);
            // Rogue posting: 5 USDC of "custody" with no movement behind it.
            await prisma.$transaction(async (tx) => {
                await ledger.post(tx, {
                    idempotencyKey: 'test:rogue:custody:1',
                    entryType: 'ADJUSTMENT',
                    description: 'rogue custody asset injection (tamper proof)',
                    lines: [
                        { account: 'custody:deposit:usdc', debit: '5' },
                        { account: 'equity:treasury', credit: '5' },
                    ],
                });
            });
            const result = await reconciliation.reconcileCustodyPostings(prisma);
            expect(result.exceptions).toHaveLength(1);
            expect(result.exceptions[0].kind).toBe('CUSTODY_LEDGER_DISAGREEMENT');
            expect(result.exceptions[0].account).toBe('custody:deposit:usdc');
            expect(result.exceptions[0].ledgerBalance).toBe('5.00000000');
            expect(result.exceptions[0].expectedFromCustodyMovements).toBe('0.00000000');
            expect(result.exceptions[0].difference).toBe('-5.00000000'); // signed exact
        });

        it('runFullReconciliation carries the custody clearing result alongside the projection checks', async () => {
            const { user } = await seedAccountWithRegistry();
            await webhookCredit(user, TX1, 10);
            const full = await reconciliation.runFullReconciliation(prisma);
            expect(full.ok).toBe(true);
            expect(full.exceptions).toEqual([]);
            expect(full.detail.custody.unverified.candidateWithJournal).toEqual({ count: 1, total: '10.00000000' });
        });
    });
    });
});
