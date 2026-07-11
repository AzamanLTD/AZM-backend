// services/moolreDisbursementService.js
// =============================================================================
// AZAMAN V2 — MOOLRE DISBURSEMENT SERVICE   (Moolre integration, off-ramp)
//
// Purpose
// -------
// Drop-in replacement for services/mtnDisbursementService.js. Pays fiat (GHS)
// to a user's mobile-money wallet via the Moolre Disbursements API. It mirrors
// the PUBLIC METHOD SHAPE of MtnDisbursementService EXACTLY so it can be bound
// under the same `mtnDisbursementService` app-key in server.js with zero
// changes to any consumer:
//
//   • finance.controller.js                 → newReferenceId(), initiateTransfer()
//   • workers/withdrawalReconciliationWorker → getTransferStatus()
//   • workers/payoutBatchWorker              → initiateTransfer()
//   • services/smartRouteService             → optional `dispatch()` (INTENTIONALLY
//                                              ABSENT — the caller guards on
//                                              `?.dispatch` so omitting it keeps
//                                              today's no-op behaviour identical
//                                              to MTN, which also has no dispatch).
//
// Like the MTN adapter, this is a PURE I/O adapter — it does NOT touch Prisma.
// All multi-step money movement stays owned by finance.service.js. The contract
// of each public method (argument shape + return shape) is byte-for-byte the
// same as the MTN service so the upstream/downstream ledgers keep sharing the
// single `reference` correlation token (reused as TransactionHistory.txHash).
//
// MODES
// -----
//   • LIVE — when MOOLRE_API_USER + MOOLRE_API_KEY are set AND
//            MOOLRE_PROVIDER === 'LIVE'.
//   • MOCK — default. In-memory map keyed by reference. Deterministic, anchored
//            to nothing external, so local/CI runs need no Moolre credentials.
//
// =============================================================================
//
// ✅ CONFIRMED 2026-07-09 against the official docs.moolre.com/ai/*.md pages
// (initiate-transfer, transfer-status, validate-name, list-account-transactions,
// create-payment-id, payment-webhook, initiate-payment). Every value below —
// endpoint paths, body field names, channel codes, and the numeric txstatus
// enum — has now been checked against Moolre's real, machine-readable API
// reference (not guessed). One real bug was found and fixed in this pass:
// the status-normalizer was reading a `data.status` field that Moolre never
// actually sends on the transfer/status endpoints (the real field is the
// NUMERIC `data.txstatus`: 0=Pending, 1=Success, 2=Failed) — every successful
// payout was silently stuck reporting PENDING forever. Fixed below.
// =============================================================================
//
// Endpoints/fields confirmed correct as originally written (no change needed):
//   • TRANSFER_ENDPOINT '/open/transact/transfer', STATUS_ENDPOINT '/open/transact/status'
//   • BODY_KEYS.recipient='receiver', .reference='externalref', .narration='reference'
//   • BODY_KEYS.channel/currency/amount/accountNumber, TRANSFER_TYPE_CODE=1
//   • NETWORK_TO_CHANNEL: MTN=1, TELECEL=6, AIRTELTIGO=7  (VODAFONE accepted as legacy alias)
// =============================================================================

const axios          = require('axios');
const { randomUUID } = require('crypto');

// ── Confirmed constants ───────────────────────────────────────────────────────
const PROVIDER_NAME          = 'MOOLRE_DISBURSEMENT';
const PROD_BASE_URL          = 'https://api.moolre.com';
const SANDBOX_BASE_URL       = 'https://sandbox.moolre.com';
const SUPPORTED_CURRENCY     = 'GHS';

// ── ✅ CONFIRMED: endpoint paths (docs.moolre.com/ai/initiate-transfer.md, transfer-status.md) ──
const TRANSFER_ENDPOINT      = '/open/transact/transfer';      // POST — initiate payout
const STATUS_ENDPOINT        = '/open/transact/status';        // POST — query by reference

// ── ✅ CONFIRMED: request body field names (docs.moolre.com/ai/initiate-transfer.md) ──
const BODY_KEYS = {
    type:           'type',            // txn type discriminator, if Moolre uses one
    channel:        'channel',         // network/channel selector
    currency:       'currency',
    amount:         'amount',
    recipient:      'receiver',        // recipient MSISDN field name
    reference:      'externalref',     // OUR idempotency key field name
    accountName:    'accountname',
    narration:      'reference',        // confirmed from docs.moolre.com/ai/initiate-transfer.md
    accountNumber:  'accountnumber',   // YOUR Moolre payout account/wallet number
};

// ── ✅ CONFIRMED: type=1 is required on every transfer request. ──
const TRANSFER_TYPE_CODE     = 1;

// ── ✅ CONFIRMED numeric channel codes (docs.moolre.com/ai/initiate-transfer.md) ──
// AZM passes network ∈ {MTN, TELECEL, AIRTELTIGO} (VODAFONE accepted as legacy alias → Telecel).
const NETWORK_TO_CHANNEL = {
    MTN:         1,
    TELECEL:     6,   // Telecel Ghana (formerly Vodafone)
    VODAFONE:    6,   // LEGACY ALIAS — Vodafone rebranded to Telecel
    AIRTELTIGO:  7,
};

// ── CONFIRMED 2026-07-09 against docs.moolre.com/ai/{initiate-transfer,
// transfer-status,list-account-transactions}.md — Moolre's payout/transfer
// status field is ALWAYS `data.txstatus`, and it is a NUMBER, not a word:
//   0 = Pending, 1 = Success, 2 = Failed
// (There is no `data.status` field in the transfer/status response bodies —
// that name was a guess from before we could confirm against the real docs.
// Keeping the numeric keys as strings below since we String()-coerce the
// raw value before lookup. Word-based fallback keys are kept defensively
// in case Moolre ever changes this to a string enum.)
const STATUS_MAP = {
    '0':         'PENDING',
    '1':         'SUCCESSFUL',
    '2':         'FAILED',
    PENDING:     'PENDING',
    PROCESSING:  'PENDING',
    SUCCESS:     'SUCCESSFUL',
    SUCCESSFUL:  'SUCCESSFUL',
    COMPLETED:   'SUCCESSFUL',
    PAID:        'SUCCESSFUL',
    FAILED:      'FAILED',
    REJECTED:    'FAILED',
    REVERSED:    'FAILED',
    CANCELLED:   'FAILED',
};
// =============================================================================
// END VERIFY BLOCK — code below is provider-correct and should not need edits.
// =============================================================================

class MoolreDisbursementService {
    constructor(opts = {}) {
        this.apiUser        = process.env.MOOLRE_API_USER || null;
        this.apiKey         = process.env.MOOLRE_API_KEY  || null;
        // The Moolre payout account/wallet number funds are sent FROM. Required
        // by most Moolre transfer endpoints. Carried as a constructor/env value
        // so the adapter stays stateless per-request.
        this.accountNumber  = opts.accountNumber || process.env.MOOLRE_ACCOUNT_NUMBER || null;

        // Sandbox vs production base URL. Defaults to sandbox unless explicitly
        // told otherwise, so a misconfigured prod deploy can't accidentally move
        // real money against the live endpoint.
        const useProd       = process.env.MOOLRE_ENV === 'production' || process.env.MOOLRE_ENV === 'prod';
        this.baseUrl        = process.env.MOOLRE_BASE_URL || (useProd ? PROD_BASE_URL : SANDBOX_BASE_URL);

        const credsPresent  = this.apiUser && this.apiKey;
        this.providerMode   = (process.env.MOOLRE_PROVIDER === 'LIVE' && credsPresent) ? 'LIVE' : 'MOCK';

        // In-memory transfer ledger (MOCK mode only): reference → state.
        this._mockTransfers = new Map();

        if (this.providerMode === 'MOCK') {
            console.log(
                '[MoolreDisbursementService] Running in MOCK mode ' +
                '(set MOOLRE_API_USER + MOOLRE_API_KEY + MOOLRE_PROVIDER=LIVE for live calls).'
            );
        } else {
            console.log(`[MoolreDisbursementService] Running in LIVE mode → ${this.baseUrl}`);
        }
    }

    // ── Public API (mirrors MtnDisbursementService) ───────────────────────────

    /**
     * Trigger a mobile-money payout. Mirrors MtnDisbursementService.initiateTransfer.
     *
     * @param {{
     *   referenceId: string,                 // idempotency key (reused as txHash)
     *   amountGhs:   number,
     *   recipientPhone: string,              // E.164 or local (MSISDN)
     *   externalId?: string,                 // your own audit reference
     *   payerMessage?: string,
     *   payeeNote?: string,
     *   network?: 'MTN'|'TELECEL'|'AIRTELTIGO'  // optional; defaults MTN (VODAFONE accepted as legacy alias)
     * }} payload
     *
     * @returns {Promise<{
     *   provider: string,
     *   referenceId: string,
     *   externalId: string,
     *   status: 'PENDING'|'SUCCESSFUL'|'FAILED',
     *   amountGhs: number,
     *   recipientPhone: string,
     *   message: string,
     *   source: 'LIVE'|'MOCK'
     * }>}
     */
    async initiateTransfer(payload) {
        const {
            referenceId,
            amountGhs,
            recipientPhone,
            externalId,
            payerMessage,
            payeeNote,
            network
        } = payload || {};

        // ── Validation (identical guards to the MTN adapter) ──────────────────
        if (!referenceId || typeof referenceId !== 'string') {
            throw new Error('[MoolreDisbursementService] referenceId is required for idempotency.');
        }
        if (!amountGhs || Number(amountGhs) <= 0) {
            throw new Error('[MoolreDisbursementService] amountGhs must be positive.');
        }
        if (!recipientPhone) {
            throw new Error('[MoolreDisbursementService] recipientPhone is required.');
        }

        const finalExternalId   = externalId   || `AZAMAN_${referenceId}`;
        const finalNote         = (payeeNote || payerMessage || 'Azaman MoMo payout').slice(0, 160);
        const channel           = NETWORK_TO_CHANNEL[(network || 'MTN').toUpperCase()] || NETWORK_TO_CHANNEL.MTN;

        if (this.providerMode === 'MOCK') {
            return this._mockInitiateTransfer({
                referenceId,
                amountGhs:      Number(amountGhs),
                recipientPhone,
                externalId:     finalExternalId,
                note:           finalNote,
                channel
            });
        }

        // ── LIVE path ─────────────────────────────────────────────────────────
        const body = {
            [BODY_KEYS.currency]:      SUPPORTED_CURRENCY,
            [BODY_KEYS.amount]:        String(Number(amountGhs)),   // Moolre requires amount as string
            [BODY_KEYS.recipient]:     this._sanitizeMsisdn(recipientPhone),
            [BODY_KEYS.reference]:     referenceId,         // strict idempotency key
            [BODY_KEYS.channel]:       channel,
            [BODY_KEYS.narration]:     finalNote,
        };
        if (TRANSFER_TYPE_CODE !== null && TRANSFER_TYPE_CODE !== undefined) {
            body[BODY_KEYS.type] = TRANSFER_TYPE_CODE;
        }
        if (this.accountNumber) {
            body[BODY_KEYS.accountNumber] = this.accountNumber;
        }

        try {
            const { data: envelope } = await axios.post(
                `${this.baseUrl}${TRANSFER_ENDPOINT}`,
                body,
                { headers: this._authHeaders(), timeout: 15000 }
            );

            // Moolre wraps EVERY response in { status, code, message, data, go }.
            const { ok, data, message, code } = this._unwrap(envelope);
            if (!ok) {
                // A synchronous rejection (status: 0). Surface the provider
                // message so finance.controller's catch can reverse + return 502,
                // exactly as it does for an MTN rejection.
                throw new Error(message || code || 'Moolre rejected the payout.');
            }

            // Moolre may settle synchronously OR return a PENDING that settles via
            // webhook. Normalize whatever it gives us; default to PENDING (async).
            // txstatus is the confirmed field (0/1/2 — see STATUS_MAP comment above).
            // Explicit undefined/null check because 0 ("Pending") is falsy and
            // would otherwise wrongly fall through to data.status (which Moolre
            // never actually sends on this endpoint).
            const rawStatus = (data && data.txstatus !== undefined && data.txstatus !== null)
                ? data.txstatus
                : (data && data.status) || 'PENDING';
            const normalized = this._normalizeStatus(rawStatus);

            return {
                provider:       PROVIDER_NAME,
                referenceId,
                externalId:     finalExternalId,
                status:         normalized,
                amountGhs:      Number(amountGhs),
                recipientPhone: this._sanitizeMsisdn(recipientPhone),
                message:        message || 'Moolre accepted disbursement.',
                providerTxId:   (data && (data.transactionid || data.txid || data.id)) || null,
                source:         'LIVE'
            };
        } catch (err) {
            const apiMsg = this._extractError(err);
            throw new Error(`[MoolreDisbursementService] Moolre transfer rejected: ${apiMsg}`);
        }
    }

    /**
     * Poll the payout status by reference. Mirrors MtnDisbursementService.getTransferStatus.
     * @param {string} referenceId
     */
    async getTransferStatus(referenceId) {
        if (!referenceId) {
            throw new Error('[MoolreDisbursementService] referenceId is required.');
        }

        if (this.providerMode === 'MOCK') {
            return this._mockGetTransferStatus(referenceId);
        }

        const body = { [BODY_KEYS.reference]: referenceId };
        if (this.accountNumber) body[BODY_KEYS.accountNumber] = this.accountNumber;

        try {
            const { data: envelope } = await axios.post(
                `${this.baseUrl}${STATUS_ENDPOINT}`,
                body,
                { headers: this._authHeaders(), timeout: 10000 }
            );
            const { ok, data, message } = this._unwrap(envelope);
            if (!ok) {
                // Treat an unknown reference as PENDING rather than throwing, so
                // the reconciliation worker simply retries on the next tick.
                return {
                    provider:    PROVIDER_NAME,
                    referenceId,
                    externalId:  null,
                    status:      'PENDING',
                    amountGhs:   null,
                    reason:      message || null,
                    source:      'LIVE'
                };
            }
            const rawStatus = (data && data.txstatus !== undefined && data.txstatus !== null)
                ? data.txstatus
                : (data && data.status) || 'PENDING';
            return {
                provider:    PROVIDER_NAME,
                referenceId,
                externalId:  (data && data.externalref) || null,
                status:      this._normalizeStatus(rawStatus),
                amountGhs:   data && data.amount ? Number(data.amount) : null,
                reason:      (data && data.reason) || message || null,
                source:      'LIVE'
            };
        } catch (err) {
            const apiMsg = this._extractError(err);
            throw new Error(`[MoolreDisbursementService] Moolre status lookup failed: ${apiMsg}`);
        }
    }

    /**
     * A freshly-minted reference (UUID v4). Mirrors MtnDisbursementService.newReferenceId.
     * Kept as a UUID so the value remains compatible if you ever fall back to MTN
     * (whose X-Reference-Id MUST be a UUID v4).
     */
    newReferenceId() {
        return randomUUID();
    }

    /**
     * MOCK-ONLY helper — forces a tracked transfer into a terminal state so tests
     * and the admin-only simulate endpoint can drive the settlement webhook
     * locally. Returns null in LIVE mode. Mirrors the MTN adapter exactly.
     */
    simulateInboundWebhook(referenceId, status) {
        if (this.providerMode !== 'MOCK') return null;
        const entry = this._mockTransfers.get(referenceId);
        if (!entry) return null;
        const normalized = this._normalizeStatus(status || 'SUCCESSFUL');
        entry.status    = normalized;
        entry.settledAt = new Date().toISOString();
        this._mockTransfers.set(referenceId, entry);
        return entry;
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _authHeaders() {
        // Moolre uses STATIC header credentials — no OAuth, no token exchange.
        return {
            'Content-Type': 'application/json',
            'X-API-USER':   this.apiUser || 'mock-moolre-user',
            'X-API-KEY':    this.apiKey  || 'mock-moolre-key',
        };
    }

    /**
     * Unwrap Moolre's universal envelope { status, code, message, data, go }.
     * `status` is an INTEGER: 1 = success, 0 = failure (NOT a boolean).
     */
    _unwrap(envelope) {
        if (!envelope || typeof envelope !== 'object') {
            return { ok: false, data: null, message: 'Empty response from Moolre.', code: null, go: null };
        }
        return {
            ok:      Number(envelope.status) === 1,
            data:    envelope.data || null,
            message: envelope.message || null,
            code:    envelope.code || null,
            go:      envelope.go || null,
        };
    }

    /** Map a raw Moolre status string onto AZM's {PENDING|SUCCESSFUL|FAILED}. */
    _normalizeStatus(raw) {
        const key = String(raw || '').toUpperCase().trim();
        return STATUS_MAP[key] || 'PENDING';
    }

    /** Pull the most useful error string out of an axios failure + Moolre envelope. */
    _extractError(err) {
        const env = err.response?.data;
        if (env && typeof env === 'object') {
            return env.message || env.code || err.message;
        }
        return err.message;
    }

    _sanitizeMsisdn(phone) {
        // Strip non-digits then normalize to 0-prefixed local format (0XXXXXXXXX).
        // Moolre docs example shows "0246798993" — same as collection service.
        const digits = String(phone).replace(/\D+/g, '');
        if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3);
        if (digits.startsWith('0') && digits.length === 10) return digits;
        return digits; // fallback — pass as-is if unrecognised format
    }

    _mockInitiateTransfer({ referenceId, amountGhs, recipientPhone, externalId, note, channel }) {
        // Idempotency: replaying the same reference is a no-op echo.
        const existing = this._mockTransfers.get(referenceId);
        if (existing) {
            return Promise.resolve({
                provider:       PROVIDER_NAME,
                referenceId,
                externalId:     existing.externalId,
                status:         existing.status,
                amountGhs:      existing.amountGhs,
                recipientPhone: existing.recipientPhone,
                message:        'Mock Moolre idempotent replay (no-op).',
                providerTxId:   existing.providerTxId,
                source:         'MOCK'
            });
        }

        const providerTxId = `MOCK_MOOLRE_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const entry = {
            provider:       PROVIDER_NAME,
            referenceId,
            externalId,
            status:         'PENDING',
            amountGhs,
            recipientPhone: this._sanitizeMsisdn(recipientPhone),
            channel,
            note,
            providerTxId,
            createdAt:      new Date().toISOString(),
            source:         'MOCK'
        };
        this._mockTransfers.set(referenceId, entry);

        return Promise.resolve({
            provider:       PROVIDER_NAME,
            referenceId,
            externalId,
            status:         'PENDING',
            amountGhs,
            recipientPhone: entry.recipientPhone,
            message:        'Mock Moolre accepted disbursement (PENDING).',
            providerTxId,
            source:         'MOCK'
        });
    }

    _mockGetTransferStatus(referenceId) {
        const entry = this._mockTransfers.get(referenceId);
        if (!entry) {
            return Promise.resolve({
                provider:    PROVIDER_NAME,
                referenceId,
                externalId:  null,
                status:      'UNKNOWN',
                amountGhs:   null,
                reason:      null,
                source:      'MOCK'
            });
        }
        return Promise.resolve({
            provider:    PROVIDER_NAME,
            referenceId,
            externalId:  entry.externalId,
            status:      entry.status,
            amountGhs:   entry.amountGhs,
            reason:      null,
            source:      'MOCK'
        });
    }
}

module.exports = MoolreDisbursementService;
