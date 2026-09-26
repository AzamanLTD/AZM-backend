// services/moolreCollectionService.js
// =============================================================================
// Moolre Collections — in-bound GHS fiat deposits via PIN-push Mobile Money.
//
// Sibling of services/moolreDisbursementService.js (off-ramp). Mirrors that
// adapter's conventions: a PURE I/O adapter (no Prisma), axios with timeouts,
// the shared { status, code, message, data } envelope, and MOCK/LIVE modes
// gated on MOOLRE_PROVIDER + creds. Reads the same env vars:
//
//   MOOLRE_PROVIDER = MOCK | LIVE
//   MOOLRE_ENV      = sandbox | production
//   MOOLRE_API_USER
//   MOOLRE_API_KEY     (private — initiatePayment + validateName)
//   MOOLRE_API_PUBKEY  (public  — getPaymentStatus + createPaymentId)
//   MOOLRE_ACCOUNT_NUMBER
//
// ⚠️ CHANNEL CODE SPLIT — two separate maps, do NOT merge:
//   initiatePayment uses: 13=MTN | 6=Telecel | 7=AT   (initiate-payment.md)
//   validateName    uses:  1=MTN | 6=Telecel | 7=AT   (validate-name.md)
//
// ⚠️ BEFORE MOOLRE_PROVIDER=LIVE: run a real sandbox call and log the raw
// envelope. Confirm the field names this adapter reads (data.data, txstatus,
// payer, amount, externalref) and the TP13/TP14 codes before trusting them.
// =============================================================================

const logger = require('../src/config/logger');
const axios = require('axios');

const PROD_BASE_URL    = 'https://api.moolre.com';
const SANDBOX_BASE_URL = 'https://sandbox.moolre.com';
const SUPPORTED_CURRENCY = 'GHS';

// Source: docs.moolre.com/ai/initiate-payment.md
const PAYMENT_CHANNEL_MAP  = { MTN: 13, TELECEL: 6, VODAFONE: 6, AIRTELTIGO: 7 }; // VODAFONE = legacy alias for Telecel
// Source: docs.moolre.com/ai/validate-name.md (same as initiate-transfer.md)
const VALIDATE_CHANNEL_MAP = { MTN: 1,  TELECEL: 6, VODAFONE: 6, AIRTELTIGO: 7 }; // VODAFONE = legacy alias for Telecel

// ── r15 R15-B: explicit provider OUTCOME classification ─────────────────────
// Moolre guidance: ONE durable external reference per business action; after
// an ambiguous response the SAME reference is reused and the operation stays
// pending until status/callback resolves the outcome. Never a second
// instruction with a new reference.
//
//   NOT_DISPATCHED        — provably no bytes reached Moolre (TCP connect
//                           refused / DNS unresolvable): safe to retry the
//                           SAME business action.
//   DEFINITIVE_REJECTION  — Moolre answered explicitly (envelope status=0,
//                           non-duplicate code): the instruction was NOT
//                           accepted. Safe to treat as terminal for the
//                           attempt.
//   UNKNOWN_OUTCOME        — timeout, connection reset mid-flight, 5xx
//                           without an envelope: Moolre may have ACCEPTED the
//                           instruction. NEVER fail the deposit, NEVER issue
//                           another instruction; resolve via status/callback
//                           under the SAME externalRef.
//   DUPLICATE_REFERENCE    — TP13: Moolre already holds this externalRef.
//                           Reconciliation-required, not a local terminal
//                           failure — a previous (possibly accepted) attempt
//                           exists under the same reference.
const PROVIDER_OUTCOMES = {
    NOT_DISPATCHED:       'NOT_DISPATCHED',
    DEFINITIVE_REJECTION: 'DEFINITIVE_REJECTION',
    UNKNOWN_OUTCOME:       'UNKNOWN_OUTCOME',
    DUPLICATE_REFERENCE:  'DUPLICATE_REFERENCE',
};

// Node system errors that provably happen BEFORE any byte is sent to the
// provider (connection refused, DNS lookup failure). Everything else —
// timeouts, mid-flight resets, 5xx gateways — conservatively UNKNOWN.
const PROVABLY_PRE_DISPATCH = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

class MoolreCollectionService {
    constructor(opts = {}) {
        this.accountNumber = opts.accountNumber || process.env.MOOLRE_ACCOUNT_NUMBER || null;
        this.apiUser       = process.env.MOOLRE_API_USER   || null;
        this.apiKey        = process.env.MOOLRE_API_KEY    || null;
        this.apiPubKey     = process.env.MOOLRE_API_PUBKEY || null;

        const useProd = process.env.MOOLRE_ENV === 'production' || process.env.MOOLRE_ENV === 'prod';
        this.baseUrl  = process.env.MOOLRE_BASE_URL || (useProd ? PROD_BASE_URL : SANDBOX_BASE_URL);

        const credsPresent = !!(this.apiUser && this.apiKey);
        this.providerMode  = (process.env.MOOLRE_PROVIDER === 'LIVE' && credsPresent) ? 'LIVE' : 'MOCK';

        // In-memory collection ledger (MOCK mode only): externalRef → state.
        this._mockLedger = new Map();

        const mode = this.providerMode === 'LIVE' ? `LIVE → ${this.baseUrl}` : 'MOCK';
        logger.info(`[MoolreCollectionService] ${mode}`);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _privateHeaders() {
        return {
            'Content-Type': 'application/json',
            'X-API-USER':   this.apiUser    || 'mock-moolre-user',
            'X-API-KEY':    this.apiKey     || 'mock-moolre-key',
        };
    }

    _publicHeaders() {
        return {
            'Content-Type': 'application/json',
            'X-API-USER':   this.apiUser    || 'mock-moolre-user',
            'X-API-PUBKEY': this.apiPubKey  || 'mock-moolre-pubkey',
        };
    }

    /**
     * Collections expect a local 0-prefixed MSISDN (233XXXXXXXXX → 0XXXXXXXXX).
     * Distinct from the disbursement adapter, which strips to a bare MSISDN.
     */
    _sanitizeMsisdn(phone) {
        const digits = String(phone).replace(/\D/g, '');
        if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3);
        if (digits.startsWith('0')   && digits.length === 10) return digits;
        return digits;
    }

    /** Pull the most useful error string out of an axios failure + Moolre envelope. */
    _extractError(err) {
        const env = err.response?.data;
        if (env && typeof env === 'object') return env.message || env.code || err.message;
        return err.message;
    }

    /**
     * Build a typed provider-outcome error. The classification travels ON the
     * error (providerOutcome + provider + referenceId + stage) so callers can
     * orchestrate safely without parsing message strings.
     */
    _outcomeError(message, providerOutcome, { referenceId = null, stage = null, cause = null, code = null } = {}) {
        const err = new Error(`[MoolreCollectionService] ${message}`);
        err.providerOutcome = providerOutcome;
        err.provider = 'MOOLRE';
        err.referenceId = referenceId;
        err.stage = stage;
        if (code) err.code = code;
        if (cause) err.cause = cause;
        return err;
    }

    /**
     * Classify a transport-level axios failure. A non-2xx response that still
     * carries a Moolre envelope is a provider ANSW (handed back by _post); this
     * only classifies failures where no envelope exists. Conservative default:
     * UNKNOWN_OUTCOME — the request may have reached Moolre and been accepted.
     */
    _classifyTransportError(err, { referenceId = null, stage = null } = {}) {
        const outcome = PROVABLY_PRE_DISPATCH.has(err?.code)
            ? PROVIDER_OUTCOMES.NOT_DISPATCHED
            : PROVIDER_OUTCOMES.UNKNOWN_OUTCOME;
        return this._outcomeError(this._extractError(err), outcome, {
            referenceId, stage, cause: err,
        });
    }

    /**
     * POST and return Moolre's raw envelope ({ status, code, message, data }).
     * Moolre signals business errors (e.g. TP13 duplicate, TP14 OTP-required)
     * inside the envelope with an integer `status` of 0 — so if a non-2xx
     * response still carries an envelope object, hand it back unchanged and let
     * the caller's status/code logic run. Only a transport-level failure throws
     * — now as a TYPED outcome error (r15 R15-B): a bare Error gave callers no
     * way to distinguish "Moolre never heard from us" from "Moolre may have
     * accepted this".
     */
    async _post(path, body, headers, timeout = 15000, { referenceId = null, stage = null } = {}) {
        try {
            const { data: envelope } = await axios.post(`${this.baseUrl}${path}`, body, { headers, timeout });
            return envelope;
        } catch (err) {
            const env = err.response?.data;
            if (env && typeof env === 'object') return env;
            throw this._classifyTransportError(err, { referenceId, stage });
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Send a PIN-push USSD prompt to the payer's phone.
     * Returns { providerRef, requiresOtp: false } on TR099,
     *      or { requiresOtp: true }               on TP14.
     * Throws (err.isDuplicate=true) on TP13.
     */
    async initiatePayment({ externalRef, amountGhs, payerPhone, network = 'MTN', otpCode } = {}) {
        // Pre-I/O validation: provably NOT_DISPATCHED (nothing was sent).
        if (!externalRef) throw this._outcomeError('externalRef is required.', PROVIDER_OUTCOMES.NOT_DISPATCHED, { stage: 'INITIATE' });

        if (this.providerMode === 'MOCK') {
            const ref = `mock-prov-${Date.now()}`;
            this._mockLedger.set(externalRef, {
                status: 'PENDING', amount: amountGhs, payer: payerPhone, ref,
            });
            logger.info(`[MoolreCollectionService:MOCK] initiatePayment ref=${externalRef}`);
            return { providerRef: ref, requiresOtp: false };
        }

        const channel = PAYMENT_CHANNEL_MAP[network.toUpperCase()] ?? PAYMENT_CHANNEL_MAP.MTN;
        const body = {
            type: 1, channel, currency: SUPPORTED_CURRENCY,
            payer: this._sanitizeMsisdn(payerPhone),
            amount: String(amountGhs),
            externalref: externalRef,
            accountnumber: this.accountNumber,
        };
        if (otpCode) body.otpcode = otpCode;

        const data = await this._post('/open/transact/payment', body, this._publicHeaders(), 15000, {
            referenceId: externalRef, stage: 'INITIATE',
        });

        if (Number(data.status) === 0) {
            // TP13 = this externalRef ALREADY exists at Moolre: a previous
            // attempt under the SAME durable reference was (possibly)
            // accepted. This is a reconciliation-required outcome, never a
            // local terminal failure — the caller must keep the operation
            // pending and resolve by status/callback under the SAME ref.
            if (data.code === 'TP13') {
                const err = this._outcomeError(
                    data.message || 'Duplicate external reference — this payment already exists at Moolre.',
                    PROVIDER_OUTCOMES.DUPLICATE_REFERENCE,
                    { referenceId: externalRef, stage: 'INITIATE', code: 'TP13' },
                );
                err.isDuplicate = true;
                throw err;
            }
            // Any other explicit envelope rejection is DEFINITIVE: Moolre
            // answered and did not accept the instruction. (TP14 OTP-required
            // is NOT an error return — handled below.)
            const err = this._outcomeError(
                data.message || 'Payment initiation failed.',
                PROVIDER_OUTCOMES.DEFINITIVE_REJECTION,
                { referenceId: externalRef, stage: 'INITIATE', code: data.code },
            );
            err.isDuplicate = false;
            throw err;
        }
        if (data.code === 'TP14') return { requiresOtp: true };
        return { providerRef: data.data || null, requiresOtp: false }; // TR099
    }

    /**
     * Resolve the account-holder name for a phone number.
     * Returns the name string, or null if not found. Never throws on "not found".
     */
    async validateName({ payerPhone, network = 'MTN' } = {}) {
        if (this.providerMode === 'MOCK') return 'MOCK ACCOUNT HOLDER';

        const channel = VALIDATE_CHANNEL_MAP[network.toUpperCase()] ?? VALIDATE_CHANNEL_MAP.MTN;
        const data = await this._post('/open/transact/validate', {
            type: 1, receiver: this._sanitizeMsisdn(payerPhone),
            channel, currency: SUPPORTED_CURRENCY, accountnumber: this.accountNumber,
        }, this._publicHeaders());

        if (Number(data.status) === 0) return null;   // not found — callers expect null
        return typeof data.data === 'string' ? data.data : null;
    }

    /**
     * Poll the final status of a previously initiated payment.
     * Returns the raw data object: { txstatus, payer, amount, externalref, ... }.
     */
    async getPaymentStatus({ externalRef } = {}) {
        if (this.providerMode === 'MOCK') {
            const entry = this._mockLedger.get(externalRef);
            if (!entry) throw new Error('Unknown reference in MOCK ledger.');
            return { txstatus: 1, externalref: externalRef, amount: entry.amount, payer: entry.payer };
        }

        const data = await this._post('/open/transact/status', {
            type: 1, idtype: 1, id: externalRef, accountnumber: this.accountNumber,
        }, this._publicHeaders(), 10000, { referenceId: externalRef, stage: 'STATUS_QUERY' });

        // A status endpoint that cannot answer leaves the outcome UNRESOLVED
        // (r15 R15-B/R15-P): the operation stays pending — never failed.
        if (Number(data.status) === 0) {
            throw this._outcomeError(
                data.message || 'Status lookup failed.',
                PROVIDER_OUTCOMES.UNKNOWN_OUTCOME,
                { referenceId: externalRef, stage: 'STATUS_QUERY', code: data.code },
            );
        }
        return data.data;
    }

    /**
     * Mint a permanent Moolre Payment ID (*203*<id>#).
     * Returns { paymentid, name, qrcode }.
     */
    async createPaymentId({ phone, name, externalRef } = {}) {
        if (this.providerMode === 'MOCK') return { paymentid: `mock-${Date.now()}`, name };

        const body = {
            type: 2, phone: this._sanitizeMsisdn(phone),
            name, currency: SUPPORTED_CURRENCY, accountnumber: this.accountNumber,
        };
        if (externalRef) body.externalref = externalRef;

        const data = await this._post('/open/account/create', body, this._publicHeaders());
        if (Number(data.status) === 0) throw new Error(data.message || 'createPaymentId failed.');
        return data.data; // { paymentid, name, qrcode }
    }
}

module.exports = MoolreCollectionService;
module.exports.PROVIDER_OUTCOMES = PROVIDER_OUTCOMES;
