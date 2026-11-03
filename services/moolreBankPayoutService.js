// services/moolreBankPayoutService.js
// =============================================================================
// Moolre Ghana BANK PAYOUT provider adapter (channel 2 / Instant Bank Transfer).
//
// PROVIDER BOUNDARY ONLY. This module owns Moolre's bank API: the bank
// directory, account-name validation, transfer initiation and transfer status.
// It owns no balances, no beneficiaries, no ledger, no routes and no
// reconciliation. Agent A's financial authority decides what money means; this
// adapter only reports, as exactly as the provider allows, what Moolre received
// and what Moolre said.
//
// ── WHAT THIS ADAPTER DELIBERATELY NEVER DOES ───────────────────────────────
//   * never generates, rotates or substitutes the caller's external reference;
//   * never retries a transfer POST (no axios retry middleware anywhere);
//   * never treats a timeout, reset, 5xx or malformed body as "not sent";
//   * never invents a fee, a total, an amount, a bank or an account name;
//   * never claims customer settlement — provider status is a provider fact.
//
// ── DOCUMENTED CONTRACT (retrieved 2026-11-03, docs.moolre.com/ai/*) ────────
//   GET  /open/transact/data?country=gha&data=banks   bank directory
//   POST /open/transact/validate                      account name  (data = name)
//   POST /open/transact/transfer                      channel "2", sublistid = bank code
//   POST /open/transact/status                        idtype 1 = our externalref
//
//   The guide at docs.moolre.com/guides/transfers/ names /open/transact/initiate
//   and /open/transact/validate-name instead. That page returned no readable
//   body when fetched, so the conflict is UNRESOLVED, not disproved. This
//   adapter implements ONLY the machine-readable paths above and never tries a
//   second path: sending one payout to two endpoints would be a double payout.
//
// ── EVIDENCE STATE — read before trusting anything here ─────────────────────
//   * Fixture-tested only. No sandbox call has been made with Azaman
//     credentials; no live payout has ever been attempted.
//   * Whether channel 2 is enabled on Azaman's Moolre account is UNKNOWN and
//     must not be assumed from these docs.
//   * No transfer refusal code and no status not-found code is verified, so the
//     sets below are EMPTY and every ambiguous provider answer is classified
//     UNKNOWN/UNRESOLVED rather than "refused" or "not found". A wrong
//     "not found" would authorise a refund of money that already left.
// =============================================================================

const logger = require('../src/config/logger');
const axios = require('axios');

// ── Endpoints ───────────────────────────────────────────────────────────────
const PATHS = Object.freeze({
    DIRECTORY: '/open/transact/data',
    VALIDATE:  '/open/transact/validate',
    TRANSFER:  '/open/transact/transfer',
    STATUS:    '/open/transact/status',
});
const SANDBOX_BASE = 'https://sandbox.moolre.com';
const PRODUCTION_BASE = 'https://api.moolre.com';
const ALLOWED_HOSTS = Object.freeze(['sandbox.moolre.com', 'api.moolre.com']);

const BANK_CHANNEL = '2';
const CURRENCY = 'GHS';

// The ONLY transfer-status value with published meaning: the Transfer Status
// reference's successful example. 0 and 2 are deliberately absent - see
// _mapStatus() and docs/MOOLRE_BANK_PAYOUT_CONTRACT.md section 4.
const VERIFIED_SUCCESS_STATUS = '1';
const PROVIDER = 'MOOLRE';
const PROVIDER_RAIL = 'MOOLRE_DISBURSEMENT';

// ── Outcome taxonomy (shared vocabulary with the MoMo adapter) ──────────────
const PROVIDER_OUTCOMES = Object.freeze({
    NOT_DISPATCHED:       'NOT_DISPATCHED',        // proven: no payout instruction left Azaman
    DEFINITIVE_REJECTION: 'DEFINITIVE_REJECTION',  // documented provider refusal, no payout
    UNKNOWN_OUTCOME:      'UNKNOWN_OUTCOME',       // may or may not have reached Moolre
    DUPLICATE_REFERENCE:  'DUPLICATE_REFERENCE',   // Moolre already holds this externalref
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',  // capability/config/auth problem, no I/O outcome
});

// Transport failures that provably happen before any byte of the request can
// be accepted (name resolution and connection setup). Deliberately narrow:
// ECONNRESET, EPIPE and timeouts are NOT here, because the request may have
// been transmitted and accepted.
const PROVABLY_PRE_DISPATCH = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Transfer refusal codes, each needing published or written provider evidence.
// EMPTY until such evidence exists (see the evidence note above).
const DOCUMENTED_TRANSFER_REFUSALS = new Set([]);
// Status codes that authoritatively mean "Moolre has no such transfer".
const DOCUMENTED_STATUS_NOT_FOUND = new Set([]);
// Codes that mean the external reference is already in use. Empty for the same
// reason: the duplicate MESSAGE shape is matched instead, and only ever to
// refuse a second send, never to assert success.
const DUPLICATE_HINT = /(duplicate|already\s*(exists|used|processed)|re-?use[ds]?\s*(of\s*)?(the\s*)?(same\s*)?(external)?\s*ref)/i;

// Azaman-side safety bound, NOT a Moolre rule. Moolre's published references do
// not state an account-number length or character rule; this bound exists only
// to stop absurd input and is documented as ours, not theirs.
const ACCOUNT_NUMBER_SAFETY = /^[0-9]{6,20}$/;
// Pesewa-exact decimal string: no sign, no exponent, no whitespace, no commas,
// at most two decimals, no leading zeroes beyond "0.x".
const EXACT_GHS = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;
// Local ceiling: GHS 1,000,000.00 per instruction. Documented as an Azaman
// safety bound; Moolre's own per-transaction limits are unconfirmed.
const MAX_GHS_PESEWA = 100000000n;

/** Typed provider error — the only thing this adapter throws for provider I/O. */
class MoolreBankPayoutError extends Error {
    constructor(message, {
        outcome,
        code,
        stage,
        referenceId = null,
        providerCode = null,
        details = null,
        refusalDocumented = false,
    }) {
        super(message);
        this.name = 'MoolreBankPayoutError';
        this.provider = PROVIDER_RAIL;
        this.outcome = outcome;
        // Existing MoMo/failover callers read `providerOutcome`. Keep both names
        // pointing at one value so the two adapters cannot disagree.
        this.providerOutcome = outcome;
        this.code = code;
        this.stage = stage;
        this.referenceId = referenceId || null;
        this.providerCode = providerCode || null;
        this.details = details || null;
        // Nothing here is safe to blind-retry: a retry needs a human or a
        // status lookup against the ORIGINAL reference, never a new one.
        this.retryable = false;
        this.dispatchProven = outcome === PROVIDER_OUTCOMES.NOT_DISPATCHED
            || (outcome === PROVIDER_OUTCOMES.DEFINITIVE_REJECTION && refusalDocumented === true);
    }
}

class MoolreBankPayoutService {
    /**
     * @param {object} [opts]
     * @param {{get:Function, post:Function}} [opts.http] injected transport (tests only)
     * @param {string} [opts.providerMode]   explicit override, else MOOLRE_PROVIDER
     * @param {string} [opts.env]            explicit override, else MOOLRE_ENV
     * @param {boolean}[opts.bankPayoutEnabled] explicit override, else MOOLRE_BANK_PAYOUT_ENABLED
     * @param {string} [opts.baseUrl]        explicit override, else MOOLRE_BASE_URL
     * @param {string} [opts.apiUser]
     * @param {string} [opts.apiKey]
     * @param {string} [opts.accountNumber]  Moolre source account
     * @param {number} [opts.timeoutMs]
     * @param {number} [opts.maxResponseBytes]
     * @param {number} [opts.cacheTtlMs]
     * @param {number} [opts.staleWindowMs]
     * @param {number} [opts.maxGhsPesewa]
     */
    constructor(opts = {}) {
        const env = opts.env ?? process.env.MOOLRE_ENV;
        this._env = String(env || '').toLowerCase() === 'production' ? 'production' : 'sandbox';

        this._providerMode = String(opts.providerMode ?? process.env.MOOLRE_PROVIDER ?? '').toUpperCase();
        this._bankFlagRaw = opts.bankPayoutEnabled ?? process.env.MOOLRE_BANK_PAYOUT_ENABLED;
        this._bankPayoutEnabled = String(this._bankFlagRaw ?? '').toLowerCase() === 'true';

        this._apiUser = opts.apiUser ?? process.env.MOOLRE_API_USER ?? '';
        this._apiKey = opts.apiKey ?? process.env.MOOLRE_API_KEY ?? '';
        this._accountNumber = opts.accountNumber ?? process.env.MOOLRE_ACCOUNT_NUMBER ?? '';

        this._baseUrl = String(
            opts.baseUrl ?? process.env.MOOLRE_BASE_URL ?? (this._env === 'production' ? PRODUCTION_BASE : SANDBOX_BASE)
        ).replace(/\/+$/, '');

        this._timeoutMs = opts.timeoutMs ?? 15000;
        this._maxResponseBytes = opts.maxResponseBytes ?? 256 * 1024;
        this._cacheTtlMs = opts.cacheTtlMs ?? 6 * 60 * 60 * 1000;
        this._staleWindowMs = opts.staleWindowMs ?? 24 * 60 * 60 * 1000;
        this._maxPesewa = opts.maxGhsPesewa ?? MAX_GHS_PESEWA;

        this._http = opts.http || axios;
        this._directoryCache = null;
    }

    // ── configuration / capability ──────────────────────────────────────────

    /** Host of the configured base URL, or null when unparseable. */
    _host() {
        try {
            const u = new URL(this._baseUrl);
            return u.protocol === 'https:' ? u.host : null;
        } catch {
            return null;
        }
    }

    _credentialsPresent() {
        return Boolean(String(this._apiUser).trim() && String(this._apiKey).trim());
    }

    _sourceAccountConfigured() {
        return Boolean(String(this._accountNumber).trim());
    }

    /**
     * ONE authority for "may this adapter talk to Moolre at all?".
     * Every public method reads this; there are no scattered env checks.
     *
     * MOOLRE_PROVIDER=LIVE is necessary but NOT sufficient: the bank capability
     * has its own switch because a business that enabled MoMo payouts has not
     * thereby enabled bank payouts.
     */
    capabilities() {
        const host = this._host();
        const hostAllowed = Boolean(host) && ALLOWED_HOSTS.includes(host);
        const providerIoEnabled = this._providerMode === 'LIVE';
        const credentialsPresent = this._credentialsPresent();
        const sourceAccountConfigured = this._sourceAccountConfigured();

        const canInitiateBankPayout = providerIoEnabled
            && this._bankPayoutEnabled
            && credentialsPresent
            && sourceAccountConfigured
            && hostAllowed;

        const mode = canInitiateBankPayout
            ? (this._env === 'production' ? 'production' : 'sandbox')
            : 'disabled';

        return {
            providerIoEnabled,
            bankPayoutEnabled: this._bankPayoutEnabled,
            credentialsPresent,
            sourceAccountConfigured,
            host,
            hostAllowed,
            canInitiateBankPayout,
            mode,
        };
    }

    /** Safe public description. Never contains a credential or an account number. */
    describe() {
        const c = this.capabilities();
        return {
            provider: PROVIDER,
            capability: 'BANK_PAYOUT',
            mode: c.mode,
            baseUrlHost: c.host,
            providerIoEnabled: c.providerIoEnabled,
            bankPayoutEnabled: c.bankPayoutEnabled,
            credentialsPresent: c.credentialsPresent,
            sourceAccountConfigured: c.sourceAccountConfigured,
            channel: 2,
            currency: CURRENCY,
        };
    }

    _requireCapability(stage, referenceId = null) {
        const c = this.capabilities();
        if (c.canInitiateBankPayout) return c;
        const reason = !c.providerIoEnabled ? 'PROVIDER_IO_DISABLED'
            : !c.bankPayoutEnabled ? 'BANK_PAYOUT_DISABLED'
                : !c.hostAllowed ? 'PROVIDER_HOST_NOT_ALLOWED'
                    : !c.credentialsPresent ? 'PROVIDER_CREDENTIALS_MISSING'
                        : 'PROVIDER_SOURCE_ACCOUNT_MISSING';
        throw new MoolreBankPayoutError('Moolre bank payout is disabled by configuration.', {
            outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED,
            code: reason,
            stage,
            referenceId,
        });
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    async _get(path, { query = null, headers = {} } = {}) {
        if (query) {
            const qs = new URLSearchParams(query).toString();
            path = path + '?' + qs;
        }
        return this._send(() => this._http.get(this._baseUrl + path, {
            headers,
            timeout: this._timeoutMs,
            maxContentLength: this._maxResponseBytes,
            maxBodyLength: this._maxResponseBytes,
            // Classification is ours to make, not the transport's.
            validateStatus: () => true,
        }));
    }

    async _post(path, body, { headers = {} } = {}) {
        return this._send(() => this._http.post(this._baseUrl + path, body, {
            headers: { 'Content-Type': 'application/json', ...headers },
            timeout: this._timeoutMs,
            maxContentLength: this._maxResponseBytes,
            maxBodyLength: this._maxResponseBytes,
            // No axios retry: a transfer POST must never be replayed.
            validateStatus: () => true,
        }));
    }

    async _send(fn) {
        try {
            const res = await fn();
            return res;
        } catch (err) {
            // Rethrow as-is; callers classify with _classifyTransport.
            throw err;
        }
    }

    _authHeaders() {
        return { 'X-API-USER': this._apiUser, 'X-API-KEY': this._apiKey };
    }

    static _parseBody(res) {
        const raw = res && res.data;
        if (raw === undefined || raw === null) return null;
        if (typeof raw === 'object') return raw;
        if (typeof raw === 'string') {
            if (raw.length > 1024 * 1024) return null;
            try { return JSON.parse(raw); } catch { return null; }
        }
        return null;
    }

    /**
     * Classify a transport failure. Only provably-pre-connection codes are
     * NOT_DISPATCHED; everything else is UNKNOWN_OUTCOME because the request
     * may already have reached Moolre.
     */
    _classifyTransport(err, { stage, referenceId, alreadySent }) {
        const transportCode = err && (err.code || err.errno) ? String(err.code || err.errno) : null;
        // The code alone decides: ECONNREFUSED/ENOTFOUND/EAI_AGAIN are
        // connection-setup failures, so no request bytes can have been accepted
        // even though the POST was attempted. Timeouts and resets are excluded
        // above precisely because they cannot prove that.
        const preDispatch = PROVABLY_PRE_DISPATCH.has(transportCode);
        return new MoolreBankPayoutError(
            preDispatch
                ? 'Moolre was unreachable; no payout instruction was sent.'
                : 'Moolre did not answer conclusively; the payout may or may not have been accepted.',
            {
                outcome: preDispatch ? PROVIDER_OUTCOMES.NOT_DISPATCHED : PROVIDER_OUTCOMES.UNKNOWN_OUTCOME,
                code: preDispatch ? 'PROVIDER_UNREACHABLE' : 'PROVIDER_OUTCOME_UNKNOWN',
                stage,
                referenceId,
                providerCode: transportCode,
            }
        );
    }

    // ── money ───────────────────────────────────────────────────────────────

    /** Exact pesewa validation. No Number(), no parseFloat, no rounding. */
    _requireExactGhs(value, { stage, referenceId }) {
        if (typeof value !== 'string') {
            throw this._local('amountGhsExact must be a decimal string.', 'AMOUNT_NOT_STRING', stage, referenceId);
        }
        if (!EXACT_GHS.test(value)) {
            throw this._local('amountGhsExact must be an exact GHS amount (e.g. "25.50").', 'AMOUNT_MALFORMED', stage, referenceId);
        }
        const [whole, frac = ''] = value.split('.');
        const pesewa = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
        if (pesewa <= 0n) {
            throw this._local('amountGhsExact must be greater than zero.', 'AMOUNT_NOT_POSITIVE', stage, referenceId);
        }
        if (pesewa > this._maxPesewa) {
            throw this._local('amountGhsExact exceeds the Azaman per-instruction safety bound.', 'AMOUNT_ABOVE_SAFETY_BOUND', stage, referenceId);
        }
        // Canonical echo: same pesewa value, two decimals, no leading zeroes.
        return (Number(whole) === 0 ? '0' : whole) + '.' + (frac + '00').slice(0, 2);
    }

    _local(message, code, stage, referenceId) {
        return new MoolreBankPayoutError(message, {
            outcome: PROVIDER_OUTCOMES.NOT_DISPATCHED,
            code,
            stage,
            referenceId,
        });
    }

    _requireAccountNumber(value, field, stage, referenceId) {
        if (typeof value !== 'string' || !ACCOUNT_NUMBER_SAFETY.test(value)) {
            throw this._local(
                `${field} must be 6-20 digits (Azaman safety bound; Moolre publishes no format rule).`,
                'ACCOUNT_NUMBER_INVALID', stage, referenceId
            );
        }
        return value;
    }

    _requireReference(value, stage) {
        if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
            throw this._local('referenceId is required and must be at most 64 characters.', 'REFERENCE_REQUIRED', stage, null);
        }
        return value;
    }

    // ── bank directory ──────────────────────────────────────────────────────

    _mapBanks(body) {
        const rows = body && body.data;
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new MoolreBankPayoutError('Moolre bank directory was empty or malformed.', {
                outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_SHAPE', stage: 'DIRECTORY',
            });
        }
        const seen = new Set();
        const banks = [];
        for (const row of rows) {
            const rawCode = row && row.code !== undefined && row.code !== null ? String(row.code).trim() : '';
            const rawName = row && typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ') : '';
            // Strict: one malformed row means the provider changed shape, and
            // silently dropping banks could hide a real institution. Refuse.
            if (!/^[0-9A-Za-z_-]{2,16}$/.test(rawCode) || rawName === '') {
                throw new MoolreBankPayoutError('Moolre bank directory contained a malformed row.', {
                    outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_ROW_MALFORMED', stage: 'DIRECTORY',
                });
            }
            if (seen.has(rawCode)) continue; // deterministic: first occurrence wins
            seen.add(rawCode);
            banks.push({ code: rawCode, name: rawName });
        }
        banks.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        return banks;
    }

    async _fetchDirectory() {
        const res = await this._get(PATHS.DIRECTORY, { query: { country: 'gha', data: 'banks' } });
        const body = MoolreBankPayoutService._parseBody(res);
        if (!body || Number(body.status) !== 1) {
            throw new MoolreBankPayoutError('Moolre bank directory was unavailable.', {
                outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_UNAVAILABLE', stage: 'DIRECTORY',
            });
        }
        return this._mapBanks(body);
    }

    /**
     * Bank directory with a bounded cache. A stale cache is returned ONLY with
     * stale:true, and validation/transfer refuse to use it.
     */
    async listBanks({ forceRefresh = false } = {}) {
        this._requireCapability('DIRECTORY');
        const now = Date.now();
        const cache = this._directoryCache;
        if (!forceRefresh && cache && (now - cache.fetchedAtMs) < this._cacheTtlMs) {
            return this._directoryResult(cache, false, now);
        }
        try {
            const banks = await this._fetchDirectory();
            this._directoryCache = { banks, fetchedAtMs: Date.now(), retrievedAt: new Date().toISOString() };
            return this._directoryResult(this._directoryCache, false, Date.now());
        } catch (err) {
            const age = cache ? now - cache.fetchedAtMs : null;
            if (cache && age !== null && age < this._staleWindowMs) {
                logger.warn({ stage: 'DIRECTORY', cacheAgeMs: age }, '[MoolreBankPayout] directory unavailable; serving explicitly stale cache');
                return this._directoryResult(cache, true, now);
            }
            throw err instanceof MoolreBankPayoutError ? err : new MoolreBankPayoutError('Moolre bank directory was unavailable.', {
                outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_UNAVAILABLE', stage: 'DIRECTORY',
            });
        }
    }

    _directoryResult(cache, stale, now) {
        return {
            banks: cache.banks.map(b => ({ ...b })),
            retrievedAt: cache.retrievedAt,
            source: PROVIDER,
            stale,
            cacheAgeMs: Math.max(0, now - cache.fetchedAtMs),
        };
    }

    /**
     * Fresh directory for validation/transfer. Never returns stale data:
     * a bank code validated against yesterday's list is not evidence.
     */
    async _freshDirectory(stage) {
        const now = Date.now();
        const cache = this._directoryCache;
        if (cache && (now - cache.fetchedAtMs) < this._cacheTtlMs) return cache.banks;
        try {
            const banks = await this._fetchDirectory();
            this._directoryCache = { banks, fetchedAtMs: Date.now(), retrievedAt: new Date().toISOString() };
            return banks;
        } catch (err) {
            if (cache) {
                throw new MoolreBankPayoutError('Bank directory is stale; refusing to validate or pay against it.', {
                    outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_STALE', stage,
                });
            }
            throw err instanceof MoolreBankPayoutError ? err : new MoolreBankPayoutError('Moolre bank directory was unavailable.', {
                outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, code: 'DIRECTORY_UNAVAILABLE', stage,
            });
        }
    }

    async _requireKnownBank(bankCode, stage, referenceId) {
        if (typeof bankCode !== 'string' || !/^[0-9A-Za-z_-]{2,16}$/.test(bankCode)) {
            throw this._local('bankCode is required (Moolre bank code from the directory).', 'BANK_CODE_INVALID', stage, referenceId);
        }
        const banks = await this._freshDirectory(stage);
        if (!banks.some(b => b.code === bankCode)) {
            throw this._local('bankCode is not in the current Moolre bank directory.', 'BANK_CODE_UNKNOWN', stage, referenceId);
        }
        return bankCode;
    }

    // ── account validation ──────────────────────────────────────────────────

    async validateBankAccount({ accountNumber, bankCode } = {}) {
        this._requireCapability('VALIDATE');
        const account = this._requireAccountNumber(accountNumber, 'accountNumber', 'VALIDATE', null);
        await this._requireKnownBank(bankCode, 'VALIDATE', null);

        let res;
        try {
            res = await this._post(PATHS.VALIDATE, {
                type: 1,
                channel: BANK_CHANNEL,
                currency: CURRENCY,
                receiver: account,
                sublistid: bankCode,
                accountnumber: this._accountNumber,
            }, { headers: this._authHeaders() });
        } catch (err) {
            // A transport failure says nothing about the account. Validation is
            // not a dispatch, so it is provider unavailability — never "invalid".
            const classified = this._classifyTransport(err, { stage: 'VALIDATE', referenceId: null, alreadySent: false });
            throw new MoolreBankPayoutError('Moolre could not confirm that account.', {
                outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE,
                code: 'VALIDATION_UNDETERMINED',
                stage: 'VALIDATE',
                providerCode: classified.providerCode,
            });
        }

        const body = MoolreBankPayoutService._parseBody(res);
        const providerCode = body && body.code ? String(body.code) : null;
        const status = body && (res.status >= 200 && res.status < 300) ? Number(body.status) : NaN;

        if (status === 1 && typeof body.data === 'string' && body.data.trim() !== '') {
            return {
                valid: true,
                accountName: body.data.trim().replace(/\s+/g, ' '),
                bankCode,
                validatedAt: new Date().toISOString(),
                provider: PROVIDER,
            };
        }
        // AVD02 is the provider's documented account-not-found answer.
        if (providerCode === 'AVD02') {
            throw new MoolreBankPayoutError('Moolre could not resolve that account at this bank.', {
                outcome: PROVIDER_OUTCOMES.DEFINITIVE_REJECTION,
                code: 'ACCOUNT_NOT_FOUND',
                stage: 'VALIDATE',
                providerCode,
                refusalDocumented: true,
            });
        }
        // Auth, rate limits, 5xx, unknown shapes: NOT evidence the account is
        // invalid, and not evidence it is valid either.
        throw new MoolreBankPayoutError('Moolre could not confirm that account.', {
            outcome: PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE,
            code: 'VALIDATION_UNDETERMINED',
            stage: 'VALIDATE',
            providerCode,
        });
    }

    // ── transfer initiation ─────────────────────────────────────────────────

    /**
     * Initiate one bank payout.
     *
     * CALL-SHAPE CONTRACT (agreed with Agent A on PR #392):
     *   canonical: { referenceId, amountGhsExact, recipientAccountNumber,
     *                bankCode, payerMessage?, payeeNote? }
     *   accepted aliases from the settled consumer call site:
     *                amountGhs -> amountGhsExact
     *                accountNumber -> recipientAccountNumber
     *                narration -> payerMessage
     *   When both spellings are present they must AGREE exactly; a disagreement
     *   is refused rather than resolved silently (amounts are money).
     *
     * RETURNS a provider fact object. THROWS only when no payout can exist:
     * NOT_DISPATCHED, DEFINITIVE_REJECTION (refusal not yet documented), or
     * PROVIDER_UNAVAILABLE. An UNKNOWN outcome or a DUPLICATE reference is
     * RETURNED as status:'UNRESOLVED' with reason set, never thrown, because a
     * caller that reverses on error would pay twice.
     */
    async initiateBankTransfer(input = {}) {
        const referenceId = this._requireReference(input.referenceId, 'INITIATE');
        this._requireCapability('INITIATE', referenceId);

        const amountIn = this._pickAlias(input, 'amountGhsExact', 'amountGhs', referenceId);
        const accountIn = this._pickAlias(input, 'recipientAccountNumber', 'accountNumber', referenceId);
        const narration = this._pickAlias(input, 'payerMessage', 'narration', referenceId, { optional: true });

        const amountExact = this._requireExactGhs(amountIn, { stage: 'INITIATE', referenceId });
        const account = this._requireAccountNumber(accountIn, 'recipientAccountNumber', 'INITIATE', referenceId);
        const bankCode = input.bankCode;
        await this._requireKnownBank(bankCode, 'INITIATE', referenceId);

        const payload = {
            type: 1,
            channel: BANK_CHANNEL,
            currency: CURRENCY,
            amount: amountExact,
            receiver: account,
            sublistid: bankCode,
            externalref: referenceId,
            accountnumber: this._accountNumber,
        };
        if (typeof narration === 'string' && narration.trim() !== '') {
            payload.reference = narration.trim().slice(0, 100);
        }

        let res;
        try {
            res = await this._post(PATHS.TRANSFER, payload, { headers: this._authHeaders() });
        } catch (err) {
            const classified = this._classifyTransport(err, { stage: 'INITIATE', referenceId, alreadySent: true });
            // Ambiguity is returned, not thrown: nothing may authorise a reversal.
            if (classified.outcome === PROVIDER_OUTCOMES.UNKNOWN_OUTCOME) {
                logger.warn({ referenceId, stage: 'INITIATE', providerCode: classified.providerCode },
                    '[MoolreBankPayout] transfer outcome unknown; caller must reconcile by reference');
                return this._unresolved(referenceId, { reason: 'PROVIDER_OUTCOME_UNKNOWN', providerCode: classified.providerCode });
            }
            throw classified;
        }

        const body = MoolreBankPayoutService._parseBody(res);
        const httpOk = res && res.status >= 200 && res.status < 300;
        const providerCode = body && body.code ? String(body.code) : null;
        const message = body && (body.message || (Array.isArray(body.message) ? body.message.join(' ') : '')) || '';

        // Duplicate reference: Moolre already holds this externalref. One POST
        // happened; the caller must look this reference up, never resend.
        if (DUPLICATE_HINT.test(String(message))) {
            return this._unresolved(referenceId, { reason: 'DUPLICATE_REFERENCE', providerCode });
        }

        if (!httpOk || !body) {
            // 5xx / unknown 4xx / unparseable body after a POST: never "refused".
            return this._unresolved(referenceId, {
                reason: httpOk ? 'MALFORMED_PROVIDER_RESPONSE' : 'PROVIDER_NON_2XX',
                providerCode,
                httpStatus: res ? res.status : null,
            });
        }

        const data = body.data && typeof body.data === 'object' ? body.data : null;
        const nestedRaw = data && data.txstatus !== undefined && data.txstatus !== null ? String(data.txstatus) : null;
        const echoedRef = data && typeof data.externalref === 'string' ? data.externalref : null;

        if (Number(body.status) !== 1 || !data) {
            // An explicit refusal we cannot yet prove: stay uncertain unless the
            // code has published evidence.
            if (providerCode && DOCUMENTED_TRANSFER_REFUSALS.has(providerCode)) {
                throw new MoolreBankPayoutError('Moolre refused the transfer.', {
                    outcome: PROVIDER_OUTCOMES.DEFINITIVE_REJECTION,
                    code: 'PROVIDER_REFUSED',
                    stage: 'INITIATE',
                    referenceId,
                    providerCode,
                    refusalDocumented: true,
                });
            }
            return this._unresolved(referenceId, { reason: 'PROVIDER_STATUS_NOT_ACCEPTED', providerCode });
        }

        if (echoedRef !== null && echoedRef !== referenceId) {
            // Evidence contradiction: never silently adopt a different reference.
            logger.error({ referenceId, stage: 'INITIATE' }, '[MoolreBankPayout] provider echoed a different external reference');
            return this._unresolved(referenceId, { reason: 'EXTERNAL_REFERENCE_MISMATCH', providerCode });
        }

        const mapped = this._mapStatus(nestedRaw);
        const observation = {
            provider: PROVIDER_RAIL,
            rail: 'BANK',
            referenceId,
            externalId: echoedRef,
            providerRef: this._providerRef(data),
            amountGhsExact: this._exactString(data.amount),
            currency: CURRENCY,
            fees: {
                amountFee: this._exactString(data.amountfee),
                networkFee: this._exactString(data.networkfee),
                fee: this._exactString(data.fee),
            },
            providerStatusRaw: nestedRaw,
        };

        if (mapped === 'UNRESOLVED') {
            // Moolre accepted something, but the status value has no published
            // meaning, so this is an unresolved observation with every provider
            // fact retained. It is NOT a failure and must never be reversed.
            return {
                ...observation,
                status: 'UNRESOLVED',
                reason: 'STATUS_SEMANTICS_UNPROVEN',
            };
        }

        return { ...observation, status: mapped };
    }

    _pickAlias(input, canonical, alias, referenceId, { optional = false } = {}) {
        const a = input[canonical];
        const b = input[alias];
        if (a !== undefined && b !== undefined && a !== b) {
            throw this._local(`${canonical} and its alias ${alias} disagree.`, 'ARGUMENT_ALIAS_CONFLICT', 'INITIATE', referenceId);
        }
        const value = a !== undefined ? a : b;
        if (value === undefined || value === null || value === '') {
            if (optional) return null;
            throw this._local(`${canonical} is required.`, 'ARGUMENT_MISSING', 'INITIATE', referenceId);
        }
        return value;
    }

    _unresolved(referenceId, { reason, providerCode = null, httpStatus = null }) {
        return {
            provider: PROVIDER_RAIL,
            rail: 'BANK',
            referenceId,
            externalId: null,
            providerRef: null,
            status: 'UNRESOLVED',
            amountGhsExact: null,
            currency: CURRENCY,
            fees: { amountFee: null, networkFee: null, fee: null },
            providerStatusRaw: null,
            reason,
            providerCode,
            httpStatus,
        };
    }

    _providerRef(data) {
        if (!data) return null;
        const tx = data.transactionid ?? data.transactionId;
        if (typeof tx === 'string' && tx.trim() !== '') return tx.trim();
        if (typeof tx === 'number' && Number.isFinite(tx)) return String(tx);
        const third = data.thirdpartyref;
        if (typeof third === 'string' && third.trim() !== '') return third.trim();
        return null;
    }

    /**
     * Provider money evidence, strict by construction.
     *
     * Moolre documents amounts as decimal STRINGS. A JSON number has already
     * been through binary floating point before this function sees it, so
     * accepting one would launder a possibly-corrupted value into "exact
     * provider evidence". Numbers are therefore rejected outright and the
     * provider fact is reported as missing, never fabricated.
     */
    _exactString(value) {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(trimmed)) return null;
        return trimmed;
    }

    /**
     * Transfer status semantics - an EVIDENCE BOUNDARY, not a lookup table.
     *
     * The Transfer Status reference documents one successful response carrying
     * data.txstatus = 1. It publishes no complete mapping for the other values.
     * The 0/1/2 triple appears in the List Transactions reference as a FILTER
     * vocabulary, which is not proof of the same meaning here.
     *
     * The distinction is load-bearing: calling an unproven value FAILED hands
     * the financial authority a reversal instruction for a payout that may
     * already have reached the recipient. Only the documented success value is
     * mapped; everything else stays an unresolved observation with the raw
     * value preserved, so no terminal state is invented in either direction.
     */
    _mapStatus(raw) {
        if (raw === undefined || raw === null) return 'UNRESOLVED';
        const value = typeof raw === 'number' ? String(raw) : raw;
        if (value === VERIFIED_SUCCESS_STATUS) return 'SUCCESSFUL';
        return 'UNRESOLVED';
    }

    // ── transfer status ─────────────────────────────────────────────────────

    /**
     * Status is evidence, not action: it never initiates, never retries a
     * transfer and never invents a reference.
     */
    async getBankTransferStatus({ referenceId } = {}) {
        const ref = this._requireReference(referenceId, 'STATUS');
        this._requireCapability('STATUS', ref);

        let res;
        try {
            res = await this._post(PATHS.STATUS, {
                type: 1,
                idtype: 1,
                id: ref,
                accountnumber: this._accountNumber,
            }, { headers: this._authHeaders() });
        } catch (err) {
            const classified = this._classifyTransport(err, { stage: 'STATUS', referenceId: ref, alreadySent: true });
            return this._statusResult(ref, { status: 'UNRESOLVED', reason: classified.code, providerCode: classified.providerCode });
        }

        const body = MoolreBankPayoutService._parseBody(res);
        const providerCode = body && body.code ? String(body.code) : null;
        const httpOk = res && res.status >= 200 && res.status < 300;

        if (!httpOk || !body || Number(body.status) !== 1) {
            // Auth, rate limit, config, malformed or unknown provider errors are
            // all UNRESOLVED. NOT_FOUND requires published provider evidence.
            if (providerCode && DOCUMENTED_STATUS_NOT_FOUND.has(providerCode)) {
                return this._statusResult(ref, { status: 'NOT_FOUND', providerCode });
            }
            return this._statusResult(ref, {
                status: 'UNRESOLVED',
                reason: body ? 'PROVIDER_STATUS_NOT_ACCEPTED' : 'MALFORMED_PROVIDER_RESPONSE',
                providerCode,
            });
        }

        const data = body.data && typeof body.data === 'object' ? body.data : null;
        if (!data || data.txstatus === undefined || data.txstatus === null) {
            return this._statusResult(ref, { status: 'UNRESOLVED', reason: 'STATUS_FIELD_MISSING', providerCode });
        }

        const nestedRaw = String(data.txstatus);
        const echoedRef = typeof data.externalref === 'string' ? data.externalref : null;
        const mapped = this._mapStatus(nestedRaw);
        if (mapped === 'UNRESOLVED') {
            return this._statusResult(ref, { status: 'UNRESOLVED', reason: 'STATUS_UNRECOGNISED', providerCode, providerStatusRaw: nestedRaw });
        }
        if (echoedRef !== null && echoedRef !== ref) {
            return this._statusResult(ref, { status: 'UNRESOLVED', reason: 'EXTERNAL_REFERENCE_MISMATCH', providerCode, providerStatusRaw: nestedRaw });
        }

        return this._statusResult(ref, {
            status: mapped,
            providerCode,
            providerStatusRaw: nestedRaw,
            externalId: echoedRef,
            providerRef: this._providerRef(data),
            amountGhsExact: this._exactString(data.amount),
        });
    }

    _statusResult(referenceId, {
        status,
        reason = null,
        providerCode = null,
        providerStatusRaw = null,
        externalId = null,
        providerRef = null,
        amountGhsExact = null,
    }) {
        const out = {
            provider: PROVIDER_RAIL,
            rail: 'BANK',
            status,
            referenceId,
            externalId,
            providerRef,
            amountGhsExact,
            currency: CURRENCY,
            providerStatusRaw,
        };
        if (reason) out.reason = reason;
        if (providerCode) out.providerCode = providerCode;
        return out;
    }
}

module.exports = MoolreBankPayoutService;
module.exports.PROVIDER_OUTCOMES = PROVIDER_OUTCOMES;
module.exports.MoolreBankPayoutError = MoolreBankPayoutError;
module.exports.PATHS = PATHS;
