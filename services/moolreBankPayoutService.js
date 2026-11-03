// services/moolreBankPayoutService.js
// =============================================================================
// Moolre Ghana BANK PAYOUT provider adapter (channel 2 — Instant Bank Transfer).
//
// PROVIDER BOUNDARY ONLY. This module performs provider I/O and provider-fact
// parsing. It owns no balances, no beneficiaries, no ledger entries, no
// withdrawal orchestration and no routes. Agent A consumes it through the
// MoolreBankPayoutPort contract and remains the settlement authority.
//
// Verified against the machine-readable Moolre API reference on 2026-11-03:
//   GET  /open/transact/data?country=gha&data=banks   → bank directory
//   POST /open/transact/validate                      → account holder name
//   POST /open/transact/transfer                      → bank transfer
//   POST /open/transact/status                        → transfer status
//
// DOCUMENTATION CONFLICT (recorded, not guessed): Moolre's transfer *guide*
// describes /open/transact/initiate and /open/transact/validate-name, while the
// machine-readable per-endpoint reference above (four independent pages, same
// auth/body/response shape) documents /transfer and /validate. The adapter
// follows the machine-readable reference and does NOT silently try both. Sandbox
// confirmation remains outstanding; see docs/MOOLRE_BANK_PAYOUT_CONTRACT.md.
//
// MONEY-SAFETY INVARIANTS (do not weaken):
//   • The caller's referenceId is the economic idempotency key. The adapter
//     never mints, rotates or regenerates it — not on retry, not on timeout.
//   • Unknown outcome never triggers a second payout, a failover payout or an
//     automatic refund. The reconciliation authority resolves it.
//   • No generic HTTP retry is configured for the transfer POST.
//   • Account numbers and API keys never appear in logs or ordinary results.
// =============================================================================

const logger = require('../src/config/logger');
const axios  = require('axios');

const SANDBOX_BASE_URL = 'https://sandbox.moolre.com';
const PROD_BASE_URL    = 'https://api.moolre.com';

const PATHS = Object.freeze({
    DIRECTORY: '/open/transact/data',
    VALIDATE:  '/open/transact/validate',
    TRANSFER:  '/open/transact/transfer',
    STATUS:    '/open/transact/status',
});

// docs.moolre.com/ai/initiate-transfer.html — numeric channel codes.
// 2 = Instant Bank Transfer. Numeric values are required by the provider.
const BANK_CHANNEL = 2;
const TRANSFER_TYPE = 1;
const CURRENCY = 'GHS';
const STATUS_IDTYPE_EXTERNAL_REF = 1;

// data.txstatus is numeric: 0 pending, 1 successful, 2 failed.
const STATUS_MAP = Object.freeze({
    '0': 'PENDING',
    '1': 'SUCCESSFUL',
    '2': 'FAILED',
});

const PROVIDER_OUTCOMES = Object.freeze({
    NOT_DISPATCHED:       'NOT_DISPATCHED',
    DEFINITIVE_REJECTION: 'DEFINITIVE_REJECTION',
    UNKNOWN_OUTCOME:      'UNKNOWN_OUTCOME',
    DUPLICATE_REFERENCE:  'DUPLICATE_REFERENCE',
    STATUS_UNRESOLVED:    'STATUS_UNRESOLVED',
    // Not a dispatch outcome: the provider could not be consulted at all
    // (missing config, directory outage, transport failure before any payout
    // request was attempted). Kept separate so it can never be read as proof
    // about a transfer.
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
});

// Transport codes that PROVABLY occur before any bytes leave the machine.
// 'EAI_AGAIN'/'ENOTFOUND'/'ECONNREFUSED' are DNS/connect refusals. Timeouts and
// resets are deliberately NOT here: they can occur after Moolre accepted the
// request, so they must classify as UNKNOWN_OUTCOME.
const PROVABLY_PRE_DISPATCH = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

const DUPLICATE_REFERENCE_PATTERN =
    /(duplicate|already\s*(exists|used|submitted|processed)|repeated?\s*(external)?ref|externalref.*(exists|used))/i;
const NOT_FOUND_PATTERN = /(not\s*found|no\s*(record|transaction)|does\s*not\s*exist|unknown\s*reference)/i;
const DUPLICATE_REFERENCE_CODE = /^(TP0*(9|14|15)|DUP.*|ERR_DUP.*)$/i;

// Documented refusal codes that prove the request was refused before any payout
// was dispatched. Deliberately narrow: an unrecognised code is never assumed.
const DEFINITIVE_REFUSAL_CODES = new Set(['AVD01', 'AVD02', 'TP01', 'TP02', 'TP03', 'TP04']);

const EXACT_GHS = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;   // ≤ 2 dp pesewa, no exponent, no sign
const MAX_GHS_PESEWAS = 1000000000n * 100n;
const ACCOUNT_NUMBER_PATTERN = /^\d{6,20}$/;           // observed/documented field limit
const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

class MoolreBankPayoutError extends Error {
    constructor(message, { outcome, code, stage, statusCode = null, providerCode = null, cause } = {}) {
        super(message);
        this.name = 'MoolreBankPayoutError';
        this.outcome = outcome;
        this.code = code || outcome;
        this.stage = stage || null;
        this.statusCode = statusCode;
        this.providerCode = providerCode;
        this.retryable = false;      // never auto-retried by this adapter
        this.dispatchProven = outcome === PROVIDER_OUTCOMES.NOT_DISPATCHED
            || outcome === PROVIDER_OUTCOMES.DEFINITIVE_REJECTION;
        if (cause) this.cause = cause;
    }
}

function fail(message, details) {
    throw new MoolreBankPayoutError(message, details);
}

/** Exact pesewa validation. No Number/parseFloat on authoritative values. */
function assertExactGhsAmount(value, stage) {
    if (typeof value !== 'string') {
        fail('amountGhsExact must be a decimal string.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'AMOUNT_NOT_STRING', stage });
    }
    if (!EXACT_GHS.test(value)) {
        fail('amountGhsExact must be a positive amount with at most two decimal places.', {
            outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'AMOUNT_MALFORMED', stage,
        });
    }
    const [whole, frac = ''] = value.split('.');
    const pesewas = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
    if (pesewas <= 0n) {
        fail('amountGhsExact must be greater than zero.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'AMOUNT_NOT_POSITIVE', stage });
    }
    if (pesewas > MAX_GHS_PESEWAS) {
        fail('amountGhsExact exceeds the supported maximum.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'AMOUNT_OVERFLOW', stage });
    }
    return value;
}

function normalizeBankName(name) {
    return String(name).replace(/\s+/g, ' ').trim();
}

class MoolreBankPayoutService {
    /**
     * @param {object} [opts]
     * @param {object} [opts.http]          axios-compatible client (tests inject a fake)
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.cacheTtlMs]    fresh window for the bank directory
     * @param {number} [opts.staleWindowMs] how long expired directory data may still be served, labelled stale
     * @param {number} [opts.timeoutMs]
     */
    constructor(opts = {}) {
        this.apiUser       = opts.apiUser       || process.env.MOOLRE_API_USER || null;
        this.apiKey        = opts.apiKey        || process.env.MOOLRE_API_KEY  || null;
        this.accountNumber = opts.accountNumber || process.env.MOOLRE_ACCOUNT_NUMBER || null;

        const useProd = process.env.MOOLRE_ENV === 'production' || process.env.MOOLRE_ENV === 'prod';
        this.baseUrl  = opts.baseUrl || process.env.MOOLRE_BASE_URL || (useProd ? PROD_BASE_URL : SANDBOX_BASE_URL);
        this.mode     = useProd ? 'production' : 'sandbox';

        this.timeoutMs     = opts.timeoutMs     ?? 20000;
        this.cacheTtlMs    = opts.cacheTtlMs    ?? 24 * 60 * 60 * 1000;
        this.staleWindowMs = opts.staleWindowMs ?? 7 * 24 * 60 * 60 * 1000;

        this.http = opts.http || axios;
        this._directoryCache = null;   // { banks, retrievedAt, fetchedAtMs }
    }

    /** Safe diagnostics. Never exposes credentials or account numbers. */
    describe() {
        return {
            provider: 'MOOLRE',
            capability: 'BANK_PAYOUT',
            mode: this.mode,
            baseUrlHost: (() => { try { return new URL(this.baseUrl).host; } catch { return null; } })(),
            credentialsPresent: Boolean(this.apiUser && this.apiKey),
            sourceAccountConfigured: Boolean(this.accountNumber),
            channel: BANK_CHANNEL,
            currency: CURRENCY,
        };
    }

    // ── Bank directory ───────────────────────────────────────────────────────
    async listBanks(options = {}) {
        const now = Date.now();
        const cache = this._directoryCache;
        const fresh = cache && (now - cache.fetchedAtMs) < this.cacheTtlMs;

        if (cache && fresh && !options.forceRefresh) {
            return this._directoryResult(cache, false);
        }

        try {
            // The reference documents no auth header for this endpoint, so no
            // credential is sent and none is placed in the query string.
            const response = await this.http.get(this.baseUrl + PATHS.DIRECTORY, {
                params: { country: 'gha', data: 'banks' },
                timeout: Math.min(this.timeoutMs, 15000),
                validateStatus: () => true,
            });

            if (!response || response.status < 200 || response.status >= 300) {
                fail('Bank directory request failed.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_HTTP', statusCode: response ? response.status : null, stage: 'DIRECTORY' });
            }

            const banks = this._parseDirectory(response.data);
            this._directoryCache = { banks, retrievedAt: new Date(now).toISOString(), fetchedAtMs: now };
            return this._directoryResult(this._directoryCache, false);
        } catch (err) {
            const cachedUsable = cache && (now - cache.fetchedAtMs) < this.staleWindowMs;
            if (cachedUsable) {
                // Stale, explicitly labelled. Callers that need current data
                // (validation, transfer) fail closed on `stale: true`.
                logger.warn({ stage: 'DIRECTORY', cacheAgeMs: now - cache.fetchedAtMs }, '[MoolreBankPayout] directory unavailable; serving stale cache');
                return this._directoryResult(cache, true);
            }
            if (err instanceof MoolreBankPayoutError) throw err;
            fail('Bank directory unavailable.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_UNAVAILABLE', stage: 'DIRECTORY', cause: err });
        }
    }

    _directoryResult(cache, stale) {
        return {
            banks: cache.banks.map((b) => ({ code: b.code, name: b.name })),
            retrievedAt: cache.retrievedAt,
            source: 'MOOLRE',
            stale,
            cacheAgeMs: Date.now() - cache.fetchedAtMs,
        };
    }

    _parseDirectory(body) {
        const envelope = body || {};
        const statusOk = envelope.status === 1 || envelope.status === '1';
        if (!statusOk) {
            fail('Provider did not return a bank directory.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_STATUS', providerCode: envelope.code || null, stage: 'DIRECTORY' });
        }
        if (!Array.isArray(envelope.data) || envelope.data.length === 0) {
            fail('Bank directory was empty or not an array.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_SHAPE', stage: 'DIRECTORY' });
        }

        const byCode = new Map();
        for (const row of envelope.data) {
            if (!row || typeof row !== 'object') continue;
            const name = typeof row.name === 'string' ? normalizeBankName(row.name) : '';
            // Codes stay strings: leading zeroes are part of the code.
            const code = row.code === undefined || row.code === null ? '' : String(row.code).trim();
            if (!name || !code) continue;            // malformed row: skip, never invent
            if (!byCode.has(code)) byCode.set(code, { code, name });
        }
        if (byCode.size === 0) {
            fail('Bank directory had no usable rows.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_EMPTY', stage: 'DIRECTORY' });
        }
        return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    }

    // ── Account validation ───────────────────────────────────────────────────
    async validateBankAccount(input = {}) {
        const config = this._requireConfig('VALIDATE');
        const accountNumber = this._requireAccountNumber(input.accountNumber);
        const bankCode = this._requireBankCode(input.bankCode);

        // Validate only against current provider data: stale or unavailable
        // directory means we cannot prove the bank code is current, so we stop.
        const directory = await this.listBanks();
        if (directory.stale) {
            fail('Bank directory is stale, so the bank code cannot be confirmed.', { outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_STALE', stage: 'VALIDATE' });
        }
        if (!directory.banks.some((b) => b.code === bankCode)) {
            fail('Unknown bank code.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'BANK_CODE_UNKNOWN', stage: 'VALIDATE' });
        }

        const response = await this._post(PATHS.VALIDATE, {
            type: TRANSFER_TYPE,
            channel: String(BANK_CHANNEL),
            currency: CURRENCY,
            receiver: accountNumber,
            sublistid: bankCode,
            accountnumber: config.accountNumber,
        }, 'VALIDATE');

        const envelope = response.body || {};
        const statusOk = envelope.status === 1 || envelope.status === '1';

        if (response.status >= 200 && response.status < 300 && statusOk
            && typeof envelope.data === 'string' && envelope.data.trim()) {
            logger.info({ stage: 'VALIDATE', providerCode: envelope.code || null, bankCode }, '[MoolreBankPayout] account validated');
            return {
                valid: true,
                accountName: envelope.data.replace(/\s+/g, ' ').trim(),
                bankCode,
                validatedAt: new Date().toISOString(),
                provider: 'MOOLRE',
            };
        }

        // A provider answer that refuses the account is a definitive validation
        // refusal (no money moved). Transport/config problems never get here.
        if (response.status >= 200 && response.status < 500 && !statusOk) {
            fail('Provider could not validate this bank account.', {
                outcome: PROVIDER_OUTCOMES.DEFINITIVE_REJECTION,
                code: 'ACCOUNT_NOT_VALID',
                providerCode: envelope.code || null,
                statusCode: response.status,
                stage: 'VALIDATE',
            });
        }
        fail('Validation response could not be interpreted.', {
            outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'VALIDATE_UNRESOLVED', statusCode: response.status, stage: 'VALIDATE',
        });
    }

    // ── Transfer initiation ──────────────────────────────────────────────────
    async initiateBankTransfer(input = {}) {
        const config = this._requireConfig('INITIATE');
        const referenceId = this._requireReference(input.referenceId);
        const amount = assertExactGhsAmount(input.amountGhsExact, 'INITIATE');
        const accountNumber = this._requireAccountNumber(input.recipientAccountNumber);
        const bankCode = this._requireBankCode(input.bankCode);

        const directory = await this.listBanks();
        if (directory.stale) {
            fail('Bank directory is stale, so the bank code cannot be confirmed.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'DIRECTORY_STALE', stage: 'INITIATE' });
        }
        if (!directory.banks.some((b) => b.code === bankCode)) {
            fail('Unknown bank code.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'BANK_CODE_UNKNOWN', stage: 'INITIATE' });
        }

        const body = {
            type: TRANSFER_TYPE,
            channel: String(BANK_CHANNEL),
            currency: CURRENCY,
            amount,
            receiver: accountNumber,
            sublistid: bankCode,
            externalref: referenceId,      // the caller's identity, unchanged
            accountnumber: config.accountNumber,
        };
        const narration = input.payerMessage || input.payeeNote;
        if (narration) body.reference = String(narration).slice(0, 100);

        const response = await this._post(PATHS.TRANSFER, body, 'INITIATE');
        const envelope = response.body || {};
        const providerCode = envelope.code ? String(envelope.code) : null;
        const providerMessage = Array.isArray(envelope.message) ? envelope.message.join(' ') : String(envelope.message || '');

        // A duplicate externalref is its own outcome: the caller must look the
        // original reference up. The adapter never issues a second transfer.
        if ((providerCode && DUPLICATE_REFERENCE_CODE.test(providerCode)) || DUPLICATE_REFERENCE_PATTERN.test(providerMessage)) {
            fail('Moolre already holds this external reference.', {
                outcome: PROVIDER_OUTCOMES.DUPLICATE_REFERENCE, code: 'DUPLICATE_REFERENCE', providerCode, statusCode: response.status, stage: 'INITIATE',
            });
        }

        const statusOk = envelope.status === 1 || envelope.status === '1';
        if (response.status >= 200 && response.status < 300 && statusOk && envelope.data && typeof envelope.data === 'object') {
            const data = envelope.data;
            const mapped = STATUS_MAP[String(data.txstatus)];
            const fees = {
                amountFee: data.amountfee === undefined ? null : String(data.amountfee),
                networkFee: data.networkfee === undefined ? null : String(data.networkfee),
                fee: data.fee === undefined ? null : String(data.fee),
            };
            logger.info({ stage: 'INITIATE', referenceId, providerCode, txstatus: data.txstatus === undefined ? null : String(data.txstatus) }, '[MoolreBankPayout] transfer request accepted');
            return {
                provider: 'MOOLRE_DISBURSEMENT',
                referenceId: data.externalref ? String(data.externalref) : referenceId,
                providerRef: data.transactionid ? String(data.transactionid) : (data.thirdpartyref ? String(data.thirdpartyref) : null),
                status: mapped || 'PENDING',
                amountGhsExact: data.amount !== undefined && data.amount !== null ? String(data.amount) : amount,
                currency: CURRENCY,
                // Provider facts, preserved losslessly. The adapter does not
                // decide which of these is the customer fee, and never sums them.
                fees,
                providerStatusRaw: data.txstatus === undefined ? null : String(data.txstatus),
            };
        }

        // A malformed 2xx body is uncertainty about a request that may already
        // have been received — never a failure.
        if (response.status >= 200 && response.status < 300) {
            fail('Moolre returned an unreadable transfer response.', { outcome: PROVIDER_OUTCOMES.UNKNOWN_OUTCOME, code: 'INITIATE_MALFORMED', providerCode, statusCode: response.status, stage: 'INITIATE' });
        }

        if (response.status >= 400 && response.status < 500 && providerCode && DEFINITIVE_REFUSAL_CODES.has(providerCode)) {
            fail(providerMessage || 'Moolre refused the transfer.', {
                outcome: PROVIDER_OUTCOMES.DEFINITIVE_REJECTION, code: 'PROVIDER_REFUSED', providerCode, statusCode: response.status, stage: 'INITIATE',
            });
        }

        // Everything else — unknown 4xx, 5xx, auth/config errors — may or may
        // not have been accepted. Never guessed, never retried here.
        fail(providerMessage || 'Moolre transfer outcome is unknown.', {
            outcome: PROVIDER_OUTCOMES.UNKNOWN_OUTCOME, code: 'INITIATE_UNCERTAIN', providerCode, statusCode: response.status, stage: 'INITIATE',
        });
    }

    // ── Status lookup ────────────────────────────────────────────────────────
    async getBankTransferStatus(input = {}) {
        const referenceId = this._requireReference(input.referenceId);
        try {
            const config = this._requireConfig('STATUS');
            const response = await this._post(PATHS.STATUS, {
                type: TRANSFER_TYPE,
                idtype: STATUS_IDTYPE_EXTERNAL_REF,
                id: referenceId,
                accountnumber: config.accountNumber,
            }, 'STATUS');

            const envelope = response.body || {};
            const providerCode = envelope.code ? String(envelope.code) : null;
            const providerMessage = Array.isArray(envelope.message) ? envelope.message.join(' ') : String(envelope.message || '');
            const statusOk = envelope.status === 1 || envelope.status === '1';

            if (response.status >= 200 && response.status < 300 && statusOk && envelope.data && typeof envelope.data === 'object') {
                const mapped = STATUS_MAP[String(envelope.data.txstatus)];
                if (mapped) {
                    return {
                        status: mapped,
                        referenceId,
                        providerRef: envelope.data.transactionid ? String(envelope.data.transactionid) : null,
                        providerStatusRaw: String(envelope.data.txstatus),
                    };
                }
                return { status: 'UNRESOLVED', referenceId, providerRef: null, reason: 'STATUS_FIELD_UNRECOGNISED' };
            }

            // Authoritative not-found only when the provider says so explicitly.
            if (response.status >= 200 && response.status < 500 && !statusOk
                && (NOT_FOUND_PATTERN.test(providerMessage) || (providerCode && /NOTFOUND|NOT_FOUND|NF/i.test(providerCode)))) {
                return { status: 'NOT_FOUND', referenceId, providerRef: null, providerCode };
            }

            return { status: 'UNRESOLVED', referenceId, providerRef: null, reason: 'PROVIDER_ANSWER_NOT_AUTHORITATIVE', providerCode };
        } catch (err) {
            if (err instanceof MoolreBankPayoutError && err.outcome === PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE) {
                // Auth/config/transport failure: we learned nothing about the transfer.
                return { status: 'UNRESOLVED', referenceId, providerRef: null, reason: err.code, providerCode: err.providerCode || null };
            }
            if (err instanceof MoolreBankPayoutError) throw err;
            return { status: 'UNRESOLVED', referenceId, providerRef: null, reason: 'STATUS_LOOKUP_FAILED' };
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────
    _requireConfig(stage) {
        if (!this.apiUser || !this.apiKey || !this.accountNumber) {
            // Fail closed BEFORE any provider I/O. Never fabricate a payout.
            fail('Moolre bank payout is not configured.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'PROVIDER_NOT_CONFIGURED', stage });
        }
        return { apiUser: this.apiUser, apiKey: this.apiKey, accountNumber: this.accountNumber };
    }

    _requireReference(value) {
        if (typeof value !== 'string' || !REFERENCE_PATTERN.test(value)) {
            fail('referenceId is required and must be a stable caller-supplied reference.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'REFERENCE_INVALID', stage: 'VALIDATE' });
        }
        return value;
    }

    _requireAccountNumber(value) {
        if (typeof value !== 'string' || !ACCOUNT_NUMBER_PATTERN.test(value)) {
            fail('A bank account number is required.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'ACCOUNT_NUMBER_INVALID', stage: 'VALIDATE' });
        }
        return value;   // preserved verbatim: leading zeroes matter
    }

    _requireBankCode(value) {
        if (typeof value !== 'string' || !value.trim()) {
            fail('A Moolre bank code is required.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'BANK_CODE_INVALID', stage: 'VALIDATE' });
        }
        return value.trim();
    }

    async _post(path, body, stage) {
        const config = this._requireConfig(stage);
        try {
            const response = await this.http.post(this.baseUrl + path, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-USER': config.apiUser,
                    'X-API-KEY': config.apiKey,
                },
                timeout: this.timeoutMs,
                validateStatus: () => true,   // classification is ours, not axios's
                maxContentLength: 1024 * 1024,
            });
            return { status: response.status, body: response.data };
        } catch (err) {
            const transport = err && (err.code || (err.cause && err.cause.code)) || null;
            const provablyPreDispatch = transport && PROVABLY_PRE_DISPATCH.has(transport);
            // No generic retry: axios is called once, with a finite timeout.
            logger.warn({ stage, transport: transport || 'unknown' }, '[MoolreBankPayout] provider transport failure');
            if (provablyPreDispatch && stage !== 'STATUS') {
                fail('Moolre could not be reached; nothing was dispatched.', { outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED, code: 'TRANSPORT_PRE_DISPATCH', cause: err, stage });
            }
            fail('Moolre did not answer definitively.', {
                outcome: stage === 'STATUS' ? PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE : PROVIDER_OUTCOMES.UNKNOWN_OUTCOME,
                code: 'TRANSPORT_UNCERTAIN', cause: err, stage,
            });
        }
    }
}

module.exports = MoolreBankPayoutService;
module.exports.PROVIDER_OUTCOMES = PROVIDER_OUTCOMES;
module.exports.MoolreBankPayoutError = MoolreBankPayoutError;
module.exports.CHANNEL = BANK_CHANNEL;
module.exports.PATHS = PATHS;
