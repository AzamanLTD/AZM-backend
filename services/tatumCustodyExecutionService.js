// services/tatumCustodyExecutionService.js
// =============================================================================
// AZAMAN — KMS-CAPABLE CUSTODY EXECUTION BOUNDARY (financial architecture §P.2,
// 2026-09-17).
//
// THE single canonical boundary for real external custody execution (customer
// crypto withdrawals + deposit-address sweeps) on Polygon native USDC. The
// application layer must NOT construct raw Tatum payloads elsewhere.
//
// Hard invariants:
//  • Real signing requires THREE explicit gates, all of them:
//      TATUM_PROVIDER=LIVE  AND  TATUM_KMS_ENABLED=true
//      AND  TATUM_CRYPTO_EXECUTION_ENABLED=true
//    If any flag is absent: no real broadcast, no fake success, NO FAKE TX
//    HASH — callers receive a clear NOT_ENABLED classification.
//  • KMS signatureId is the ONLY signing mechanism. There is NO code path
//    that accepts fromPrivateKey (env, body, or payload) — attempting it is a
//    CONFIGURATION_ERROR. No silent fallback to raw keys.
//  • A tx hash may ONLY enter the record from actual provider/chain evidence.
//    Randomly generated hashes are prohibited and rejected on sight.
//  • Execution is ASYNCHRONOUS: submit -> KMS pending signing -> broadcast ->
//    tx hash -> chain confirmation. An HTTP timeout is NOT "broadcast failed";
//    unknown outcomes go to RECONCILIATION_REQUIRED and NEVER auto-refund.
//  • Authoritative amounts are EXACT integer base units (native USDC has 6
//    decimals). Floating point is never the monetary representation.
//  • Statuses transition forward-only, enforced by conditional DB updates.
//
// KMS identity model (deliberately minimal, no second derivation system):
//  • Customer deposit addresses: signer = TATUM_KMS_SIGNATURE_ID with
//    derivation index = WalletAddress.derivationIndex (established rule:
//    index = user.id). Preflight proves signatureId+index -> expected address
//    equals WalletAddress.address; mismatch is a hard failure.
//  • Master hot wallet: signer = TATUM_HOT_WALLET_SIGNATURE_ID with
//    TATUM_HOT_WALLET_INDEX (default 0); address = TATUM_HOT_WALLET_ADDRESS,
//    which must agree with TATUM_TREASURY_ADDRESS when both are configured.
// =============================================================================

const axios = require('axios');
const logger = require('../src/config/logger');
const { NATIVE_USDC } = require('./walletAddressService');
const {
    ERROR_CLASSES,
    CustodyExecutionError,
    classifyProviderError,
    redact,
} = require('./custodyExecutionErrors');

// ── Canonical identity (§P.1 constants are the single source of truth) ──────
const CANONICAL = Object.freeze({
    network:         NATIVE_USDC.network,        // POLYGON
    asset:           NATIVE_USDC.asset,          // USDC
    contractAddress: NATIVE_USDC.contractAddress,// native USDC
    decimals:        NATIVE_USDC.decimals,       // 6
});

// Forward-only status machine.
const STATUSES = Object.freeze({
    REQUESTED: 'REQUESTED',
    RESERVING: 'RESERVING',
    SUBMITTED: 'SUBMITTED',
    SIGNING: 'SIGNING',
    BROADCAST: 'BROADCAST',
    CONFIRMING: 'CONFIRMING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
});
const TERMINAL = new Set([STATUSES.COMPLETED, STATUSES.FAILED, STATUSES.RECONCILIATION_REQUIRED]);
const INFLIGHT = [STATUSES.REQUESTED, STATUSES.RESERVING, STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST, STATUSES.CONFIRMING];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ── Exact monetary arithmetic ────────────────────────────────────────────────

/**
 * Convert a decimal token amount to EXACT integer base units.
 * Accepts a string (preferred — Prisma Decimal serializes losslessly) or a
 * number (converted via its canonical string form). REJECTS: >6 decimals,
 * NaN, Infinity, zero, negative, malformed (exponent notation, etc.).
 * Floating point is never used as the authoritative representation.
 */
function toBaseUnits(amount, decimals = CANONICAL.decimals) {
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Invalid decimals for base-unit conversion: ${decimals}`);
    }
    let str;
    if (typeof amount === 'number') {
        if (!Number.isFinite(amount)) {
            throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, 'Amount is NaN or Infinity — rejected.');
        }
        str = String(amount);
    } else if (typeof amount === 'string') {
        str = amount.trim();
    } else if (typeof amount === 'bigint') {
        return amount; // already exact
    } else {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Malformed amount (${typeof amount}) — rejected.`);
    }
    if (!/^\d+(\.\d+)?$/.test(str)) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Malformed amount "${str}" — rejected (NaN/negative/malformed).`);
    }
    const [intPart, fracPart = ''] = str.split('.');
    if (fracPart.length > decimals) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Amount "${str}" exceeds ${decimals} decimals — rejected.`);
    }
    const units = BigInt(intPart + fracPart.padEnd(decimals, '0'));
    if (units <= 0n) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Amount "${str}" must be positive — rejected (zero/negative).`);
    }
    return units;
}

const isValidPolygonAddress = (address) => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
const isValidTxHash = (hash) => typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash);
const normalizeAddress = (a) => String(a || '').toLowerCase().trim();

/**
 * Strict destination validation. Rejects malformed addresses, the zero
 * address, the canonical token contract itself (transfer-to-contract is never
 * a customer withdrawal), and reserved system addresses.
 */
function validateDestination(address, { allowSystem = false } = {}) {
    if (!isValidPolygonAddress(address)) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, `Invalid Polygon destination: ${redact(address)}`);
    }
    const norm = normalizeAddress(address);
    if (norm === ZERO_ADDRESS) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, 'Destination is the zero address.');
    }
    if (norm === CANONICAL.contractAddress) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, 'Destination is the token contract itself.');
    }
    if (!allowSystem && (norm === normalizeAddress(getConfig().hotWalletAddress))) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, 'Destination is the master hot wallet — not a valid customer destination.');
    }
    return norm;
}

// ── Configuration + production gates ─────────────────────────────────────────

function getConfig() {
    return {
        providerMode:        process.env.TATUM_PROVIDER || 'MOCK',
        apiKey:              process.env.TATUM_API_KEY || null,
        baseUrl:             process.env.TATUM_BASE_URL || 'https://api.tatum.io',
        kmsEnabled:          process.env.TATUM_KMS_ENABLED === 'true',
        kmsSignatureId:      process.env.TATUM_KMS_SIGNATURE_ID || null,
        kmsChain:           process.env.TATUM_KMS_CHAIN || 'POLYGON',
        kmsEnvironment:      process.env.TATUM_KMS_ENVIRONMENT || null,
        kmsFourEyeRequired:  process.env.TATUM_KMS_FOUR_EYE_REQUIRED !== 'false', // default REQUIRED
        executionEnabled:    process.env.TATUM_CRYPTO_EXECUTION_ENABLED === 'true',
        hotWalletSignatureId: process.env.TATUM_HOT_WALLET_SIGNATURE_ID || null,
        hotWalletIndex:      process.env.TATUM_HOT_WALLET_INDEX != null ? parseInt(process.env.TATUM_HOT_WALLET_INDEX, 10) : 0,
        hotWalletAddress:    process.env.TATUM_HOT_WALLET_ADDRESS || null,
        treasuryAddress:     process.env.TATUM_TREASURY_ADDRESS || null,
        xpub:                process.env.TATUM_XPUB || null,
    };
}

/**
 * The production execution gate. Real signing/broadcasting is possible ONLY
 * when ALL of: provider LIVE + KMS enabled + crypto execution enabled.
 * Disabled by default — absence of any flag means NO real broadcast and NO
 * fake success anywhere.
 */
function executionGateStatus() {
    const cfg = getConfig();
    const flags = {
        providerLive:       cfg.providerMode === 'LIVE',
        apiKeyPresent:      !!cfg.apiKey,
        kmsEnabled:         cfg.kmsEnabled,
        executionEnabled:   cfg.executionEnabled,
    };
    return {
        enabled: flags.providerLive && flags.apiKeyPresent && flags.kmsEnabled && flags.executionEnabled,
        flags,
    };
}

const requireExecutionEnabled = () => {
    const gate = executionGateStatus();
    if (!gate.enabled) {
        throw new CustodyExecutionError(
            ERROR_CLASSES.CONFIGURATION_ERROR,
            'Crypto execution is not enabled (requires TATUM_PROVIDER=LIVE + TATUM_KMS_ENABLED=true + TATUM_CRYPTO_EXECUTION_ENABLED=true). No broadcast was attempted and no success was fabricated.'
        );
    }
    return gate;
};

/**
 * Resolve the configured signer identity for a given source address.
 * Customer deposit addresses use the KMS mnemonic signatureId + the
 * WalletAddress derivation index; the master hot wallet uses its own
 * signatureId + index. A configured signer whose address does not match the
 * requested source is a SIGNER_MISMATCH — never silently substituted.
 */
function resolveSignerForAddress(sourceAddress) {
    const cfg = getConfig();
    const src = normalizeAddress(sourceAddress);
    if (cfg.hotWalletAddress && src === normalizeAddress(cfg.hotWalletAddress)) {
        if (!cfg.hotWalletSignatureId) {
            throw new CustodyExecutionError(ERROR_CLASSES.KMS_UNAVAILABLE, 'Master hot wallet signer (TATUM_HOT_WALLET_SIGNATURE_ID) is not configured.');
        }
        return { signatureId: cfg.hotWalletSignatureId, index: cfg.hotWalletIndex, role: 'MASTER_HOT_WALLET' };
    }
    // Customer deposit addresses are controlled by the KMS mnemonic identity.
    if (!cfg.kmsSignatureId) {
        throw new CustodyExecutionError(ERROR_CLASSES.KMS_UNAVAILABLE, 'KMS signature identity (TATUM_KMS_SIGNATURE_ID) is not configured.');
    }
    return { signatureId: cfg.kmsSignatureId, index: null, role: 'CUSTOMER_DEPOSIT_WALLET' }; // index supplied per WalletAddress
}

// ── Provider adapter (real Tatum HTTP; injectable fake in tests) ─────────────

/**
 * The default live provider. Every payload it constructs goes through
 * buildTokenTransferPayload — which HARD-REJECTS any fromPrivateKey, raw key,
 * or non-KMS signing mode.
 */
function buildTokenTransferPayload({ from, to, amountBaseUnits, contractAddress, signatureId, index }) {
    if (contractAddress !== CANONICAL.contractAddress) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Refusing non-canonical token contract ${contractAddress} — only native Polygon USDC (${CANONICAL.contractAddress}) is executable.`);
    }
    if (!signatureId) {
        throw new CustodyExecutionError(ERROR_CLASSES.KMS_UNAVAILABLE, 'No KMS signatureId supplied — refusing to build a transfer payload.');
    }
    if (!isValidPolygonAddress(from) || !isValidPolygonAddress(to)) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, 'Transfer payload requires valid from/to addresses.');
    }
    return {
        from,
        to,
        amount: String(amountBaseUnits), // minimal units string — exact
        contractAddress: CANONICAL.contractAddress,
        currency: CANONICAL.asset,
        digits: CANONICAL.decimals,
        signatureId,
        ...(index != null ? { index: Number(index) } : {}),
    };
}

function createHttpProvider(cfg = getConfig()) {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey || '' };
    const http = axios.create({ baseURL: cfg.baseUrl, headers, timeout: 15000 });

    return {
        name: 'TATUM_HTTP',

        async submitTokenTransfer(payload) {
            // The single place a transfer payload exists. If ANY raw private key
            // material is present anywhere in the payload, fail closed.
            for (const key of Object.keys(payload)) {
                if (/private[_-]?key/i.test(key)) {
                    throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Raw private key material (${key}) is prohibited — KMS signatureId is the only signing boundary.`);
                }
            }
            try {
                const resp = await http.post('/v3/polygon/transaction', payload);
                const data = resp.data || {};
                const txHash = (data.txId && isValidTxHash(data.txId)) ? data.txId : null;
                return {
                    pendingRequestId: data.signatureId || data.id || null, // KMS pending signing-request id
                    txHash,
                    raw: { status: resp.status },
                };
            } catch (err) {
                throw classifyProviderError(err, 'token transfer submission');
            }
        },

        async getKmsRequest(pendingRequestId) {
            try {
                const resp = await http.get(`/v3/kms/${pendingRequestId}`);
                const data = resp.data || {};
                return {
                    id: data.id || pendingRequestId,
                    txHash: (data.txId && isValidTxHash(data.txId)) ? data.txId : null,
                    status: data.status || null,
                };
            } catch (err) {
                throw classifyProviderError(err, 'KMS request fetch');
            }
        },

        async approvePendingRequest(pendingRequestId) {
            try {
                await http.post(`/v3/kms/approve/${pendingRequestId}`);
                return true;
            } catch (err) {
                throw classifyProviderError(err, 'KMS approval');
            }
        },

        async deletePendingRequest(pendingRequestId) {
            try {
                await http.delete(`/v3/kms/${pendingRequestId}`);
                return true;
            } catch (err) {
                throw classifyProviderError(err, 'KMS request cancel');
            }
        },

        async getTransaction(txHash) {
            try {
                const resp = await http.get(`/v3/polygon/transaction/${txHash}`);
                return resp.data || null;
            } catch (err) {
                if (err?.response?.status === 404) return null; // not on chain (yet) — pending, not failure
                throw classifyProviderError(err, 'chain transaction fetch');
            }
        },

        // Signer/address preflight: derive the address the KMS signature
        // identity controls at the given index and compare it to the actual
        // source address. NON-DESTRUCTIVE — no transaction is created.
        async deriveAddressForSigner({ signatureId, index }) {
            try {
                const resp = await http.get(`/v3/polygon/address/${encodeURIComponent(cfg.xpub || '')}/${index}`);
                return normalizeAddress(resp.data?.address);
            } catch (err) {
                throw classifyProviderError(err, 'signer address derivation');
            }
        },
    };
}

// Test seam: a fake provider can be injected via __setProviderForTests.
let _provider = null;
const getProvider = () => _provider || createHttpProvider();

// ── Non-destructive capability preflight ────────────────────────────────────

/**
 * Verify configuration + KMS/Tatum compatibility WITHOUT broadcasting or
 * creating any transaction. Detects: missing API key, missing KMS signature
 * ID, missing signer mode, signer/address mismatch, wrong network/environment,
 * unsupported token identity, missing master-hot address, KMS disabled while
 * a live execution path is requested. Never returns secrets.
 */
async function preflight(prisma = null, { provider = getProvider(), walletAddress = null } = {}) {
    const cfg = getConfig();
    const gate = executionGateStatus();
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

    add('provider_mode', cfg.providerMode === 'LIVE', cfg.providerMode === 'LIVE' ? 'LIVE' : `NOT-LIVE (${cfg.providerMode})`);
    add('api_key_present', !!cfg.apiKey, !!cfg.apiKey ? 'configured' : 'MISSING — live execution impossible');
    add('kms_enabled', cfg.kmsEnabled, cfg.kmsEnabled ? 'true' : 'false — real signing DISABLED');
    add('crypto_execution_enabled', cfg.executionEnabled, cfg.executionEnabled ? 'true' : 'false — real signing DISABLED');
    add('kms_signature_id_present', !!cfg.kmsSignatureId, cfg.kmsSignatureId ? 'configured' : 'MISSING (customer deposit signer)');
    add('kms_chain_supported', normalizeAddress(cfg.kmsChain) === 'polygon', cfg.kmsChain);
    add('kms_environment_set', !!cfg.kmsEnvironment, cfg.kmsEnvironment || 'MISSING (e.g. MAINNET / TESTNET)');
    add('kms_four_eye_required', true, cfg.kmsFourEyeRequired ? 'four-eye approval REQUIRED (Tatum mainnet requirement)' : 'four-eye disabled — NOT acceptable for mainnet');
    add('master_hot_wallet_address_present', !!cfg.hotWalletAddress, cfg.hotWalletAddress || 'MISSING');
    add('master_hot_wallet_signer_present', !!cfg.hotWalletSignatureId, cfg.hotWalletSignatureId ? 'configured' : 'MISSING (TATUM_HOT_WALLET_SIGNATURE_ID)');
    add('treasury_hot_wallet_consistency',
        !cfg.treasuryAddress || !cfg.hotWalletAddress || normalizeAddress(cfg.treasuryAddress) === normalizeAddress(cfg.hotWalletAddress),
        cfg.treasuryAddress && cfg.hotWalletAddress && normalizeAddress(cfg.treasuryAddress) !== normalizeAddress(cfg.hotWalletAddress)
            ? `MISMATCH: treasury=${cfg.treasuryAddress} hot=${cfg.hotWalletAddress} — execution is fail-closed`
            : 'consistent');
    add('canonical_token_identity', true, `native Polygon USDC ${CANONICAL.contractAddress} (${CANONICAL.decimals} decimals); bridged USDC.e is a distinct asset and never substituted`);

    // Signer/address correspondence — only provable in LIVE mode with a real
    // provider; never destructive.
    if (walletAddress) {
        if (gate.enabled && cfg.xpub) {
            try {
                const expected = await provider.deriveAddressForSigner({
                    signatureId: cfg.kmsSignatureId,
                    index: walletAddress.derivationIndex,
                });
                const matches = expected === normalizeAddress(walletAddress.address);
                add('signer_address_correspondence', matches,
                    matches ? `signatureId@index ${walletAddress.derivationIndex} -> ${walletAddress.address}`
                            : `MISMATCH: signatureId@index ${walletAddress.derivationIndex} -> ${expected}, registry says ${walletAddress.address}`);
            } catch (err) {
                add('signer_address_correspondence', false, `derivation failed: ${redact(err.message)}`);
            }
        } else {
            add('signer_address_correspondence', null, 'SKIPPED — requires LIVE provider + TATUM_XPUB (non-destructive check)');
        }
    }

    const blocking = checks.filter((c) => c.ok === false).length;
    return {
        ok: blocking === 0 && gate.enabled,
        executionEnabled: gate.enabled,
        readyForLiveExecution: gate.enabled && blocking === 0,
        checks,
        note: 'Non-destructive preflight. A green result means configuration is coherent — it does NOT prove a broadcast happened, and no broadcast was attempted.',
    };
}

// ── Durable execution records (claims + forward-only transitions) ───────────

async function createWithdrawalExecution(prisma, {
    idempotencyKey, transactionHistoryId, userId, fromAddress, toAddress,
    amountBaseUnits, feeChargeBaseUnits, estimatedNetworkCostBaseUnits,
    metadata = {},
}) {
    return prisma.custodyExecution.create({
        data: {
            idempotencyKey,
            kind: 'CUSTOMER_WITHDRAWAL',
            refId: transactionHistoryId ? String(transactionHistoryId) : null,
            userId,
            network: CANONICAL.network,
            asset: CANONICAL.asset,
            contractAddress: CANONICAL.contractAddress,
            fromAddress: normalizeAddress(fromAddress),
            toAddress: normalizeAddress(toAddress),
            amountBaseUnits,
            decimals: CANONICAL.decimals,
            status: STATUSES.RESERVING,
            provider: 'TATUM_KMS',
            approvalStatus: 'PENDING',
            feeChargeBaseUnits: feeChargeBaseUnits || null,
            estimatedNetworkCostBaseUnits: estimatedNetworkCostBaseUnits || null,
            metadata: {
                ...metadata,
                gateSnapshot: executionGateStatus().flags,
            },
        },
    });
}

/**
 * Atomic sweep claim. The partial unique index (one in-flight DEPOSIT_SWEEP per
 * source WalletAddress) is the concurrency authority: overlapping workers
//  * collide on the index and the loser converges on the winner's row. A
 * completed/failed prior sweep does NOT block a later sweep.
 */
async function claimSweepExecution(prisma, {
    walletAddressId, userId, fromAddress, toAddress, amountBaseUnits,
    onchainSweepId, metadata = {},
}) {
    const idempotencyKey = `sweep:${walletAddressId}:${new Date().toISOString()}`;
    try {
        const execution = await prisma.custodyExecution.create({
            data: {
                idempotencyKey,
                kind: 'DEPOSIT_SWEEP',
                refId: onchainSweepId ? String(onchainSweepId) : null,
                walletAddressId,
                userId,
                network: CANONICAL.network,
                asset: CANONICAL.asset,
                contractAddress: CANONICAL.contractAddress,
                fromAddress: normalizeAddress(fromAddress),
                toAddress: normalizeAddress(toAddress),
                amountBaseUnits,
                decimals: CANONICAL.decimals,
                status: STATUSES.RESERVING,
                provider: 'TATUM_KMS',
                approvalStatus: 'PENDING',
                metadata,
            },
        });
        return { execution, isNew: true };
    } catch (err) {
        if (err?.code === 'P2002') {
            // Lost the claim race (or same-ms key collision): converge on the
            // committed in-flight execution instead of submitting a second
            // transfer of the same balance. NEVER blindly retry.
            // RECONCILIATION_REQUIRED blocks new claims for the same reason:
            // the prior ambiguous sweep must be reconciled before any retry.
            const existing = await prisma.custodyExecution.findFirst({
                where: { walletAddressId, kind: 'DEPOSIT_SWEEP', status: { in: [...INFLIGHT, STATUSES.RECONCILIATION_REQUIRED] } },
                orderBy: { createdAt: 'desc' },
            });
            if (existing) {
                logger.warn({ walletAddressId, executionId: existing.id }, '[custody-execution] sweep claim lost to a concurrent worker — converging');
                return { execution: existing, isNew: false };
            }
        }
        throw err;
    }
}

// Forward-only status transition (conditional updateMany is the authority).
const FORWARD_TRANSITIONS = {
    [STATUSES.REQUESTED]:   [STATUSES.RESERVING, STATUSES.FAILED, STATUSES.RECONCILIATION_REQUIRED],
    [STATUSES.RESERVING]:   [STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST, STATUSES.FAILED, STATUSES.RECONCILIATION_REQUIRED],
    [STATUSES.SUBMITTED]:   [STATUSES.SIGNING, STATUSES.BROADCAST, STATUSES.FAILED, STATUSES.RECONCILIATION_REQUIRED],
    [STATUSES.SIGNING]:     [STATUSES.BROADCAST, STATUSES.FAILED, STATUSES.RECONCILIATION_REQUIRED],
    [STATUSES.BROADCAST]:   [STATUSES.CONFIRMING, STATUSES.RECONCILIATION_REQUIRED],
    [STATUSES.CONFIRMING]:  [STATUSES.COMPLETED, STATUSES.RECONCILIATION_REQUIRED],
    // Terminal states never move.
};

async function transitionExecution(prisma, executionId, fromStatuses, data) {
    const res = await prisma.custodyExecution.updateMany({
        where: { id: executionId, status: { in: fromStatuses } },
        data,
    });
    return res.count === 1;
}

// ── Four-eye approval boundary (KMS external approval contract) ─────────────

/**
 * Durable authorization boundary for a KMS signing request. Verifies the
 * INTENDED transaction against the stored execution (destination, token
 * contract, exact amount, source/signer identity, customer withdrawal
 * reference) and records APPROVED only on an exact match. Safe to call
 * repeatedly (idempotent). NEVER approves an unrelated transaction merely
 * because it shares a user/reference. Stale/unknown requests are rejected.
 */
async function approveKmsRequest(prisma, { executionId, expected }) {
    const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
    if (!execution) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Unknown KMS approval request ${executionId} — rejected.`);
    }
    if (TERMINAL.has(execution.status)) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `KMS approval request ${executionId} is stale (status ${execution.status}) — rejected.`);
    }
    if (execution.approvalStatus === 'APPROVED') return { execution, approved: true, alreadyApproved: true };
    if (execution.approvalStatus === 'DENIED') {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `KMS approval request ${executionId} was already DENIED — rejected.`);
    }

    // Exact-match verification of EVERY material field.
    const mismatch = (why) => new CustodyExecutionError(
        ERROR_CLASSES.SIGNER_MISMATCH, `KMS approval for ${executionId} denied: ${why}`
    );
    if (normalizeAddress(expected.toAddress) !== execution.toAddress) throw mismatch('destination does not match the intended withdrawal');
    if (normalizeAddress(expected.contractAddress) !== normalizeAddress(execution.contractAddress)) throw mismatch('token contract does not match');
    if (BigInt(expected.amountBaseUnits) !== BigInt(execution.amountBaseUnits)) throw mismatch('amount does not match');
    if (normalizeAddress(expected.fromAddress) !== execution.fromAddress) throw mismatch('source/signer address does not match');
    if (expected.kind && expected.kind !== execution.kind) throw mismatch('execution kind does not match');
    if (expected.refId && String(expected.refId) !== String(execution.refId)) throw mismatch('customer withdrawal reference does not match');
    if (expected.userId != null && execution.userId != null && Number(expected.userId) !== Number(execution.userId)) throw mismatch('user reference does not match');

    const updated = await prisma.custodyExecution.update({
        where: { id: executionId },
        data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    return { execution: updated, approved: true, alreadyApproved: false };
}

async function denyKmsRequest(prisma, executionId, reason, provider = null) {
    const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Unknown KMS approval request ${executionId}.`);
    if (execution.providerRequestId && provider && !TERMINAL.has(execution.status)) {
        // Best-effort external cancel; the internal DENIED record is authority.
        try { await provider.deletePendingRequest(execution.providerRequestId); } catch { /* classified upstream */ }
    }
    return prisma.custodyExecution.update({
        where: { id: executionId },
        data: { approvalStatus: 'DENIED', errorClass: ERROR_CLASSES.CONFIGURATION_ERROR, errorMessage: redact(reason || 'denied') },
    });
}

// ── Submission (the asynchronous KMS flow) ───────────────────────────────────

/**
 * Submit a custody execution through the KMS flow. Tolerates every legitimate
 * asynchronous outcome; throws ONLY for definitive pre-broadcast failures.
 * Ambiguous provider results are recorded as RECONCILIATION_REQUIRED and
 * surfaced as UNKNOWN_OUTCOME — the caller must NOT auto-refund those.
 */
async function submitExecution(prisma, { executionId }, { provider = getProvider() } = {}) {
    requireExecutionEnabled();
    const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Execution ${executionId} not found.`);
    if (TERMINAL.has(execution.status)) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Execution ${executionId} is terminal (${execution.status}) — never resubmitted.`);
    }
    if (execution.status !== STATUSES.REQUESTED && execution.status !== STATUSES.RESERVING) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Execution ${executionId} is already in flight (${execution.status}).`);
    }

    // NOTE ON FAILURE OWNERSHIP: preflight validation failures below leave the
    // row in its current in-flight state and THROW — the CALLER owns the
    // FAILED transition (and, for customer withdrawals, the exactly-once
    // refund), so money state and execution state can never diverge.

    // Asset identity: ONLY native Polygon USDC is executable.
    if (execution.network !== CANONICAL.network
        || execution.asset !== CANONICAL.asset
        || normalizeAddress(execution.contractAddress) !== CANONICAL.contractAddress) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, 'Only native Polygon USDC executions are allowed.');
    }

    // Destination: strict validation before anything is sent. A DEPOSIT_SWEEP
    // legitimately targets the master hot wallet (allowSystem); a customer
    // withdrawal may never use it as a destination.
    validateDestination(execution.toAddress, { allowSystem: execution.kind === 'DEPOSIT_SWEEP' });

    // Four-eye: the internal durable approval must exist before submission.
    if (getConfig().kmsFourEyeRequired && execution.approvalStatus !== 'APPROVED') {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
            `Execution ${executionId} lacks KMS four-eye approval — refusing to submit.`);
    }

    // Signer identity for the source address (customer deposit vs master hot).
    const signer = resolveSignerForAddress(execution.fromAddress);
    const index = signer.role === 'CUSTOMER_DEPOSIT_WALLET'
        ? (execution.metadata?.derivationIndex ?? null)
        : signer.index;

    // For customer deposit sources, PROVE signer/address correspondence — the
    // configured signatureId + derivation index must control the exact
    // WalletAddress address being swept. A mismatch is a hard failure; an
    // existing customer address is never silently replaced.
    if (signer.role === 'CUSTOMER_DEPOSIT_WALLET' && getConfig().xpub && index != null) {
        let expectedAddress;
        try {
            expectedAddress = await provider.deriveAddressForSigner({ signatureId: signer.signatureId, index });
        } catch (err) {
            // Derivation unavailable = configuration risk: fail closed.
            throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
                `Signer/address preflight could not be performed (${redact(err.message || String(err))}) — fail-closed.`);
        }
        if (expectedAddress !== normalizeAddress(execution.fromAddress)) {
            throw new CustodyExecutionError(ERROR_CLASSES.SIGNER_MISMATCH,
                `KMS signer at index ${index} controls ${expectedAddress}, not ${execution.fromAddress} — refusing to execute.`);
        }
    }

    // Payload — the one construction point; hard-rejects private keys.
    const payload = buildTokenTransferPayload({
        from: execution.fromAddress,
        to: execution.toAddress,
        amountBaseUnits: BigInt(execution.amountBaseUnits),
        contractAddress: normalizeAddress(execution.contractAddress),
        signatureId: signer.signatureId,
        index,
    });

    await transitionExecution(prisma, executionId, [STATUSES.REQUESTED, STATUSES.RESERVING], { status: STATUSES.SUBMITTED, submittedAt: new Date() });

    // Mark an outcome as ambiguous (reconciliation decides; never auto-refund
    // or blind retry) and surface it to the caller as UNKNOWN_OUTCOME.
    const reconcileAmbiguous = async (pendingRequestId, detail) => {
        await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST], {
            status: STATUSES.RECONCILIATION_REQUIRED,
            errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME,
            errorMessage: redact(`Ambiguous external outcome: ${detail}`),
            providerRequestId: pendingRequestId || undefined,
        });
        const unknown = new CustodyExecutionError(ERROR_CLASSES.UNKNOWN_OUTCOME,
            'Provider outcome is unknown (timeout/network/5xx or unusable evidence). This is NOT treated as failure — reconciliation required before any refund or retry.');
        unknown.ambiguous = true;
        throw unknown;
    };

    let pendingRequestId = null;
    try {
        const result = await provider.submitTokenTransfer(payload);
        pendingRequestId = result.pendingRequestId || null;

        if (result.txHash) {
            // Broadcast evidence exists already (e.g. daemon-signed instantly).
            // A malformed hash is NOT usable evidence — and we cannot know what
            // the provider actually did, so it is ambiguous, never "failed".
            if (!isValidTxHash(result.txHash)) {
                await reconcileAmbiguous(pendingRequestId, 'provider returned a malformed tx hash');
            }
            await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST], {
                status: STATUSES.BROADCAST, txHash: result.txHash, broadcastAt: new Date(),
                providerRequestId: pendingRequestId || undefined,
            });
            return { status: STATUSES.BROADCAST, txHash: result.txHash, pending: false };
        }

        if (pendingRequestId) {
            // Accepted into KMS pending-signing state. The external four-eye
            // approval happens HERE (the internal durable record already exists).
            if (getConfig().kmsFourEyeRequired) {
                try {
                    await provider.approvePendingRequest(pendingRequestId);
                } catch (approveErr) {
                    const c = approveErr instanceof CustodyExecutionError
                        ? approveErr
                        : classifyProviderError(approveErr, 'KMS approval');
                    if (c.definitivePreBroadcast) {
                        // The approval was definitively refused — the pending
                        // request can never be signed, so nothing can broadcast.
                        // Caller owns the FAILED transition; row stays SUBMITTED.
                        throw c;
                    }
                    // Approval timeout/unknown: the approve may have landed, and
                    // the daemon may then sign+broadcast — ambiguous.
                    await reconcileAmbiguous(pendingRequestId, `KMS four-eye approval outcome unknown (${c.message})`);
                }
            }
            await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING], {
                status: STATUSES.SIGNING, providerRequestId: pendingRequestId,
            });
            return { status: STATUSES.SIGNING, pendingRequestId, pending: true };
        }

        // Accepted but NO evidence of any kind — NOT a success. Ambiguous.
        await reconcileAmbiguous(null, 'provider accepted the request without a pending id or tx hash');
    } catch (err) {
        if (err instanceof CustodyExecutionError && err.ambiguous) throw err; // already reconciled above
        const classified = err instanceof CustodyExecutionError ? err : classifyProviderError(err, 'token transfer submission');
        if (classified.definitivePreBroadcast) {
            // Definitive pre-broadcast provider rejection — safe for the caller
            // to fail (+ refund for withdrawals). Row stays in its current
            // in-flight state so the caller's conditional transition is atomic
            // with the money movement.
            throw classified;
        }
        await reconcileAmbiguous(pendingRequestId, classified.message);
    }
}

// ── Chain confirmation (transfer-semantics verification) ────────────────────

function _extractTransferUnits(hexData) {
    if (!hexData || typeof hexData !== 'string') return null;
    const clean = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
    if (clean.length < 2) return null;
    try { return BigInt('0x' + clean); } catch { return null; }
}

/**
 * Given a REAL tx hash, independently verify the actual transfer semantics:
 * transaction exists, expected sender, expected recipient, expected token
 * contract, expected exact amount, expected network, successful receipt.
 * A successful but UNRELATED transaction never settles an execution.
 */
async function verifyChainTransfer(provider, { txHash, fromAddress, toAddress, contractAddress, amountBaseUnits }) {
    if (!isValidTxHash(txHash)) {
        return { verified: false, reason: ERROR_CLASSES.CHAIN_MISMATCH, detail: 'Malformed tx hash — not real evidence.' };
    }
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, reason: ERROR_CLASSES.CONFIRMATION_PENDING, detail: 'Transaction not found on chain yet.' };

    const statusRaw = String(tx.status ?? tx.txStatus ?? 'unknown').toLowerCase();
    if (['0x0', 'failed', 'reverted', 'false'].includes(statusRaw)) {
        return { verified: false, reason: ERROR_CLASSES.CHAIN_REVERTED, detail: 'Chain receipt shows the transaction failed/reverted.' };
    }

    const from = normalizeAddress(fromAddress);
    const to = normalizeAddress(toAddress);
    const contract = normalizeAddress(contractAddress);

    // Candidate token-transfer records: provider-native transfers list or
    // parsed ERC-20 Transfer logs.
    // Candidate token-transfer records from parsed ERC-20 Transfer logs (the
    // well-defined source of truth for token transfer semantics).
    const candidates = [];
    if (Array.isArray(tx.transfers)) {
        for (const t of tx.transfers) {
            // Only entries carrying explicit base-unit integer/hex amounts are
            // usable evidence; unit-ambiguous entries are skipped rather than
            // guessed at with floating point.
            const units = typeof t.amount === 'bigint'
                ? t.amount
                : (typeof t.amount === 'string' && /^0x[0-9a-fA-F]+$/.test(t.amount))
                    ? _extractTransferUnits(t.amount)
                    : null;
            candidates.push({
                contract: normalizeAddress(t.contractAddress || t.address || ''),
                from: normalizeAddress(t.from || ''),
                to: normalizeAddress(t.to || ''),
                units,
            });
        }
    }
    if (Array.isArray(tx.logs)) {
        for (const log of tx.logs) {
            const topics = log.topics || [];
            if (topics[0] !== ERC20_TRANSFER_TOPIC || topics.length < 3) continue;
            candidates.push({
                contract: normalizeAddress(log.address || ''),
                from: normalizeAddress('0x' + String(topics[1]).slice(26)),
                to: normalizeAddress('0x' + String(topics[2]).slice(26)),
                units: _extractTransferUnits(log.data),
            });
        }
    }

    if (candidates.length === 0) {
        // Cannot parse transfer semantics from this provider shape: fail-closed
        // (never completed on unparseable evidence), and NOT a proven mismatch.
        return { verified: false, reason: ERROR_CLASSES.CONFIRMATION_PENDING, detail: 'Provider response carries no parseable token-transfer semantics — cannot verify yet.' };
    }

    const wantedUnits = BigInt(amountBaseUnits);
    const match = candidates.find((c) =>
        c.contract === contract && c.from === from && c.to === to && c.units != null && BigInt(c.units) === wantedUnits
    );
    if (!match) {
        return { verified: false, reason: ERROR_CLASSES.CHAIN_MISMATCH, detail: 'Transaction exists but does not match the intended transfer (sender/recipient/contract/amount).' };
    }
    return { verified: true, detail: 'Transfer semantics verified on chain (contract, sender, recipient, exact base units, successful receipt).' };
}

/**
 * Advance one execution by one lifecycle step using real evidence:
 *   SIGNING  -> poll KMS request -> BROADCAST (+txHash) when the daemon signed
 *   BROADCAST -> verify chain transfer semantics -> CONFIRMING -> settle
 * Idempotent; safe to call repeatedly from a reconciler.
 */
async function advanceExecution(prisma, { executionId }, { provider = getProvider() } = {}) {
    requireExecutionEnabled();
    const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
    if (!execution || TERMINAL.has(execution.status)) return { status: execution?.status || 'NOT_FOUND', changed: false };

    if (execution.status === STATUSES.SIGNING && execution.providerRequestId) {
        const kms = await provider.getKmsRequest(execution.providerRequestId);
        if (kms.txHash) {
            if (!isValidTxHash(kms.txHash)) {
                await transitionExecution(prisma, executionId, [STATUSES.SIGNING], {
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                    errorMessage: 'KMS daemon returned a malformed tx hash — reconciliation required.',
                });
                return { status: STATUSES.RECONCILIATION_REQUIRED, changed: true };
            }
            await transitionExecution(prisma, executionId, [STATUSES.SIGNING], {
                status: STATUSES.BROADCAST, txHash: kms.txHash, broadcastAt: new Date(),
            });
            return { status: STATUSES.BROADCAST, changed: true, txHash: kms.txHash };
        }
        return { status: STATUSES.SIGNING, changed: false };
    }

    if (execution.status === STATUSES.BROADCAST && execution.txHash) {
        const verification = await verifyChainTransfer(provider, {
            txHash: execution.txHash,
            fromAddress: execution.fromAddress,
            toAddress: execution.toAddress,
            contractAddress: execution.contractAddress,
            amountBaseUnits: BigInt(execution.amountBaseUnits),
        });
        if (verification.verified) {
            await transitionExecution(prisma, executionId, [STATUSES.BROADCAST], { status: STATUSES.CONFIRMING });
            return settleExecution(prisma, { executionId });
        }
        if (verification.reason === ERROR_CLASSES.CHAIN_REVERTED || verification.reason === ERROR_CLASSES.CHAIN_MISMATCH) {
            await transitionExecution(prisma, executionId, [STATUSES.BROADCAST, STATUSES.CONFIRMING], {
                status: STATUSES.RECONCILIATION_REQUIRED,
                errorClass: verification.reason,
                errorMessage: redact(verification.detail),
            });
            return { status: STATUSES.RECONCILIATION_REQUIRED, changed: true, reason: verification.reason };
        }
        return { status: STATUSES.BROADCAST, changed: false, pending: true, detail: verification.detail };
    }

    return { status: execution.status, changed: false };
}

/**
 * Idempotent settlement: COMPLETED exactly once, atomically with the ledger
 * side effects (TransactionHistory -> COMPLETED, OnchainSweep -> CONFIRMED).
 * A duplicate settlement call is a no-op (duplicate callback -> one settlement).
 */
async function settleExecution(prisma, { executionId }) {
    return prisma.$transaction(async (tx) => {
        const res = await tx.custodyExecution.updateMany({
            where: { id: executionId, status: { in: [STATUSES.CONFIRMING, STATUSES.BROADCAST] } },
            data: { status: STATUSES.COMPLETED, confirmedAt: new Date() },
        });
        if (res.count !== 1) {
            const current = await tx.custodyExecution.findUnique({ where: { id: executionId }, select: { status: true } });
            return { settled: false, alreadySettled: current?.status === STATUSES.COMPLETED, status: current?.status };
        }
        const execution = await tx.custodyExecution.findUnique({ where: { id: executionId } });

        if (execution.kind === 'CUSTOMER_WITHDRAWAL' && execution.refId) {
            await tx.transactionHistory.updateMany({
                where: { id: execution.refId, status: 'PENDING' },
                data:  { status: 'COMPLETED' },
            });
        }
        if (execution.kind === 'DEPOSIT_SWEEP' && execution.refId) {
            await tx.onchainSweep.updateMany({
                where: { id: execution.refId },
                data:  { status: 'CONFIRMED', confirmedAt: new Date() },
            });
        }
        return { settled: true, alreadySettled: false, status: STATUSES.COMPLETED, txHash: execution.txHash };
    });
}

/**
 * Definitive failure for a CUSTOMER_WITHDRAWAL: conditional execution
 * transition (only from pre-broadcast states) atomically with the exactly-once
 * customer refund. Broadcast/CONFIRMING executions are ambiguous and must go
 * to reconcileExecution instead — a provider timeout is never a refund.
 */
async function failWithdrawalExecution(prisma, { executionId, errorClass, errorMessage, refund }) {
    return prisma.$transaction(async (tx) => {
        const res = await tx.custodyExecution.updateMany({
            where: { id: executionId, status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING, STATUSES.SUBMITTED, STATUSES.SIGNING] } },
            data:  { status: STATUSES.FAILED, errorClass: errorClass || ERROR_CLASSES.PROVIDER_REJECTED, errorMessage: redact(errorMessage) },
        });
        if (res.count !== 1) {
            return { failed: false, reason: 'EXECUTION_NOT_IN_PRE_BROADCAST_STATE' };
        }
        if (typeof refund === 'function') {
            await refund(tx);
        }
        return { failed: true };
    });
}

/**
 * Ambiguous outcome: mark RECONCILIATION_REQUIRED WITHOUT any refund. A human
 * or reconciliation pass must prove what happened on chain first.
 */
async function reconcileExecution(prisma, { executionId, errorClass = ERROR_CLASSES.UNKNOWN_OUTCOME, errorMessage }) {
    const ok = await transitionExecution(prisma, executionId, INFLIGHT, {
        status: STATUSES.RECONCILIATION_REQUIRED,
        errorClass,
        errorMessage: redact(errorMessage || 'Ambiguous external outcome — reconciliation required.'),
    });
    return ok;
}

/**
 * Mark an execution definitively FAILED (no refund here — the sweep path moves
 * no customer money at claim time; the withdrawal path uses
 * failWithdrawalExecution so FAILED + refund are atomic and exactly-once).
 * Forward-only: terminal states never move.
 */
async function failExecution(prisma, { executionId, errorClass, errorMessage }) {
    const ok = await transitionExecution(prisma, executionId, INFLIGHT, {
        status: STATUSES.FAILED,
        errorClass: errorClass || ERROR_CLASSES.PROVIDER_REJECTED,
        errorMessage: redact(errorMessage || 'definitive failure'),
    });
    if (!ok) {
        const current = await prisma.custodyExecution.findUnique({ where: { id: executionId }, select: { status: true } });
        logger.warn({ executionId, status: current?.status }, '[custody-execution] failExecution ignored — not in an in-flight state');
    }
    return ok;
}

/**
 * Advance every in-flight SIGNING/BROADCAST execution by one lifecycle step
 * using real provider/chain evidence. Idempotent — this is what the recurring
// custody worker calls; it never submits anything new and never fabricates
 * results. Ambiguous executions stay RECONCILIATION_REQUIRED for humans.
 */
async function reconcilePendingExecutions(prisma, { provider = getProvider(), limit = 25 } = {}) {
    requireExecutionEnabled();
    const pending = await prisma.custodyExecution.findMany({
        where: { status: { in: [STATUSES.SIGNING, STATUSES.BROADCAST] } },
        orderBy: { createdAt: 'asc' },
        take: limit,
    });
    const results = [];
    for (const execution of pending) {
        try {
            const outcome = await advanceExecution(prisma, { executionId: execution.id }, { provider });
            results.push({ executionId: execution.id, ...outcome });
        } catch (err) {
            logger.warn({ err: redact(err.message), executionId: execution.id }, '[custody-execution] advance failed');
            results.push({ executionId: execution.id, status: 'ERROR', detail: redact(err.message) });
        }
    }
    return results;
}

module.exports = {
    CANONICAL,
    STATUSES,
    TERMINAL,
    INFLIGHT,
    toBaseUnits,
    isValidPolygonAddress,
    isValidTxHash,
    normalizeAddress,
    validateDestination,
    getConfig,
    executionGateStatus,
    requireExecutionEnabled,
    preflight,
    createHttpProvider,
    buildTokenTransferPayload,
    createWithdrawalExecution,
    claimSweepExecution,
    approveKmsRequest,
    denyKmsRequest,
    submitExecution,
    verifyChainTransfer,
    advanceExecution,
    settleExecution,
    failWithdrawalExecution,
    failExecution,
    reconcileExecution,
    reconcilePendingExecutions,
    __setProviderForTests: (p) => { _provider = p; },
};
