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
// KMS identity model (Tatum KMS wallet semantics, no second derivation system):
//  • Customer deposit addresses: signer = TATUM_KMS_SIGNATURE_ID (mnemonic-based
//    signature ID) with derivation index = WalletAddress.derivationIndex
//    (established rule: index = user.id). The exact index is part of every
//    signing request; the expected derived address must equal the canonical
//    WalletAddress.address.
//  • Master hot wallet: signer = TATUM_HOT_WALLET_SIGNATURE_ID with
//    TATUM_HOT_WALLET_INDEX (default 0, mnemonic-based model); address =
//    TATUM_HOT_WALLET_ADDRESS, which must agree with TATUM_TREASURY_ADDRESS
//    when both are configured.
//  • signatureId -> address correspondence is NOT proven by deriving from an
//    xpub (an xpub proves the mnemonic, not the KMS signature ID). It is
//    verified against the KMS signer registry (TATUM_KMS_SIGNER_REGISTRY),
//    whose entries ops populate from `tatum-kms getaddress <signatureId> <index>`
//    — the documented, non-destructive KMS CLI proof against the KMS wallet
//    storage. A missing registry entry is fail-closed in LIVE mode; the
//    diagnostics never claim more than the registry actually proves.
//  • Four-eye principle (mandatory on Tatum MAINNET): KMS daemon fetches
//    pending transactions from Tatum and, before signing, performs a plain
//    HTTP GET to the configured externalUrl with the pending transaction ID.
//    Our validator endpoint returns 2xx ONLY for an execution that is durably
//    APPROVED and exactly matches the intended transfer; any non-2xx means
//    KMS must skip the transaction.
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
// Module-private brand for verified chain evidence (settlement authority).
const VERIFIED_CHAIN_EVIDENCE = Symbol('verifiedChainEvidence');

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

/**
 * EXACT inverse of toBaseUnits: integer base units -> exact decimal string.
 * Pure BigInt/string arithmetic — NEVER Number()/1e6 (binary floating point
 * loses precision for large values) and NEVER String(baseUnits) (base units
 * are not the token quantity).
 *   100123456n -> "100.123456"   1000000n -> "1"   1n -> "0.000001"
 * Trailing fraction zeros are trimmed; an integer value has no fraction part.
 */
function baseUnitsToDecimalString(baseUnits, decimals = CANONICAL.decimals) {
    let units;
    if (typeof baseUnits === 'bigint') {
        units = baseUnits;
    } else if (typeof baseUnits === 'string' && /^-?\d+$/.test(baseUnits)) {
        units = BigInt(baseUnits); // Prisma BigInt serializes losslessly
    } else {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `baseUnitsToDecimalString: expected BigInt or integer string, got ${typeof baseUnits}`);
    }
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `baseUnitsToDecimalString: invalid decimals ${decimals}`);
    }
    if (units < 0n) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, 'baseUnitsToDecimalString: negative amounts are not representable here');
    }
    if (decimals === 0n || decimals === 0) return `${units}`;
    const scale = 10n ** BigInt(decimals);
    const intPart = units / scale;
    const fracRaw = (units % scale).toString().padStart(decimals, '0');
    const frac = fracRaw.replace(/0+$/, '');
    return frac ? `${intPart}.${frac}` : `${intPart}`;
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
        signerRegistryRaw:   process.env.TATUM_KMS_SIGNER_REGISTRY || null,
    };
}

/**
 * KMS signer registry (TATUM_KMS_SIGNER_REGISTRY): a JSON array of
 *   { signatureId, index, address, model }
 * entries where `address` is the address `tatum-kms getaddress <signatureId>
 * <index>` prints on the ops side (the documented non-destructive KMS CLI proof
 * against the KMS wallet storage). model is 'MNEMONIC_INDEXED' (index required)
 * or 'PRIVATE_KEY' (index must be absent). Malformed configuration is treated
 * as absent — never as an empty-but-valid proof.
 */
function getSignerRegistry() {
    const raw = getConfig().signerRegistryRaw;
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        const entries = [];
        for (const e of parsed) {
            if (!e || typeof e.signatureId !== 'string' || typeof e.address !== 'string') continue;
            entries.push({
                signatureId: e.signatureId,
                index: (e.model === 'PRIVATE_KEY') ? null : (Number.isInteger(e.index) ? e.index : 0),
                address: e.address,
                model: e.model === 'PRIVATE_KEY' ? 'PRIVATE_KEY' : 'MNEMONIC_INDEXED',
            });
        }
        return entries.length ? entries : null;
    } catch {
        return null;
    }
}

/**
 * Verify, against the KMS signer registry, that the configured KMS signature
 * identity (+ derivation index for mnemonic-based IDs) controls the expected
 * address. This is the ONLY signer/address verification in the execution
 * boundary. It is a registry consistency check against the documented KMS CLI
 * proof (`tatum-kms getaddress`); it is NOT a live cryptographic proof by this
 * service — the diagnostics say exactly that, never more.
 */
function verifySignerControlsAddress({ signatureId, index, expectedAddress }) {
    const registry = getSignerRegistry();
    if (!registry) {
        return { verified: false, reason: 'REGISTRY_MISSING', detail: 'TATUM_KMS_SIGNER_REGISTRY is not configured — signatureId/address control cannot be verified (fail-closed in LIVE mode).' };
    }
    const entry = registry.find((r) => r.signatureId === signatureId && (r.model === 'PRIVATE_KEY' ? index == null || index === 0 : true));
    if (!entry) {
        return { verified: false, reason: 'SIGNER_NOT_IN_REGISTRY', detail: `signatureId ${signatureId.substring(0, 8)}… has no registry entry (tatum-kms getaddress proof missing).` };
    }
    if (entry.model === 'MNEMONIC_INDEXED' && index != null && entry.index !== index) {
        return { verified: false, reason: 'INDEX_MISMATCH', detail: `registry index for this signatureId is ${entry.index}, execution expects ${index}.` };
    }
    if (normalizeAddress(entry.address) !== normalizeAddress(expectedAddress)) {
        return { verified: false, reason: 'ADDRESS_MISMATCH', detail: `registry says signatureId${index != null ? '@' + index : ''} controls ${entry.address}, expected ${expectedAddress}.` };
    }
    return { verified: true, reason: 'REGISTRY_MATCH', detail: `KMS signer registry confirms signatureId${index != null ? '@' + index : ''} -> ${expectedAddress} (proof source: tatum-kms getaddress).` };
}

// Tatum four-eye is MANDATORY on mainnet; on testnet it may be configurable.
function isMainnet() {
    return String(getConfig().kmsEnvironment || '').toUpperCase() === 'MAINNET';
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
        mainnetFourEyeOk:   !isMainnet() || cfg.kmsFourEyeRequired,
    };
    return {
        // MAINNET + four-eye disabled = NO live signing path, ever.
        enabled: flags.providerLive && flags.apiKeyPresent && flags.kmsEnabled && flags.executionEnabled && flags.mainnetFourEyeOk,
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
    if (normalizeAddress(contractAddress) !== CANONICAL.contractAddress) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_ASSET, `Refusing non-canonical token contract ${contractAddress} — only native Polygon USDC (${CANONICAL.contractAddress}) is executable.`);
    }
    if (!signatureId) {
        throw new CustodyExecutionError(ERROR_CLASSES.KMS_UNAVAILABLE, 'No KMS signatureId supplied — refusing to build a transfer payload.');
    }
    if (!isValidPolygonAddress(from) || !isValidPolygonAddress(to)) {
        throw new CustodyExecutionError(ERROR_CLASSES.INVALID_DESTINATION, 'Transfer payload requires valid from/to addresses.');
    }
    // EXACT provider contract — Tatum POST /v3/blockchain/token/transaction,
    // schema ChainTransferEthErc20KMS (docs.tatum.io/reference/erc20transfer):
    //   chain          = MATIC (Tatum chain identifier; our canonical internal
    //                    network name remains POLYGON)
    //   to             = recipient
    //   contractAddress= native USDC token contract
    //   amount         = token quantity in DECIMAL form (exact string)
    //   digits         = 6
    //   signatureId     = KMS signing identity
    //   index          = derivation index ONLY where the signature ID is
    //                    mnemonic-based (never sent for private-key-based IDs)
    // `from` is deliberately NOT part of the provider request (Tatum derives it
    // from the KMS identity); the application retains it internally as evidence
    // and authorization data. NO fromPrivateKey — KMS-only signing.
    return {
        chain: 'MATIC',
        to,
        contractAddress: CANONICAL.contractAddress,
        amount: baseUnitsToDecimalString(amountBaseUnits, CANONICAL.decimals),
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
                // Tatum's CURRENT fungible-token transfer endpoint for
                // ERC-20-compatible chains (docs.tatum.io/reference/erc20transfer,
                // "/v3/blockchain/token/transaction"). The legacy
                // /v3/polygon/transaction native-asset endpoint is NOT a token
                // transfer API and is never used for USDC.
                const resp = await http.post('/v3/blockchain/token/transaction', payload);
                const data = resp.data || {};
                // EXACT response semantics (OpenAPI schema "SignatureId"): a
                // KMS-signed request returns { signatureId } where this
                // signatureId is the INTERNAL TATUM ID OF THE PREPARED PENDING
                // TRANSACTION for KMS to sign — NOT the request-body signatureId
                // of the KMS wallet. There is no txId in this response shape;
                // a blockchain hash exists only after the KMS daemon signs and
                // broadcasts (observed via GET /v3/kms/{id} or chain evidence).
                const pendingId = (typeof data.signatureId === 'string' && data.signatureId) ? data.signatureId : null;
                const txHash = (data.txId && isValidTxHash(data.txId)) ? data.txId : null; // defensive: not in the KMS response contract
                return {
                    pendingId,
                    txHash,
                    raw: { status: resp.status },
                };
            } catch (err) {
                throw classifyProviderError(err, 'token transfer submission');
            }
        },

        async getKmsRequest(pendingId) {
            try {
                const resp = await http.get(`/v3/kms/${pendingId}`);
                const data = resp.data || {};
                return {
                    id: data.id || pendingId,
                    txHash: (data.txId && isValidTxHash(data.txId)) ? data.txId : null,
                    status: data.status || null,
                };
            } catch (err) {
                throw classifyProviderError(err, 'KMS request fetch');
            }
        },

        // Tatum's documented pending-transaction lifecycle endpoints:
        //   GET    /v3/kms/pending/{chain}   — list pending (reconciliation)
        //   PUT    /v3/kms/{id}/{txId}       — complete pending with the REAL
        //                                      blockchain transaction ID
        //   DELETE /v3/kms/{id}             — cancel a pending transaction
        // There is NO /v3/kms/approve/{id} endpoint in the current Tatum API:
        // four-eye approval happens through the KMS daemon's externalUrl
        // validation contract (see validateKmsPendingRequest), not through a
        // Tatum REST approval call.
        async listPendingRequests(chain = 'MATIC') {
            try {
                const resp = await http.get(`/v3/kms/pending/${chain}`);
                return Array.isArray(resp.data) ? resp.data : [];
            } catch (err) {
                throw classifyProviderError(err, 'KMS pending list');
            }
        },

        async completePendingRequest(pendingId, txId) {
            try {
                await http.put(`/v3/kms/${pendingId}/${txId}`);
                return true;
            } catch (err) {
                throw classifyProviderError(err, 'KMS pending completion');
            }
        },

        async deletePendingRequest(pendingId) {
            try {
                await http.delete(`/v3/kms/${pendingId}`);
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

        // NOTE: there is deliberately NO deriveAddressForSigner method here.
        // Deriving from TATUM_XPUB proves the mnemonic, NOT that a KMS
        // signatureId controls the address; it is not an honest proof and has
        // been removed. Signer/address correspondence is verified against the
        // KMS signer registry (see verifySignerControlsAddress).
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
    if (isMainnet()) {
        // MAINNET: four-eye is MANDATORY (Tatum KMS requirement). Disabled =>
        // blocking check => readyForLiveExecution=false; the execution gate
        // also refuses, so no live signing path can proceed.
        add('kms_four_eye_required', cfg.kmsFourEyeRequired,
            cfg.kmsFourEyeRequired
                ? 'four-eye REQUIRED and configured (mainnet) — KMS daemon externalUrl validation contract'
                : 'four-eye DISABLED on MAINNET — live execution is BLOCKED (mandatory Tatum requirement)');
    } else {
        add('kms_four_eye_required', true,
            cfg.kmsFourEyeRequired
                ? 'four-eye enabled (testnet) — KMS daemon externalUrl validation contract'
                : 'four-eye disabled — permitted on TESTNET only if the Tatum deployment allows');
    }
    add('master_hot_wallet_address_present', !!cfg.hotWalletAddress, cfg.hotWalletAddress || 'MISSING');
    add('master_hot_wallet_signer_present', !!cfg.hotWalletSignatureId, cfg.hotWalletSignatureId ? 'configured' : 'MISSING (TATUM_HOT_WALLET_SIGNATURE_ID)');
    add('hot_wallet_signer_model', true, `TATUM_HOT_WALLET_INDEX=${cfg.hotWalletIndex} (mnemonic-based KMS signature ID model; the index is part of every signing request)`);

    // HOT WALLET signer/address control (registry-verified, fail-closed).
    // TATUM_HOT_WALLET_SIGNATURE_ID + TATUM_HOT_WALLET_INDEX must control
    // TATUM_HOT_WALLET_ADDRESS — proven against the KMS signer registry
    // (`tatum-kms getaddress` output). A mismatch is BLOCKING; a missing
    // registry is blocking in LIVE mode (cannot claim control we cannot prove).
    if (cfg.hotWalletAddress && cfg.hotWalletSignatureId) {
        const hot = verifySignerControlsAddress({
            signatureId: cfg.hotWalletSignatureId,
            index: cfg.hotWalletIndex,
            expectedAddress: cfg.hotWalletAddress,
        });
        if (hot.verified) {
            add('hot_wallet_signer_address_control', true, hot.detail);
        } else if (hot.reason === 'REGISTRY_MISSING') {
            add('hot_wallet_signer_address_control', !gate.enabled,
                'SKIPPED (not live) — TATUM_KMS_SIGNER_REGISTRY absent, signer/address control NOT verified. Live execution requires the registry (tatum-kms getaddress proof).');
        } else {
            add('hot_wallet_signer_address_control', false, `MISMATCH — ${hot.detail}`);
        }
    }
    add('treasury_hot_wallet_consistency',
        !cfg.treasuryAddress || !cfg.hotWalletAddress || normalizeAddress(cfg.treasuryAddress) === normalizeAddress(cfg.hotWalletAddress),
        cfg.treasuryAddress && cfg.hotWalletAddress && normalizeAddress(cfg.treasuryAddress) !== normalizeAddress(cfg.hotWalletAddress)
            ? `MISMATCH: treasury=${cfg.treasuryAddress} hot=${cfg.hotWalletAddress} — execution is fail-closed`
            : 'consistent');
    add('canonical_token_identity', true, `native Polygon USDC ${CANONICAL.contractAddress} (${CANONICAL.decimals} decimals); bridged USDC.e is a distinct asset and never substituted`);

    // Customer signer/address correspondence — verified against the KMS signer
    // registry (tatum-kms getaddress proof), never an xpub derivation. This is
    // exactly what submitExecution enforces for deposit-address sources.
    if (walletAddress && cfg.kmsSignatureId) {
        const signer = verifySignerControlsAddress({
            signatureId: cfg.kmsSignatureId,
            index: walletAddress.derivationIndex,
            expectedAddress: walletAddress.address,
        });
        if (signer.verified) {
            add('signer_address_correspondence', true, signer.detail);
        } else if (signer.reason === 'REGISTRY_MISSING') {
            add('signer_address_correspondence', null,
                'SKIPPED — TATUM_KMS_SIGNER_REGISTRY absent; signatureId@index control over the WalletAddress is NOT verified (submit-time is fail-closed)');
        } else {
            add('signer_address_correspondence', false, `MISMATCH — ${signer.detail}`);
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
// r22 A — THE EXECUTION STATE MACHINE (enforced by FORWARD_TRANSITIONS below;
// each entry documents owner / resumability / evidence source / crash window).
const STATE_MACHINE = Object.freeze({
    // REQUESTED is a legal transient entry state: today's creators
    // (createWithdrawalExecution / claimSweepExecution) create rows directly
    // in RESERVING, so no production row is currently left in REQUESTED —
    // but a two-phase creator may use it, and the state machine refuses
    // unowned states. It therefore shares the RESERVING recovery owner and
    // the same policy (stale PENDING/DENIED → fail+refund; APPROVED →
    // canonical resubmission). (r23 D6)
    [STATUSES.REQUESTED]:            { recoveryOwner: 'custodyRecoveryService.recoverReservingExecutions', providerIo: false, resumable: true, evidence: 'internal' },
    [STATUSES.RESERVING]:            { recoveryOwner: 'custodyRecoveryService.recoverReservingExecutions', providerIo: false, resumable: true,  evidence: 'internal (approval) + provider (post-CAS)' },
    [STATUSES.SUBMITTED]:            { recoveryOwner: 'custodyRecoveryService.recoverSubmittedExecutions',   providerIo: 'ambiguous (CAS won; response maybe lost)', resumable: true, evidence: 'GET /v3/kms/pending/{chain} + GET /v3/kms/{id}' },
    [STATUSES.SIGNING]:              { recoveryOwner: 'reconcilePendingExecutions (advanceExecution)',       providerIo: true,  resumable: true,  evidence: 'GET /v3/kms/{id}' },
    [STATUSES.BROADCAST]:            { recoveryOwner: 'reconcilePendingExecutions (advanceExecution)',       providerIo: true,  resumable: true,  evidence: 'chain receipt (verifyChainTransfer)' },
    [STATUSES.CONFIRMING]:           { recoveryOwner: 'reconcilePendingExecutions (settleExecution)',        providerIo: true,  resumable: true,  evidence: 'verified chain evidence (branded proof)' },
    [STATUSES.COMPLETED]:            { recoveryOwner: 'terminal',           providerIo: true,  resumable: false, evidence: 'verified chain evidence' },
    [STATUSES.FAILED]:               { recoveryOwner: 'terminal',           providerIo: false, resumable: false, evidence: 'definitive pre-broadcast/cancel/revert evidence' },
    [STATUSES.RECONCILIATION_REQUIRED]: { recoveryOwner: 'custodyRecoveryService.convergeReconciliationRequired', providerIo: 'ambiguous', resumable: true, evidence: 'classified: pending-scan / revert-receipt / human' },
});

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

// r22 recovery boundary: the recovery service drives the SAME conditional
// single-winner transitions (never a second, competing update path), and can
// reach the configured provider for evidence-only reads.
function transitionExecutionForRecovery(prisma, executionId, fromStatuses, data) {
    return transitionExecution(prisma, executionId, fromStatuses, data);
}
function __getProviderForRecovery() {
    return getProvider();
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
    if (execution.txHash) {
        // r22 H: broadcast evidence already exists for this execution — its
        // outcome belongs to chain evidence, not to a new authorization. An
        // approval recorded now could never legitimize anything (nothing will
        // sign this execution again) and would only diverge the record from
        // the money. Refuse; the caller may converge via the evidence path.
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
            `KMS approval request ${executionId} already carries broadcast evidence (txHash) — approval refused; chain evidence owns the outcome.`);
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

    // ── r23 D2 — APPROVAL IS A CONDITIONAL (CAS) WRITE ─────────────────────
    // The earlier reads above are only a fast path; this conditional update
    // is the durable authority. It wins ONLY when the row is still:
    //   • awaiting approval (approvalStatus PENDING — a denial that already
    //     landed can never be overwritten),
    //   • in an approval-eligible lifecycle state (REQUESTED/RESERVING — the
    //     durable authorization happens pre-submission by construction; an
    //     approval recorded after the submission CAS could never legitimize
    //     anything and would only diverge the record from the money),
    //   • carrying no broadcast evidence (txHash null).
    // A lost CAS means a concurrent denial/failure/submission made this
    // authorization stale: re-read and fail CLOSED with the exact reason —
    // never restore APPROVED after a denial.
    const res = await prisma.custodyExecution.updateMany({
        where: {
            id: executionId,
            approvalStatus: 'PENDING',
            status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING] },
            txHash: null,
        },
        data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    if (res.count !== 1) {
        const fresh = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
        if (fresh && fresh.approvalStatus === 'APPROVED') {
            // Legitimate repeat of a durable approval (idempotent).
            return { execution: fresh, approved: true, alreadyApproved: true };
        }
        throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
            `KMS approval request ${executionId} is stale (approvalStatus ${fresh?.approvalStatus ?? '?'}, status ${fresh?.status ?? '?'}) — rejected; APPROVED was not restored.`);
    }
    const updated = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
    return { execution: updated, approved: true, alreadyApproved: false };
}

async function denyKmsRequest(prisma, executionId, reason, provider = null) {
    // ── r23 D1 — DENIAL EVIDENCE CONTRACT ──────────────────────────────────
    // A denial is issued by an operator who has NO knowledge of an in-flight
    // provider call. The ONLY proof available to the denier is the durable
    // DB state:
    //
    //   REQUESTED/RESERVING — the submission CAS was never claimed, so no
    //     provider I/O can have happened FOR THIS EXECUTION. The denial is
    //     definitive: FAILED + exactly-once refund (failWithRefund's own CAS
    //     is the single-winner claim; a racing submitter that claims
    //     SUBMITTED keeps its in-flight state and the loop re-classifies).
    //
    //   SUBMITTED/SIGNING (no txHash) — the provider MAY have been contacted
    //     (the claim exists). A successful provider cancel is NOT broadcast
    //     proof: Tatum's documented lifecycle lets a KMS daemon fetch that
    //     was already in flight sign and broadcast the transaction. So the
    //     cancel is attempted FIRST (best-effort: it stops future fetches)
    //     and its result is RECORDED, but the row is ALWAYS quarantined —
    //     never refunded on the denial path, never reported as failed.
    //     approvalStatus=DENIED also stops the four-eye validator from ever
    //     authorizing a signature for this execution again.
    //
    //   BROADCAST/CONFIRMING with txHash — the transfer is already on chain;
    //     a denial cannot un-broadcast. The DENIED fact is recorded, chain
    //     evidence remains the settlement authority, and the exact
    //     limitation is returned to the caller.
    //
    //   Terminal (COMPLETED/FAILED/RECONCILIATION_REQUIRED) — record the
    //     refusal fact only. This is also the idempotency boundary: a
    //     REPEATED denial can never move money a second time (proof: the
    //     first denial already moved the row out of the CAS sets; the
    //     second denial hits this branch and writes only the DENIED fact).
    //
    // The loop re-reads on every iteration so a lost CAS (a racing submitter
    // claiming SUBMITTED between read and transition) is re-classified
    // against the CURRENT row — never against the stale snapshot.
    const MAX_DENY_ITERATIONS = 5;
    for (let i = 0; i < MAX_DENY_ITERATIONS; i++) {
        const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
        if (!execution) throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Unknown KMS approval request ${executionId}.`);
        if (TERMINAL.has(execution.status)) {
            // Already terminal (settled/failed/quarantined): a denial cannot
            // change money that already moved. Record the refusal fact only.
            const updated = await prisma.custodyExecution.update({
                where: { id: executionId },
                data: { approvalStatus: 'DENIED', errorClass: execution.errorClass || ERROR_CLASSES.CONFIGURATION_ERROR, errorMessage: redact(`${reason || 'denied'} [limitation: already ${execution.status} — fact recorded only]`) },
            });
            return { ...updated, denialLimitation: 'ALREADY_TERMINAL' };
        }

        if (execution.txHash && (execution.status === STATUSES.BROADCAST || execution.status === STATUSES.CONFIRMING)) {
            const updated = await prisma.custodyExecution.update({
                where: { id: executionId },
                data: { approvalStatus: 'DENIED', errorClass: ERROR_CLASSES.CONFIGURATION_ERROR, errorMessage: redact(`${reason || 'denied'} [limitation: transaction already broadcast — chain evidence remains the settlement authority]`) },
            });
            return { ...updated, denialLimitation: 'ALREADY_BROADCAST' };
        }

        // Best-effort provider cancel (kills the pending so future daemon
        // fetches stop seeing it). The result is recorded as evidence — it
        // is NEVER used as no-broadcast proof (r23 D1).
        let cancelAttempted = false;
        let cancelOk = null;
        if (execution.tatumPendingId && provider) {
            cancelAttempted = true;
            try {
                await provider.deletePendingRequest(execution.tatumPendingId);
                cancelOk = true;
            } catch (err) {
                cancelOk = false;
                logger.warn({ err: redact(err.message || String(err)), executionId }, '[custody-execution] KMS pending cancel failed during denial — quarantining');
            }
        }

        if (execution.status === STATUSES.REQUESTED || execution.status === STATUSES.RESERVING) {
            // Definitive: the submission CAS was never claimed — no provider
            // I/O can have happened. Fail + refund through the shared
            // exactly-once primitive (its CAS is the single-winner claim).
            const recovery = require('./custodyRecoveryService'); // lazy: no import cycle
            const outcome = await recovery.failWithRefund(prisma, {
                execution,
                errorClass: ERROR_CLASSES.CONFIGURATION_ERROR,
                errorMessage: redact(`${reason || 'denied'} [denied before submission — no provider I/O possible]`),
                reason: 'KMS denial (pre-submission)',
                transitionData: { approvalStatus: 'DENIED' },
            });
            if (outcome.failed) {
                const updated = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
                return { ...updated, denialLimitation: 'FAILED_REFUNDED_PRE_SUBMISSION' };
            }
            if (outcome.quarantined) {
                // The refund itself discovered misbound history linkage —
                // the money was withheld and the row is quarantined.
                const updated = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
                return { ...updated, denialLimitation: 'REFUND_WITHHELD_MISBOUND_HISTORY_QUARANTINED' };
            }
            // Lost the CAS to a racing submitter (row moved to SUBMITTED) —
            // loop and re-classify against the fresh state.
            continue;
        }

        if (execution.status === STATUSES.SUBMITTED || execution.status === STATUSES.SIGNING) {
            // Past the submission CAS: a provider call may be (or have been)
            // in flight and a cancel success is NOT broadcast proof. Fail
            // closed: quarantine + record DENIED (the validator refuses to
            // sign DENIED, so no future signing can resurrect this
            // execution), NEVER refund on the denial path.
            const cancelNote = !cancelAttempted
                ? ''
                : (cancelOk
                    ? ' [provider pending cancelled — cancel is NOT broadcast proof: a daemon fetch already in flight is an unavoidable external race]'
                    : ' [provider pending cancel FAILED — the pending may still be alive]');
            const moved = await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING], {
                status: STATUSES.RECONCILIATION_REQUIRED,
                approvalStatus: 'DENIED',
                errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME,
                errorMessage: redact(`Denial of an already-submitted request — human reconciliation required before any refund or retry. ${reason || ''}${cancelNote}`).slice(0, 500),
            });
            if (!moved) {
                // A racing submitter/advancer moved the row — loop and
                // re-classify against the fresh state.
                continue;
            }
            const updated = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
            return { ...updated, denialLimitation: cancelAttempted && cancelOk ? 'QUARANTINED_POST_SUBMISSION_PENDING_CANCELLED' : (cancelAttempted ? 'PENDING_CANCEL_FAILED_QUARANTINED' : 'QUARANTINED_POST_SUBMISSION') };
        }

        // BROADCAST/CONFIRMING without txHash cannot exist by construction;
        // any other state is unexpected — loop once more, then fail closed.
    }
    // Could not converge within the iteration bound (sustained concurrent
    // mutation). Refuse to claim anything — the row keeps its current state
    // and the caller is told the denial did not converge.
    throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
        `Denial of ${executionId} could not converge against concurrent state changes — no money moved; retry the denial.`);
}

// ── Four-eye external validation (Tatum KMS externalUrl contract) ──────────

/**
 * THE application side of Tatum KMS's four-eye principle.
 *
 * Tatum's documented mechanism: with the KMS daemon started with
 * `--externalUrl=<our server URL>`, every time the daemon fetches a pending
 * transaction to sign it performs a plain HTTP GET to
 * `<externalUrl>/<pendingTransactionId>` and signs ONLY on a 2xx response;
 * any non-2xx means the transaction is skipped.
 *
 * This validator answers those GETs. It is READ-ONLY (no financial mutation,
 * no state transition, no secrets) and returns { approved: true } ONLY when
 * the pending transaction id maps to a durable CustodyExecution that:
 *   • is not terminal and not in RECONCILIATION_REQUIRED (stale/settled refuse);
 *   • is durably APPROVED (the internal approveKmsRequest record — the
 *     application's exact-match authorization of this very transfer);
 *   • is of an authorized kind (CUSTOMER_WITHDRAWAL | DEPOSIT_SWEEP);
 *   • is on the exact canonical network + exact native-USDC contract;
 *   • has the exact authorized sender and recipient addresses;
 *   • matches the exact base-unit amount for the authorized execution;
 *   • is signed by the exact configured KMS signer identity (+ derivation
 *     index where the mnemonic-based model requires it).
 * Everything else — unknown, denied, mismatched, already-settled — is a
 * refusal (non-2xx), so KMS must not sign.
 */
async function validateKmsPendingRequest(prisma, { pendingId }) {
    if (!pendingId || typeof pendingId !== 'string' || !/^[-A-Za-z0-9]{1,100}$/.test(pendingId)) {
        return { approved: false, httpStatus: 404, reason: 'MALFORMED_PENDING_ID' };
    }
    const execution = await prisma.custodyExecution.findFirst({ where: { tatumPendingId: pendingId } });
    if (!execution) {
        // Unknown to the application: this is not an authorized transaction.
        return { approved: false, httpStatus: 404, reason: 'UNKNOWN_PENDING_TRANSACTION' };
    }
    if (TERMINAL.has(execution.status)) {
        return { approved: false, httpStatus: 409, reason: `EXECUTION_TERMINAL_${execution.status}` };
    }
    if (execution.approvalStatus !== 'APPROVED') {
        return { approved: false, httpStatus: 403, reason: `EXECUTION_NOT_APPROVED_${execution.approvalStatus}` };
    }
    if (execution.kind !== 'CUSTOMER_WITHDRAWAL' && execution.kind !== 'DEPOSIT_SWEEP') {
        return { approved: false, httpStatus: 403, reason: `UNAUTHORIZED_KIND_${execution.kind}` };
    }
    // Exact asset/network identity.
    if (execution.network !== CANONICAL.network
        || execution.asset !== CANONICAL.asset
        || normalizeAddress(execution.contractAddress) !== CANONICAL.contractAddress
        || execution.decimals !== CANONICAL.decimals) {
        return { approved: false, httpStatus: 403, reason: 'ASSET_NETWORK_MISMATCH' };
    }
    // Exact sender/recipient: the addresses of the authorized execution.
    if (!isValidPolygonAddress(execution.fromAddress) || !isValidPolygonAddress(execution.toAddress)) {
        return { approved: false, httpStatus: 403, reason: 'ADDRESS_MALFORMED' };
    }
    if (execution.amountBaseUnits == null || BigInt(execution.amountBaseUnits) <= 0n) {
        return { approved: false, httpStatus: 403, reason: 'AMOUNT_INVALID' };
    }
    // Exact signer identity: the configured KMS signature identity (+ index)
    // that the application authorized for this source address.
    const signer = resolveSignerForAddress(execution.fromAddress);
    const expectedIndex = signer.role === 'CUSTOMER_DEPOSIT_WALLET'
        ? (execution.metadata?.derivationIndex ?? null)
        : signer.index;
    const proof = verifySignerControlsAddress({ signatureId: signer.signatureId, index: expectedIndex, expectedAddress: execution.fromAddress });
    if (!proof.verified) {
        return { approved: false, httpStatus: 403, reason: `SIGNER_VERIFICATION_FAILED_${proof.reason}` };
    }
    // 2xx ONLY on exact authorization. The response exposes no secrets: only
    // non-sensitive status facts the KMS operator can use for diagnostics.
    logger.info({ executionId: execution.id, kind: execution.kind, status: execution.status }, '[custody-execution] four-eye external validation: APPROVED (KMS may sign)');
    return {
        approved: true,
        httpStatus: 200,
        executionId: execution.id,
        kind: execution.kind,
        status: execution.status,
        network: execution.network,
    };
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

    // Signer/address correspondence for BOTH source roles — proven against the
    // KMS signer registry (tatum-kms getaddress proof). The KMS signature
    // identity (+ derivation index) must control the EXACT source address; a
    // mismatch is a hard failure and an unprovable configuration is fail-closed.
    // This is deliberately NOT an xpub derivation (an xpub proves the mnemonic,
    // not the KMS signature ID).
    {
        const proof = verifySignerControlsAddress({
            signatureId: signer.signatureId,
            index,
            expectedAddress: execution.fromAddress,
        });
        if (!proof.verified) {
            throw new CustodyExecutionError(
                proof.reason === 'ADDRESS_MISMATCH' || proof.reason === 'INDEX_MISMATCH' ? ERROR_CLASSES.SIGNER_MISMATCH : ERROR_CLASSES.CONFIGURATION_ERROR,
                `KMS signer verification failed for ${execution.fromAddress} (${proof.reason}): ${proof.detail} — refusing to execute.`
            );
        }
    }

    // Payload — the one construction point; hard-rejects private keys and is
    // the exact Tatum ChainTransferEthErc20KMS contract (chain MATIC, decimal
    // amount, digits 6, signatureId, index only for mnemonic-based IDs).
    const payload = buildTokenTransferPayload({
        from: execution.fromAddress,
        to: execution.toAddress,
        amountBaseUnits: BigInt(execution.amountBaseUnits),
        contractAddress: normalizeAddress(execution.contractAddress),
        signatureId: signer.signatureId,
        index,
    });

    // ── ATOMIC SINGLE-WINNER CLAIM ────────────────────────────────────────
    // RESERVING/REQUESTED --CAS--> SUBMITTED. ONLY the process whose
    // conditional update actually moved the row may call the external
    // provider. The transition result is CHECKED — a lost CAS never reaches
    // Tatum (no second external submission, ever).
    const claimed = await transitionExecution(prisma, executionId, [STATUSES.REQUESTED, STATUSES.RESERVING], { status: STATUSES.SUBMITTED, submittedAt: new Date() });
    if (!claimed) {
        // Lost the race to another process (or a retry while in flight).
        // Converge on the existing execution; NEVER call the provider.
        const current = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
        if (current && TERMINAL.has(current.status)) {
            throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR, `Execution ${executionId} became terminal (${current.status}) — converged, not resubmitted.`);
        }
        if (current && current.status === STATUSES.SUBMITTED && !current.tatumPendingId) {
            // Crash-after-claim, before the provider request completed: the
            // outcome is INTENTIONALLY ambiguous. Do NOT move it back to
            // RESERVING and do NOT retry — reconciliation must determine
            // whether the provider ever created a pending transaction.
            const ambiguous = new CustodyExecutionError(ERROR_CLASSES.UNKNOWN_OUTCOME,
                `Execution ${executionId} was already claimed for submission (outcome ambiguous — a prior process may have created a pending provider request). Reconciliation required; NO second submission was attempted.`);
            ambiguous.ambiguous = true;
            throw ambiguous;
        }
        logger.warn({ executionId, status: current?.status }, '[custody-execution] submission claim lost — converging on the existing execution (no provider call)');
        return { status: current?.status || 'UNKNOWN', pendingId: current?.tatumPendingId || null, pending: current ? !TERMINAL.has(current.status) : false, converged: true };
    }
    // CAS won. From here a crash leaves the row in SUBMITTED with no
    // tatumPendingId — an intentionally ambiguous state that ONLY
    // reconciliation may resolve (never an automatic resubmission).

    // Mark an outcome as ambiguous (reconciliation decides; never auto-refund
    // or blind retry) and surface it to the caller as UNKNOWN_OUTCOME.
    const reconcileAmbiguous = async (pendingId, detail) => {
        await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST], {
            status: STATUSES.RECONCILIATION_REQUIRED,
            errorClass: ERROR_CLASSES.UNKNOWN_OUTCOME,
            errorMessage: redact(`Ambiguous external outcome: ${detail}`),
            tatumPendingId: pendingId || undefined,
        });
        const unknown = new CustodyExecutionError(ERROR_CLASSES.UNKNOWN_OUTCOME,
            'Provider outcome is unknown (timeout/network/5xx or unusable evidence). This is NOT treated as failure — reconciliation required before any refund or retry.');
        unknown.ambiguous = true;
        throw unknown;
    };

    let pendingId = null;
    try {
        const result = await provider.submitTokenTransfer(payload);
        // Response semantics per Tatum's SignatureId schema: pendingId is the
        // internal Tatum ID of the PREPARED PENDING TRANSACTION. It is what the
        // KMS daemon validates (externalUrl GET), what KMS polling completes
        // with the real blockchain tx ID (PUT /v3/kms/{id}/{txId}), what can be
        // cancelled (DELETE /v3/kms/{id}), and the reconciliation key.
        pendingId = result.pendingId || null;

        if (result.txHash) {
            // Broadcast evidence exists already (e.g. daemon-signed instantly).
            // A malformed hash is NOT usable evidence — and we cannot know what
            // the provider actually did, so it is ambiguous, never "failed".
            if (!isValidTxHash(result.txHash)) {
                await reconcileAmbiguous(pendingId, 'provider returned a malformed tx hash');
            }
            const movedToBroadcast = await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.BROADCAST], {
                status: STATUSES.BROADCAST, txHash: result.txHash, broadcastAt: new Date(),
                tatumPendingId: pendingId || undefined,
            });
            if (!movedToBroadcast) {
                // r23 D1: a concurrent denial quarantined (or an advancer
                // moved) the row while the provider call was in flight. The
                // provider response is real but the durable row belongs to
                // the winner — converge on the actual state; never claim
                // BROADCAST that is not durably ours.
                const current = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
                return { status: current?.status || 'UNKNOWN', txHash: current?.txHash || null, pending: current ? !TERMINAL.has(current.status) : false, converged: true, pendingId };
            }
            return { status: STATUSES.BROADCAST, txHash: result.txHash, pending: false };
        }

        if (pendingId) {
            // Accepted into Tatum's KMS pending-signing state. Four-eye is
            // implemented through Tatum's DOCUMENTED external validation
            // contract — there is no Tatum "approve" REST call: when the KMS
            // daemon fetches this pending transaction it GETs our externalUrl
            // with this ID and signs ONLY on our 2xx (see
            // validateKmsPendingRequest / the internal validator route). The
            // durable approval was already recorded pre-submission and is
            // exactly what the validator enforces; the submission boundary
            // checked it above.
            const movedToSigning = await transitionExecution(prisma, executionId, [STATUSES.SUBMITTED], {
                status: STATUSES.SIGNING, tatumPendingId: pendingId,
            });
            if (!movedToSigning) {
                // r23 D1: a concurrent denial quarantined the row while the
                // provider call was in flight. The pending exists at the
                // provider, but approvalStatus=DENIED (recorded by the
                // denial) makes the four-eye validator refuse to sign it —
                // the durable row stays with the denial's winner.
                const current = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
                return { status: current?.status || 'UNKNOWN', pendingId, pending: current ? !TERMINAL.has(current.status) : false, converged: true };
            }
            return { status: STATUSES.SIGNING, pendingId, pending: true };
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
        await reconcileAmbiguous(pendingId, classified.message);
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
    // Branded proof object: COMPLETED is legal ONLY with this exact marker,
    // which only the authoritative verification path (this function) can mint.
    // settleExecution() refuses to complete an execution without it (or
    // without performing the same verification itself first). The Symbol is
    // module-private and cannot be forged by callers.
    return { verified: true, detail: 'Transfer semantics verified on chain (contract, sender, recipient, exact base units, successful receipt).', [VERIFIED_CHAIN_EVIDENCE]: true };
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

    if (execution.status === STATUSES.SIGNING && execution.tatumPendingId) {
        const kms = await provider.getKmsRequest(execution.tatumPendingId);
        if (kms.txHash) {
            if (!isValidTxHash(kms.txHash)) {
                await transitionExecution(prisma, executionId, [STATUSES.SIGNING], {
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                    errorMessage: 'KMS daemon returned a malformed tx hash — reconciliation required.',
                });
                return { status: STATUSES.RECONCILIATION_REQUIRED, changed: true };
            }
            const moved = await transitionExecution(prisma, executionId, [STATUSES.SIGNING], {
                status: STATUSES.BROADCAST, txHash: kms.txHash, broadcastAt: new Date(),
            });
            if (!moved) {
                // Another process moved the row first — converge on its state.
                const current = await prisma.custodyExecution.findUnique({ where: { id: executionId }, select: { status: true, txHash: true } });
                return { status: current?.status || STATUSES.SIGNING, changed: false, txHash: current?.txHash || null, converged: true };
            }
            // Best-effort: complete Tatum's pending-transaction record with the
            // REAL blockchain transaction ID (PUT /v3/kms/{id}/{txId}). The KMS
            // daemon normally does this itself; a failure here never blocks
            // settlement — chain evidence is the completion authority.
            if (typeof provider.completePendingRequest === 'function') {
                try { await provider.completePendingRequest(execution.tatumPendingId, kms.txHash); }
                catch (err) { logger.warn({ err: redact(err.message || String(err)) }, '[custody-execution] Tatum pending completion (best-effort) failed'); }
            }
            return { status: STATUSES.BROADCAST, changed: true, txHash: kms.txHash };
        }
        return { status: STATUSES.SIGNING, changed: false };
    }

    if ((execution.status === STATUSES.BROADCAST || execution.status === STATUSES.CONFIRMING) && execution.txHash) {
        const verification = await verifyChainTransfer(provider, {
            txHash: execution.txHash,
            fromAddress: execution.fromAddress,
            toAddress: execution.toAddress,
            contractAddress: execution.contractAddress,
            amountBaseUnits: BigInt(execution.amountBaseUnits),
        });
        if (verification.verified) {
            // Checked transition: another reconciler may already have advanced.
            const moved = await transitionExecution(prisma, executionId, [STATUSES.BROADCAST, STATUSES.CONFIRMING], { status: STATUSES.CONFIRMING });
            if (!moved && execution.status === STATUSES.BROADCAST) {
                const current = await prisma.custodyExecution.findUnique({ where: { id: executionId }, select: { status: true } });
                if (current && current.status !== STATUSES.CONFIRMING && current.status !== STATUSES.COMPLETED) {
                    return { status: current.status, changed: false, converged: true };
                }
            }
            // COMPLETED only through the settlement authority, which requires
            // the verified chain evidence minted by the authoritative
            // verification path above.
            return settleExecution(prisma, { executionId, evidence: verification });
        }
        if (verification.reason === ERROR_CLASSES.CHAIN_REVERTED || verification.reason === ERROR_CLASSES.CHAIN_MISMATCH) {
            await transitionExecution(prisma, executionId, [STATUSES.BROADCAST, STATUSES.CONFIRMING], {
                status: STATUSES.RECONCILIATION_REQUIRED,
                errorClass: verification.reason,
                errorMessage: redact(verification.detail),
            });
            return { status: STATUSES.RECONCILIATION_REQUIRED, changed: true, reason: verification.reason };
        }
        return { status: execution.status, changed: false, pending: true, detail: verification.detail };
    }

    return { status: execution.status, changed: false };
}

/**
 * Settlement authority. COMPLETED is legal ONLY after VERIFIED CHAIN EVIDENCE:
 *  • a caller may pass `evidence` — accepted ONLY if it carries the
 *    module-private VERIFIED_CHAIN_EVIDENCE brand minted by verifyChainTransfer
 *    (the authoritative verification path); a bare object cannot forge it;
 *  • without a valid proof, settleExecution performs the SAME verification
 *    itself against the stored txHash before completing — so a future caller
 *    cannot do settleExecution(executionId) and bypass the evidence rule.
 * An execution with a txHash but no verified transfer semantics is NEVER
 * completed. Idempotent: duplicate settlement is a no-op.
 */
async function settleExecution(prisma, { executionId, evidence } = {}) {
    let proof = (evidence && evidence[VERIFIED_CHAIN_EVIDENCE] === true) ? evidence : null;
    if (!proof) {
        // No (valid) verified proof supplied — verify the chain ourselves.
        // Refuse to complete anything whose transfer semantics are unproven.
        const execution = await prisma.custodyExecution.findUnique({ where: { id: executionId } });
        if (!execution) return { settled: false, alreadySettled: false, status: 'NOT_FOUND' };
        if (execution.status === STATUSES.COMPLETED) return { settled: false, alreadySettled: true, status: STATUSES.COMPLETED };
        if (execution.status !== STATUSES.BROADCAST && execution.status !== STATUSES.CONFIRMING) {
            return { settled: false, alreadySettled: false, status: execution.status, reason: 'SETTLEMENT_REFUSED_NOT_IN_BROADCAST_STATE' };
        }
        const verification = await verifyChainTransfer(getProvider(), {
            txHash: execution.txHash,
            fromAddress: execution.fromAddress,
            toAddress: execution.toAddress,
            contractAddress: execution.contractAddress,
            amountBaseUnits: BigInt(execution.amountBaseUnits),
        });
        if (!verification.verified) {
            if (verification.reason === ERROR_CLASSES.CHAIN_REVERTED || verification.reason === ERROR_CLASSES.CHAIN_MISMATCH) {
                await transitionExecution(prisma, executionId, [STATUSES.BROADCAST, STATUSES.CONFIRMING], {
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass: verification.reason,
                    errorMessage: redact(`Settlement refused: ${verification.detail}`),
                });
                return { settled: false, alreadySettled: false, status: STATUSES.RECONCILIATION_REQUIRED, reason: verification.reason };
            }
            return { settled: false, alreadySettled: false, status: execution.status, reason: 'CHAIN_EVIDENCE_NOT_VERIFIED', detail: verification.detail };
        }
        proof = verification;
    }
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
            // r22 F/G — TERMINAL CONVERGENCE GUARDS:
            //  • the CAS result MUST be exactly one: an execution can never
            //    become COMPLETED while its linked customer-facing record
            //    stays PENDING (the previous unchecked updateMany permitted
            //    exactly that divergence);
            //  • the REAL chain tx hash converges into TransactionHistory
            //    atomically with the completion — the customer-facing
            //    canonical record never shows a null hash after settlement
            //    while CustodyExecution carries the real one (no competing
            //    transaction-hash authorities);
            //  • a linked record already FAILED while chain evidence proves
            //    success is a GENUINE contradiction: the settlement aborts
            //    (rolls back) and the execution is quarantined for human
            //    reconciliation — money state and record state can never
            //    silently disagree.
            const hist = await tx.transactionHistory.findUnique({ where: { id: execution.refId }, select: { status: true, userId: true, type: true, txHash: true, amountUsdc: true, feeUsdc: true } });
            // NOTE: we are INSIDE the settle transaction whose earlier CAS
            // already moved this row to COMPLETED (uncommitted). The guards
            // below therefore cannot re-filter on status — this transaction's
            // atomicity IS the single-winner claim; overriding the row here
            // either commits the quarantine or rolls everything back.
            const QuarantineSettlement = (reason, message) => tx.custodyExecution.updateMany({
                where: { id: executionId },
                data: {
                    status: STATUSES.RECONCILIATION_REQUIRED,
                    errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                    errorMessage: redact(message).slice(0, 500),
                },
            }).then(() => ({ settled: false, alreadySettled: false, status: STATUSES.RECONCILIATION_REQUIRED, reason }));
            // ── r23 D3 — LINKED-RECORD IDENTITY GUARDS ──────────────────────
            // refId is an unvalidated TEXT column. Settlement must never
            // complete an execution whose linked customer-facing record is
            // bound to a DIFFERENT customer, a different record type, or a
            // conflicting economic identity — a corrupted/misbound refId must
            // surface as a human reconciliation, never as a silent success.
            if (hist && execution.userId != null && hist.userId != null && Number(hist.userId) !== Number(execution.userId)) {
                return QuarantineSettlement('LINKED_HISTORY_WRONG_OWNER',
                    `Settlement refused: linked TransactionHistory ${execution.refId} belongs to user ${hist.userId}, but the execution belongs to user ${execution.userId} — human reconciliation required.`);
            }
            if (hist && hist.type !== 'WITHDRAWAL_CRYPTO') {
                return QuarantineSettlement('LINKED_HISTORY_WRONG_TYPE',
                    `Settlement refused: linked TransactionHistory ${execution.refId} has type ${hist.type}, not WITHDRAWAL_CRYPTO — human reconciliation required.`);
            }
            if (hist) {
                // Economic identity: the linked record's NET payout must
                // EXACTLY equal the execution's base-unit economics (6
                // decimals) — compared as exact decimals, floating point is
                // never the authority. The fee is compared ONLY when the
                // execution carries a feeChargeBaseUnits authority: the
                // column is nullable and legacy executions legitimately keep
                // the fee on the history side alone; an absent execution
                // authority cannot "disagree".
                const expectedNet = require('./custodyAccountingService').decimalStringFromBaseUnits(BigInt(execution.amountBaseUnits), 6);
                const PrismaDecimal = require('@prisma/client').Prisma.Decimal;
                const netOk = new PrismaDecimal(hist.amountUsdc ?? 0).equals(new PrismaDecimal(expectedNet));
                let feeOk = true;
                if (execution.feeChargeBaseUnits != null) {
                    const expectedFee = require('./custodyAccountingService').decimalStringFromBaseUnits(BigInt(execution.feeChargeBaseUnits), 6);
                    feeOk = new PrismaDecimal(hist.feeUsdc ?? 0).equals(new PrismaDecimal(expectedFee));
                }
                if (!netOk || !feeOk) {
                    return QuarantineSettlement('LINKED_HISTORY_ECONOMIC_MISMATCH',
                        `Settlement refused: linked TransactionHistory ${execution.refId} economics (net ${hist.amountUsdc}, fee ${hist.feeUsdc ?? 'absent'}) do not match the execution (net ${expectedNet}) — human reconciliation required.`);
                }
            }
            if (!hist) {
                await tx.custodyExecution.updateMany({
                    where: { id: executionId },
                    data: {
                        status: STATUSES.RECONCILIATION_REQUIRED,
                        errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                        errorMessage: redact(`Settlement refused: linked TransactionHistory ${execution.refId} is missing — human reconciliation required.`),
                    },
                });
                return { settled: false, alreadySettled: false, status: STATUSES.RECONCILIATION_REQUIRED, reason: 'LINKED_HISTORY_MISSING' };
            }
            if (hist.status === 'FAILED') {
                await tx.custodyExecution.updateMany({
                    where: { id: executionId },
                    data: {
                        status: STATUSES.RECONCILIATION_REQUIRED,
                        errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                        errorMessage: redact('Settlement refused: linked TransactionHistory is FAILED while chain evidence proves success — human reconciliation required.'),
                    },
                });
                return { settled: false, alreadySettled: false, status: STATUSES.RECONCILIATION_REQUIRED, reason: 'LINKED_HISTORY_FAILED_CONTRADICTION' };
            }
            const moved = await tx.transactionHistory.updateMany({
                where: { id: execution.refId, status: 'PENDING' },
                data:  { status: 'COMPLETED', txHash: execution.txHash },
            });
            if (moved.count !== 1 && hist.status !== 'COMPLETED') {
                // Concurrent writer changed the row between the read and the
                // CAS: fail the whole settlement atomically; retry converges.
                throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
                    `Settlement refused: linked TransactionHistory ${execution.refId} changed concurrently — settlement will retry.`);
            }
            if (hist.status === 'COMPLETED' && execution.txHash) {
                if (hist.txHash && hist.txHash !== execution.txHash) {
                    // r23 D3: TWO competing transaction-hash authorities that
                    // DISAGREE is a genuine contradiction — never silently
                    // overwrite one with the other and never settle over
                    // it. Quarantine for human reconciliation.
                    return QuarantineSettlement('LINKED_HISTORY_TXHASH_CONFLICT',
                        `Settlement refused: linked TransactionHistory ${execution.refId} already carries txHash ${hist.txHash} while verified chain evidence for the execution is ${execution.txHash} — human reconciliation required.`);
                }
                // Idempotent re-settle: converge the real hash if a prior
                // settlement completed the record before this pass recorded it.
                await tx.transactionHistory.updateMany({
                    where: { id: execution.refId, status: 'COMPLETED', txHash: null },
                    data:  { txHash: execution.txHash },
                });
            }
        }
        if (execution.kind === 'DEPOSIT_SWEEP' && execution.refId) {
            // r22 M — audit-row convergence: checked CAS to CONFIRMED. The
            // CustodyExecution is the money authority; the OnchainSweep row is
            // the operational audit. A missing row (its creation was already
            // permitted to fail by documented compatibility design) or an
            // already-CONFIRMED row is fine; a different disagreement is
            // logged, never allowed to fail the real settlement.
            const sweep = await tx.onchainSweep.updateMany({
                where: { id: execution.refId },
                data:  { status: 'CONFIRMED', confirmedAt: new Date() },
            });
            if (sweep.count !== 1) {
                const row = await tx.onchainSweep.findUnique({ where: { id: execution.refId }, select: { status: true } });
                logger[row ? 'warn' : 'info'](
                    { executionId: executionId, onchainSweepId: execution.refId, rowStatus: row?.status ?? 'MISSING' },
                    '[custody-execution] sweep audit row did not converge to CONFIRMED (audit-only; execution settlement is the authority)'
                );
            }
        }

        // §P.3 custody accounting: the verified settlement IS transaction
        // evidence. The custody movement (and its exact journal posting) is
        // created in this SAME transaction — atomic with the settlement, or
        // not at all. A failure rolls the settlement back to its prior state
        // and the reconciliation lifecycle retries; the movement's
        // idempotency key converges on retry.
        const custodyAccounting = require('./custodyAccountingService');
        const settleCfg = getConfig();
        if (!settleCfg.hotWalletAddress) {
            throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
                'Settlement refused: master hot wallet address is not configured — cannot record custody accounting.');
        }
        await custodyAccounting.recordExecutionMovement(tx, { execution, hotWalletAddress: settleCfg.hotWalletAddress });

        // §P.4 AUTHORITATIVE SETTLEMENT ACCOUNTING — inside the SAME
        // transaction as the COMPLETED transition, the TransactionHistory
        // completion and the VERIFIED custody movement. For a customer
        // withdrawal the reserved funds leave:
        //   D restricted:reserves     — full reserved amount
        //   C custody:hot:usdc       — net payout leaves hot custody
        //   C revenue:fees           — the charged fee is realized only NOW
        //                             (on verified execution — an estimate
        //                             is never converted into realized
        //                             economics)
        // and the restricted obligation is released (conditional single-
        // winner claim; idempotent on settlement retry).
        if (execution.kind === 'CUSTOMER_WITHDRAWAL') {
            const ledger = require('./ledgerService');
            const restrictedObligations = require('./restrictedObligationService');
            // §P.4: the ledger settlement leg applies ONLY to executions that
            // reserved through the authoritative ledger (the §P.4 reservation
            // created the linked restricted obligation). Legacy/pre-P4
            // executions settle with P3 custody semantics only — their
            // economic history is never retroactively invented.
            const pendingObligation = await tx.restrictedObligation.findFirst({
                where: { reference: `withdrawal:crypto:${execution.id}`, status: 'ACTIVE' },
            });
            if (!pendingObligation) {
                return { settled: true, alreadySettled: false, status: STATUSES.COMPLETED, txHash: execution.txHash, ledgerSettlement: 'SKIPPED_NO_LEDGER_RESERVATION' };
            }
            const fullDebit = custodyAccounting.decimalStringFromBaseUnits(BigInt(execution.metadata?.customerDebitBaseUnits ?? execution.amountBaseUnits), 6);
            const netPayout = custodyAccounting.decimalStringFromBaseUnits(BigInt(execution.amountBaseUnits), 6);
            const feeCharged = custodyAccounting.decimalStringFromBaseUnits(BigInt(execution.feeChargeBaseUnits ?? 0), 6);
            const lines = [
                { account: 'restricted:reserves', debit: fullDebit },
                { account: 'custody:hot:usdc', credit: netPayout },
            ];
            if (!(new (require('@prisma/client').Prisma.Decimal)(feeCharged)).isZero()) {
                lines.push({ account: 'revenue:fees', credit: feeCharged });
            }
            const settlementPost = await ledger.post(tx, {
                idempotencyKey: `ledger:withdrawal:crypto:settle:${execution.id}`,
                entryType: 'CUSTODY_WITHDRAWAL',
                description: 'Crypto withdrawal settled on verified chain evidence',
                reference: `custody-exec:${execution.id}`,
                userId: execution.userId ?? null,
                relatedEntity: 'custodyExecution',
                relatedEntityId: execution.id,
                metadata: { status: 'COMPLETED', txHash: execution.txHash, kind: 'SETTLEMENT' },
                lines,
            });
            await restrictedObligations.releaseOnSettlement(tx, {
                reference: `withdrawal:crypto:${execution.id}`,
                releaseLedgerTransactionId: settlementPost.transaction.id,
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
        // r23 D1: SUBMITTED remains permitted (the submitter owns the
        // provider's definitive pre-broadcast rejection for its own claim),
        // but SIGNING does not: a SIGNING row carries a provider pendingId —
        // accepted, possibly already fetched by the KMS daemon — so no
        // caller can prove "no broadcast possible" from that state.
        const res = await tx.custodyExecution.updateMany({
            where: { id: executionId, status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING, STATUSES.SUBMITTED] } },
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
    STATE_MACHINE,
    toBaseUnits,
    baseUnitsToDecimalString,
    getSignerRegistry,
    verifySignerControlsAddress,
    isMainnet,
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
    validateKmsPendingRequest,
    submitExecution,
    verifyChainTransfer,
    advanceExecution,
    settleExecution,
    failWithdrawalExecution,
    failExecution,
    reconcileExecution,
    reconcilePendingExecutions,
    __setProviderForTests: (p) => { _provider = p; },
    // r22 recovery boundary exports
    transitionExecutionForRecovery,
    __getProviderForRecovery,
};
