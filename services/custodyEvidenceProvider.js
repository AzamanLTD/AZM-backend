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
                    hash: e.hash,
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
    EVIDENCE_ERRORS,
    CustodyEvidenceError,
    parseBaseUnitsNonNegative,
    decimalStringToBaseUnits,
    normalizeAddress,
    createTatumTokenBalanceProvider,
    createTatumTxByHashProvider,
};
