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

const axios = require('axios');

const PROD_BASE_URL    = 'https://api.moolre.com';
const SANDBOX_BASE_URL = 'https://sandbox.moolre.com';
const SUPPORTED_CURRENCY = 'GHS';

// Source: docs.moolre.com/ai/initiate-payment.md
const PAYMENT_CHANNEL_MAP  = { MTN: 13, VODAFONE: 6, TELECEL: 6, AIRTELTIGO: 7 };
// Source: docs.moolre.com/ai/validate-name.md (same as initiate-transfer.md)
const VALIDATE_CHANNEL_MAP = { MTN: 1,  VODAFONE: 6, TELECEL: 6, AIRTELTIGO: 7 };

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
        console.log(`[MoolreCollectionService] ${mode}`);
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
     * POST and return Moolre's raw envelope ({ status, code, message, data }).
     * Moolre signals business errors (e.g. TP13 duplicate, TP14 OTP-required)
     * inside the envelope with an integer `status` of 0 — so if a non-2xx
     * response still carries an envelope object, hand it back unchanged and let
     * the caller's status/code logic run. Only a transport-level failure throws.
     */
    async _post(path, body, headers, timeout = 15000) {
        try {
            const { data: envelope } = await axios.post(`${this.baseUrl}${path}`, body, { headers, timeout });
            return envelope;
        } catch (err) {
            const env = err.response?.data;
            if (env && typeof env === 'object') return env;
            throw new Error(`[MoolreCollectionService] ${this._extractError(err)}`);
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
        if (!externalRef) throw new Error('[MoolreCollectionService] externalRef is required.');

        if (this.providerMode === 'MOCK') {
            const ref = `mock-prov-${Date.now()}`;
            this._mockLedger.set(externalRef, {
                status: 'PENDING', amount: amountGhs, payer: payerPhone, ref,
            });
            console.log(`[MoolreCollectionService:MOCK] initiatePayment ref=${externalRef}`);
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

        const data = await this._post('/open/transact/payment', body, this._privateHeaders());

        if (Number(data.status) === 0) {
            const err = new Error(data.message || 'Payment initiation failed.');
            err.code        = data.code;
            err.isDuplicate = data.code === 'TP13';
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
        }, this._publicHeaders(), 10000);

        if (Number(data.status) === 0) throw new Error(data.message || 'Status lookup failed.');
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
