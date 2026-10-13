// services/custodyEvidenceProvider.js
// =============================================================================
// §P.3 CUSTODY EVIDENCE PROVIDER — provider adapters for custody evidence.
//
// The reserve engine and the custody movement verifier NEVER see provider HTTP
// details; they consume normalized observations from these adapters. Two
// DISTINCT evidence kinds exist and are never interchangeable:
//
//  1. ACCOUNT BALANCE observation (TATUM_V3_TOKEN_BALANCE):
//     GET /v3/blockchain/token/balance/{chain}/{contractAddress}/{address}
//     → { balance: "100123456" } (string, smallest token unit)
//     Valid for custody-account Proof-of-Reserves aggregation ONLY. It proves
//     an address held a quantity at observation time. It does NOT prove that
//     any specific deposit transaction happened, and must never be used as
//     transaction-specific evidence for a CustodyMovement.
//     This response carries NO block reference: freshness is bounded by
//     observedAt + the configured freshness window. Tatum documents that
//     indexed balance data may lag the chain tip; nothing here claims
//     real-time semantics.
//
//  2. TRANSACTION observation (TATUM_V4_TX_BY_HASH):
//     GET /v4/data/transactions/hash?chain=polygon-mainnet&hash={hash}
//     → array of TxData entries: { chain, hash, address, counterAddress,
//        tokenAddress, blockNumber, transactionType, transactionSubtype,
//        amount, timestamp } — amount is an exact decimal string.
//     Valid for proving an individual inbound deposit movement: exact hash,
//     exact chain, exact token contract, exact receiving address, inbound
//     direction, exact quantity, and the block reference the source supplies.
//
// Fail-closed: every adapter error surfaces as a classified
// CustodyEvidenceError; no partial/fabricated observation is ever returned.
// =============================================================================

const axios = require('axios');
const { Prisma } = require('@prisma/client');
const logger = require('../src/config/logger');

const SOURCE_BALANCE = 'TATUM_V3_TOKEN_BALANCE';
const SOURCE_TX = 'TATUM_V4_TX_BY_HASH';

// Tatum chain identifiers (provider-facing). The application's canonical
// network remains POLYGON; the mapping lives ONLY inside these adapters.
const TATUM_V3_CHAIN = { POLYGON: 'MATIC' };
const TATUM_V4_CHAIN = { POLYGON: 'polygon-mainnet' };

// §TATUM-TESTNET — Polygon Amoy. The v3 token-balance endpoint has NO testnet
// chain value (verified against the provider's own chain enum: CELO, SOL,
// ALGO, EGLD, ETH, BSC, MATIC, KLAY, KCS, XDC, ONE, FLR, CRO, ETH_BASE, AVAX,
// ETH_OP, FTM, ETH_ARB, BERA, MON, ETH_UNI, MOCA — mainnets only), so testnet
// balance evidence uses the v4 wallet-portfolio Data API instead.
//
// TESTNET EVIDENCE IS A SEPARATE DOMAIN. The map below is intentionally
// disjoint from TATUM_V3_CHAIN / TATUM_V4_CHAIN: the testnet provider can
// never serve a mainnet network, and the mainnet providers can never serve a
// testnet network. Isolation is structural, not conventional — a Tatum API
// key does NOT enforce it (verified: a testnet key can read mainnet
// portfolio data), so the adapter must.
const TATUM_V4_CHAIN_TESTNET = { POLYGON_TESTNET: 'polygon-amoy' };
const SOURCE_BALANCE_TESTNET = 'TATUM_V4_WALLET_PORTFOLIO_TESTNET';

// §REVIEW-R3 — the testnet evidence domain serves EXACTLY ONE token: the
// canonical Circle-official USDC contract on Polygon PoS Amoy (verified live,
// 2026-10-13: 6 dp, type 'fungible'). The provider refuses to fetch — let
// alone label — any other contract address as USDC: an arbitrary contract's
// balance must never be rebranded as USDC evidence. This constant is
// deliberate and not overridable from caller config.
const AMOY_USDC_CONTRACT = normalizeAddress('0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582');

class CustodyEvidenceError extends Error {
    constructor(code, message, detail) {
        super(message);
        this.name = 'CustodyEvidenceError';
        this.code = code;
        this.detail = detail;
    }
}

const EVIDENCE_ERRORS = {
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    PROVIDER_REJECTED: 'PROVIDER_REJECTED',
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
    CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
};

/** Exact non-negative integer base-unit parse (zero is a legal balance). */
function parseBaseUnitsNonNegative(value, { field = 'balance' } = {}) {
    const str = typeof value === 'string' ? value.trim() : (value != null ? String(value) : '');
    if (!/^\d+$/.test(str)) {
        throw new CustodyEvidenceError(
            EVIDENCE_ERRORS.MALFORMED_RESPONSE,
            `Provider ${field} is not an exact non-negative integer base-unit string ("${str}").`,
            { field, raw: str }
        );
    }
    return BigInt(str);
}

/** Exact decimal-string → base units (e.g. "100.123456" → 100123456n). */
function decimalStringToBaseUnits(value, decimals, { field = 'amount' } = {}) {
    const str = typeof value === 'string' ? value.trim() : String(value ?? '');
    if (!/^\d+(\.\d+)?$/.test(str)) {
        throw new CustodyEvidenceError(
            EVIDENCE_ERRORS.MALFORMED_RESPONSE,
            `Provider ${field} is not an exact non-negative decimal string ("${str}").`,
            { field, raw: str }
        );
    }
    const [intPart, fracPart = ''] = str.split('.');
    if (fracPart.length > decimals) {
        throw new CustodyEvidenceError(
            EVIDENCE_ERRORS.MALFORMED_RESPONSE,
            `Provider ${field} "${str}" exceeds ${decimals} token decimals.`,
            { field, raw: str }
        );
    }
    return BigInt(intPart + fracPart.padEnd(decimals, '0'));
}

function normalizeAddress(address) {
    return String(address || '').toLowerCase().trim();
}

function classifyHttpError(err) {
    const status = err && err.response ? err.response.status : null;
    if (status === 401 || status === 403) {
        return new CustodyEvidenceError(EVIDENCE_ERRORS.PROVIDER_REJECTED, `Provider rejected the request (HTTP ${status}).`, { status });
    }
    if (status === 404) {
        return new CustodyEvidenceError(EVIDENCE_ERRORS.PROVIDER_UNAVAILABLE, 'Provider returned 404 for the requested evidence.', { status });
    }
    if (status === 429) {
        return new CustodyEvidenceError(EVIDENCE_ERRORS.PROVIDER_UNAVAILABLE, 'Provider rate-limited the request (HTTP 429).', { status });
    }
    const msg = (err && err.message) || 'unknown provider error';
    return new CustodyEvidenceError(EVIDENCE_ERRORS.PROVIDER_UNAVAILABLE, `Provider unavailable: ${msg}`, { status });
}

/**
 * ACCOUNT BALANCE provider — GET /v3/blockchain/token/balance/{chain}/{contractAddress}/{address}
 * OpenAPI: Erc20GetBalance → Erc20Balance { balance: string } (smallest token unit).
 */
function createTatumTokenBalanceProvider(config = {}) {
    const baseUrl = config.baseUrl || process.env.TATUM_BASE_URL || 'https://api.tatum.io';
    const apiKey = config.apiKey || process.env.TATUM_API_KEY;
    const http = config.http || axios.create({ baseURL: baseUrl, timeout: config.timeoutMs || 15000 });

    return {
        source: SOURCE_BALANCE,
        async getBalance({ network, contractAddress, address, decimals }) {
            const tatumChain = TATUM_V3_CHAIN[String(network || '').toUpperCase()];
            if (!tatumChain) throw new CustodyEvidenceError(EVIDENCE_ERRORS.CONFIGURATION_ERROR, `No Tatum v3 chain mapping for network ${network}.`);
            if (!apiKey) throw new CustodyEvidenceError(EVIDENCE_ERRORS.CONFIGURATION_ERROR, 'TATUM_API_KEY is not configured — balance evidence is unavailable (fail-closed).');
            const contract = normalizeAddress(contractAddress);
            const addr = normalizeAddress(address);
            let resp;
            try {
                resp = await http.get(`/v3/blockchain/token/balance/${tatumChain}/${contract}/${addr}`, {
                    headers: { 'x-api-key': apiKey },
                });
            } catch (err) {
                throw classifyHttpError(err);
            }
            const payload = resp && resp.data;
            const balance = payload && typeof payload.balance !== 'undefined' ? payload.balance : null;
            // The provider response MUST be tied to what was requested: a
            // response shape we cannot bind to the request is rejected.
            const balanceBaseUnits = parseBaseUnitsNonNegative(balance, { field: 'balance' });
            return {
                source: SOURCE_BALANCE,
                scope: 'ACCOUNT_BALANCE',
                network: String(network || '').toUpperCase(),
                networkScope: 'MAINNET', // the v3 adapter serves canonical mainnet ONLY
                asset: 'USDC',
                contractAddress: contract,
                address: addr,
                balanceBaseUnits,
                observedAt: new Date(),
                blockReference: null, // documented: this source supplies no block reference
                raw: { balance: String(balanceBaseUnits) },
            };
        },
    };
}

/**
 * TESTNET ACCOUNT BALANCE provider — GET /v4/data/wallet/portfolio?chain=polygon-amoy&addresses={address}&tokenTypes=fungible
 * Verified live (2026-10-13) against api.tatum.io with a TESTNET API key:
 *   200 { result: [ { chain, address, balance, denominatedBalance, decimals,
 *                     tokenAddress, type: 'fungible' } ], prevPage, nextPage }
 *     — `balance` is the DENOMINATED decimal string ("20000000008.929275"),
 *       `denominatedBalance` is the EXACT base-unit integer string
 *       ("20000000008929275"), `decimals` is a number (6 for Amoy USDC).
 *     This naming is the REVERSE of the v3 token-balance endpoint (where
 *     `balance` is the base-unit integer). The parser below uses
 *     denominatedBalance as the authority AND cross-checks the decimal form.
 *   A wallet holding no units of the requested token simply has no entry for
 *     it in `result` → zero is a legal observation (recorded as absent).
 *   `tokenTypes` is REQUIRED by the endpoint (native | fungible | nft,multitoken).
 *   The response carries NO block reference; freshness is bounded by
 *     observedAt + the configured freshness window, exactly like the v3 source.
 *
 * SCOPE: TESTNET ONLY (Polygon Amoy). Requests for any other network are a
 * CONFIGURATION_ERROR — this provider structurally cannot produce mainnet
 * evidence, and every observation is branded networkScope: 'TESTNET' plus a
 * source id (TATUM_V4_WALLET_PORTFOLIO_TESTNET) that is distinct from every
 * mainnet source. Downstream mainnet custody accounting rejects TESTNET-scope
 * observations outright (see custodyAccountingService.observeAccountBalance).
 */
function createTatumV4TestnetBalanceProvider(config = {}) {
    const baseUrl = config.baseUrl || process.env.TATUM_BASE_URL || 'https://api.tatum.io';
    // Testnet credentials live SEPARATELY from the production mainnet
    // TATUM_API_KEY. Never place a testnet key in TATUM_API_KEY.
    // Explicit config wins (apiKey: null = deliberately unconfigured, fail
    // closed); only an UNSPECIFIED apiKey falls back to the environment.
    const apiKey = config.apiKey !== undefined ? config.apiKey : (process.env.TATUM_TESTNET_API_KEY || null);
    const http = config.http || axios.create({ baseURL: baseUrl, timeout: config.timeoutMs || 15000 });

    return {
        source: SOURCE_BALANCE_TESTNET,
        networkScope: 'TESTNET',
        async getBalance({ network, contractAddress, address, decimals }) {
            const requested = String(network || '').toUpperCase();
            const tatumChain = TATUM_V4_CHAIN_TESTNET[requested];
            if (!tatumChain) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.CONFIGURATION_ERROR,
                    `createTatumV4TestnetBalanceProvider serves TESTNET only: no mapping for network ${requested} (mainnet evidence must use the mainnet provider).`
                );
            }
            if (!apiKey) throw new CustodyEvidenceError(
                EVIDENCE_ERRORS.CONFIGURATION_ERROR,
                'TATUM_TESTNET_API_KEY is not configured — testnet balance evidence is unavailable (fail-closed).'
            );
            if (!Number.isInteger(decimals) || decimals < 0) throw new CustodyEvidenceError(
                EVIDENCE_ERRORS.CONFIGURATION_ERROR,
                'Testnet balance evidence requires an exact integer token decimals value.'
            );
            const contract = normalizeAddress(contractAddress);
            // §REVIEW-R3: only the canonical Amoy USDC contract may ever be
            // observed under the USDC asset label (see AMOY_USDC_CONTRACT).
            if (contract !== AMOY_USDC_CONTRACT) throw new CustodyEvidenceError(
                EVIDENCE_ERRORS.CONFIGURATION_ERROR,
                `Testnet balance evidence serves the canonical Polygon Amoy USDC contract only — refusing to observe ${contract} under a USDC label.`
            );
            const addr = normalizeAddress(address);
            let resp;
            try {
                resp = await http.get('/v4/data/wallet/portfolio', {
                    params: { chain: tatumChain, addresses: addr, tokenTypes: 'fungible' },
                    headers: { 'x-api-key': apiKey },
                });
            } catch (err) {
                throw classifyHttpError(err);
            }
            const payload = resp && resp.data;
            if (!payload || typeof payload !== 'object' || !Array.isArray(payload.result)) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    'Provider v4 wallet-portfolio payload has no result array.',
                    { payloadType: payload === null ? 'null' : typeof payload }
                );
            }
            // §REVIEW-R2 — response identity BEFORE any absence conclusion:
            // every entry on the page must belong to the requested chain and
            // the requested wallet. A portfolio containing an entry for a
            // different chain or a different address means the provider
            // response cannot be bound to this request, so its "no USDC
            // entry" signal is untrustworthy — fail closed instead of
            // concluding absence.
            for (const e of payload.result) {
                if (!e || typeof e !== 'object') throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    'Provider v4 portfolio entry is not an object.',
                    { entryType: e === null ? 'null' : typeof e }
                );
                if (String(e.chain || '').toLowerCase() !== String(tatumChain).toLowerCase()) {
                    throw new CustodyEvidenceError(
                        EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                        `Provider v4 portfolio page contains an entry for chain ${e.chain} — the request was for ${tatumChain}. Absence cannot be concluded (fail closed).`,
                        { echoedChain: e.chain }
                    );
                }
                if (normalizeAddress(e.address) !== addr) {
                    throw new CustodyEvidenceError(
                        EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                        'Provider v4 portfolio page contains an entry for a different address — absence cannot be concluded (fail closed).',
                        { echoed: e.address }
                    );
                }
                // §REVIEW-R2 (final hardening): the request specifies
                // tokenTypes=fungible, so ANY entry of another type
                // (native, nft, multitoken, unknown) means the provider
                // violated the requested filter — its absence signal is
                // untrustworthy. Reject before absence is concluded. This
                // also covers the matched entry (the loop precedes
                // matching), so a non-fungible entry can never be accepted
                // as the USDC balance either.
                if (e.type !== 'fungible') throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    `Provider returned a portfolio entry of type "${e.type}" despite tokenTypes=fungible — the response violates the requested filter, absence cannot be concluded (fail closed).`,
                    { echoedType: e.type }
                );
            }
            const matches = payload.result.filter((e) => normalizeAddress(e.tokenAddress) === contract);
            if (matches.length > 1) throw new CustodyEvidenceError(
                EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                `Provider v4 portfolio returned ${matches.length} ambiguous entries for the requested token contract.`,
                { matchCount: matches.length }
            );
            const entry = matches[0] || null;
            // §REVIEW-R1 — pagination: absence is only conclusive on a
            // COMPLETE response. The wallet-portfolio API is paginated
            // (verified live: `nextPage` is null/'' when there are no more
            // pages, a non-empty cursor otherwise). If the requested token
            // is not on the fetched page and the provider indicates more
            // pages, the wallet may hold the token on a later page — a zero
            // here would be a FALSE zero. Fail closed instead (review
            // guidance: validate all pages or fail closed on an incomplete
            // response; the conservative branch is fail-closed).
            //
            // §REVIEW-R1 (final hardening): the pagination metadata itself
            // must be PRESENT and well-shaped before absence can become a
            // zero. A response with no `nextPage` field, or with metadata of
            // an invalid shape, gives no completeness signal at all — the
            // documented valid completion values are exactly null and the
            // empty string (both observed live), and a non-empty string is a
            // valid more-pages cursor. Anything else is shape drift and the
            // absence interpretation is refused.
            if (!entry) {
                const nextPage = payload.nextPage;
                if (nextPage === null) {
                    // documented valid completion value — complete page.
                } else if (typeof nextPage === 'string') {
                    if (nextPage !== '') {
                        throw new CustodyEvidenceError(
                            EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                            'Incomplete paginated provider response: the requested token is not on the fetched page and the provider indicates more pages — absence cannot be concluded, refusing to fabricate a zero (fail closed).',
                            { nextPage }
                        );
                    }
                    // '' — documented valid completion value — complete page.
                } else {
                    throw new CustodyEvidenceError(
                        EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                        'Provider response lacks valid pagination metadata (nextPage absent or malformed) — the completeness of the page cannot be established, absence cannot be concluded (fail closed).',
                        { nextPageType: nextPage === undefined ? 'absent/undefined' : typeof nextPage }
                    );
                }
            }
            // Absent token entry = the wallet holds ZERO of the requested
            // token (a legal balance), mirroring the v3 source where a zero
            // balance is returned as "0". Reaching here means the page was
            // complete (no more pages) AND every entry was bound to this
            // request — absence is now a trustworthy zero.
            if (!entry) {
                return {
                    source: SOURCE_BALANCE_TESTNET,
                    scope: 'ACCOUNT_BALANCE',
                    network: requested,
                    networkScope: 'TESTNET',
                    asset: 'USDC',
                    contractAddress: contract,
                    address: addr,
                    balanceBaseUnits: 0n,
                    observedAt: new Date(),
                    blockReference: null,
                    raw: { absent: true, chain: tatumChain },
                };
            }
            // Bind the response to exactly what was requested — fail closed.
            // (The matched entry's fungible TYPE was already enforced by the
            // per-entry validation loop above, which runs before matching.)
            if (String(entry.chain || '').toLowerCase() !== String(tatumChain).toLowerCase()) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    `Provider echoed chain ${entry.chain} for requested chain ${tatumChain}.`,
                    { echoedChain: entry.chain }
                );
            }
            if (normalizeAddress(entry.address) !== addr) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    'Provider v4 portfolio entry address does not match the requested address.',
                    { echoed: entry.address }
                );
            }
            if (entry.decimals !== decimals) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    `Provider decimals ${entry.decimals} does not match the canonical ${decimals}.`,
                    { echoed: entry.decimals }
                );
            }
            const balanceBaseUnits = parseBaseUnitsNonNegative(entry.denominatedBalance, { field: 'denominatedBalance' });
            // Integrity cross-check: the denominated decimal form must be the
            // SAME quantity as the base-unit integer form.
            const denominatedBase = decimalStringToBaseUnits(String(entry.balance ?? ''), decimals, { field: 'balance' });
            if (denominatedBase !== balanceBaseUnits) {
                throw new CustodyEvidenceError(
                    EVIDENCE_ERRORS.MALFORMED_RESPONSE,
                    'Provider balance and denominatedBalance disagree — refusing to bind either.',
                    { balance: entry.balance, denominatedBalance: entry.denominatedBalance }
                );
            }
            return {
                source: SOURCE_BALANCE_TESTNET,
                scope: 'ACCOUNT_BALANCE',
                network: requested,
                networkScope: 'TESTNET',
                asset: 'USDC',
                contractAddress: contract,
                address: addr,
                balanceBaseUnits,
                observedAt: new Date(),
                blockReference: null, // documented: this source supplies no block reference
                raw: { chain: entry.chain, balance: String(entry.balance), denominatedBalance: String(entry.denominatedBalance), decimals: entry.decimals },
            };
        },
    };
}

/**
 * TRANSACTION provider — GET /v4/data/transactions/hash?chain=polygon-mainnet&hash={hash}
 * OpenAPI: GetTransactionsByHash → TxData[] (one entry per involved address).
 */
function createTatumTxByHashProvider(config = {}) {
    const baseUrl = config.baseUrl || process.env.TATUM_BASE_URL || 'https://api.tatum.io';
    const apiKey = config.apiKey || process.env.TATUM_API_KEY;
    const http = config.http || axios.create({ baseURL: baseUrl, timeout: config.timeoutMs || 15000 });

    return {
        source: SOURCE_TX,
        async getTransaction({ network, hash, decimals }) {
            const tatumChain = TATUM_V4_CHAIN[String(network || '').toUpperCase()];
            if (!tatumChain) throw new CustodyEvidenceError(EVIDENCE_ERRORS.CONFIGURATION_ERROR, `No Tatum v4 chain mapping for network ${network}.`);
            if (!apiKey) throw new CustodyEvidenceError(EVIDENCE_ERRORS.CONFIGURATION_ERROR, 'TATUM_API_KEY is not configured — transaction evidence is unavailable (fail-closed).');
            let resp;
            try {
                resp = await http.get('/v4/data/transactions/hash', {
                    params: { chain: tatumChain, hash },
                    headers: { 'x-api-key': apiKey },
                });
            } catch (err) {
                throw classifyHttpError(err);
            }
            const entries = Array.isArray(resp && resp.data) ? resp.data : null;
            if (!entries) {
                throw new CustodyEvidenceError(EVIDENCE_ERRORS.MALFORMED_RESPONSE, 'Provider returned a non-array transactions payload.');
            }
            // Normalize each entry; malformed entries fail closed.
            const normalized = entries.map((e) => {
                const amountBaseUnits = decimalStringToBaseUnits(e.amount, decimals, { field: 'amount' });
                return {
                    chain: e.chain,
                    hash: e.hash != null ? String(e.hash).toLowerCase().trim() : null,
                    address: normalizeAddress(e.address),
                    counterAddress: e.counterAddress ? normalizeAddress(e.counterAddress) : null,
                    tokenAddress: e.tokenAddress ? normalizeAddress(e.tokenAddress) : null,
                    blockNumber: typeof e.blockNumber === 'number' ? e.blockNumber : null,
                    transactionType: e.transactionType,
                    transactionSubtype: e.transactionSubtype,
                    amountBaseUnits,
                    timestamp: typeof e.timestamp === 'number' ? e.timestamp : null,
                };
            });
            return {
                source: SOURCE_TX,
                scope: 'TRANSACTION',
                network: String(network || '').toUpperCase(),
                networkScope: 'MAINNET', // canonical mainnet deposit evidence ONLY
                hash: String(hash || '').toLowerCase(),
                entries: normalized,
                observedAt: new Date(),
            };
        },
    };
}

module.exports = {
    SOURCE_BALANCE,
    SOURCE_TX,
    SOURCE_BALANCE_TESTNET,
    TATUM_V4_CHAIN,
    TATUM_V4_CHAIN_TESTNET,
    EVIDENCE_ERRORS,
    CustodyEvidenceError,
    parseBaseUnitsNonNegative,
    decimalStringToBaseUnits,
    normalizeAddress,
    createTatumTokenBalanceProvider,
    createTatumV4TestnetBalanceProvider,
    createTatumTxByHashProvider,
};
