// services/mtnDisbursementService.js
// =============================================================================
// AZAMAN V2 — MTN MOBILE MONEY DISBURSEMENT SERVICE   (Phase B v2: Arbitrage Fix)
//
// Purpose
// -------
// Pays fiat (GHS) to a user's MoMo wallet directly from Azaman's local
// SYSTEM_FIAT_POOL. This service exists so the platform can permanently
// retain the user's USDC in SYSTEM_MASTER_CRYPTO and liquidate it later
// at the corporate (OTC) premium — i.e. the arbitrage loop described in
// AZAMAN_MASTER_SOUL.md §1 / §4.
//
// IMPORTANT: This is the OFF-RAMP only. Kotani Pay V3 is still the
// on-ramp / corporate-purchase gateway (services/gatewayService.js) and
// is also used to quote retail/corporate rates. The two are intentionally
// decoupled — Azaman never hands USDC over to the off-ramp gateway.
//
// MTN MoMo Open API surface mocked by this module
// -----------------------------------------------
//   1. POST /disbursement/token/                 → OAuth Bearer token
//        Auth   : Basic base64(API_USER:API_KEY)
//        Header : Ocp-Apim-Subscription-Key: <subscription>
//        Body   : (none)
//        Reply  : { access_token, token_type: 'access_token', expires_in: 3600 }
//
//   2. POST /disbursement/v1_0/transfer         → trigger payout
//        Auth   : Bearer <access_token>
//        Headers: X-Reference-Id: <UUID v4>     ← STRICT IDEMPOTENCY KEY
//                 X-Target-Environment: sandbox|mtnghana|...
//                 Ocp-Apim-Subscription-Key:    <subscription>
//        Body   : { amount, currency, externalId, payee:{partyIdType,partyId},
//                   payerMessage, payeeNote }
//        Reply  : 202 Accepted (no body) — async settlement.
//
//   3. GET /disbursement/v1_0/transfer/{X-Reference-Id} → status poll
//        Reply  : { amount, currency, externalId, payee, status:
//                   'PENDING'|'SUCCESSFUL'|'FAILED', reason? }
//
// Modes
// -----
//   • LIVE — when MTN_MOMO_API_USER + MTN_MOMO_API_KEY +
//            MTN_MOMO_SUBSCRIPTION_KEY are set AND MTN_MOMO_PROVIDER === 'LIVE'.
//   • MOCK — default. In-memory map keyed by referenceId.
//
// All multi-step money movements are still owned by finance.service.js;
// this module is a pure I/O adapter and does NOT touch Prisma.
// =============================================================================

const logger = require('../src/config/logger');
const axios            = require('axios');
const { randomUUID }   = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────
const PROVIDER_NAME            = 'MTN_MOMO_DISBURSEMENT';
const DEFAULT_BASE_URL         = 'https://sandbox.momodeveloper.mtn.com';
const TOKEN_ENDPOINT           = '/disbursement/token/';
const TRANSFER_ENDPOINT        = '/disbursement/v1_0/transfer';
const STATUS_ENDPOINT          = (refId) => `/disbursement/v1_0/transfer/${refId}`;
const SUPPORTED_CURRENCY       = 'GHS';
const TOKEN_REFRESH_BUFFER_MS  = 60_000;   // refresh 60 s before expiry
const DEFAULT_TARGET_ENV       = process.env.MTN_MOMO_TARGET_ENV || 'sandbox';

class MtnDisbursementService {
    constructor(opts = {}) {
        this.apiUser           = process.env.MTN_MOMO_API_USER          || null;
        this.apiKey            = process.env.MTN_MOMO_API_KEY           || null;
        this.subscriptionKey   = process.env.MTN_MOMO_SUBSCRIPTION_KEY  || null;
        this.baseUrl           = process.env.MTN_MOMO_BASE_URL          || DEFAULT_BASE_URL;
        this.targetEnv         = opts.targetEnv || DEFAULT_TARGET_ENV;

        const credsPresent = this.apiUser && this.apiKey && this.subscriptionKey;
        this.providerMode  = (process.env.MTN_MOMO_PROVIDER === 'LIVE' && credsPresent)
            ? 'LIVE'
            : 'MOCK';

        // Cached OAuth token (LIVE mode only).
        this._tokenCache = { accessToken: null, expiresAt: 0 };

        // In-memory transfer ledger (MOCK mode only): referenceId → state.
        this._mockTransfers = new Map();

        if (this.providerMode === 'MOCK') {
            logger.info(
                '[MtnDisbursementService] Running in MOCK mode ' +
                '(set MTN_MOMO_API_USER + MTN_MOMO_API_KEY + ' +
                'MTN_MOMO_SUBSCRIPTION_KEY + MTN_MOMO_PROVIDER=LIVE for live calls).'
            );
        } else {
            logger.info(`[MtnDisbursementService] Running in LIVE mode → ${this.baseUrl}`);
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Step 1 of the MTN MoMo disbursement flow — fetch (and cache) an OAuth
     * Bearer token via POST /disbursement/token/. Cached until 60 s before
     * the documented expiry. In MOCK mode returns a deterministic stub.
     *
     * @returns {Promise<{accessToken: string, tokenType: string, expiresIn: number, source: 'LIVE'|'MOCK'}>}
     */
    async getAccessToken() {
        if (this.providerMode === 'MOCK') {
            return this._mockGetAccessToken();
        }

        // Reuse cached token while still valid.
        if (
            this._tokenCache.accessToken &&
            this._tokenCache.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
        ) {
            return {
                accessToken: this._tokenCache.accessToken,
                tokenType:   'access_token',
                expiresIn:   Math.floor((this._tokenCache.expiresAt - Date.now()) / 1000),
                source:      'LIVE'
            };
        }

        const basic = Buffer.from(`${this.apiUser}:${this.apiKey}`).toString('base64');
        try {
            const { data } = await axios.post(
                `${this.baseUrl}${TOKEN_ENDPOINT}`,
                null,
                {
                    headers: {
                        Authorization:               `Basic ${basic}`,
                        'Ocp-Apim-Subscription-Key': this.subscriptionKey
                    },
                    timeout: 10000
                }
            );
            const expiresIn = parseInt(data.expires_in, 10) || 3600;
            this._tokenCache = {
                accessToken: data.access_token,
                expiresAt:   Date.now() + (expiresIn * 1000)
            };
            return {
                accessToken: data.access_token,
                tokenType:   data.token_type || 'access_token',
                expiresIn,
                source:      'LIVE'
            };
        } catch (err) {
            const apiMsg = err.response?.data?.message || err.message;
            throw new Error(`[MtnDisbursementService] OAuth token fetch failed: ${apiMsg}`);
        }
    }

    /**
     * Step 2 of the MTN MoMo disbursement flow — trigger a payout via
     * POST /disbursement/v1_0/transfer. The X-Reference-Id header is the
     * STRICT idempotency key: re-issuing the same UUID with the same body
     * is a no-op on MTN's side.
     *
     * Callers should pass the TransactionHistory.txHash idempotency key as
     * `referenceId` so the upstream and downstream ledgers share a single
     * correlation token.
     *
     * @param {{
     *   referenceId: string,                 // UUID v4 — idempotency key
     *   amountGhs:   number,
     *   recipientPhone: string,              // E.164 or local (MSISDN)
     *   externalId?: string,                 // your own audit reference
     *   payerMessage?: string,
     *   payeeNote?: string
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
            payeeNote
        } = payload || {};

        // ── Validation ───────────────────────────────────────────────────────
        if (!referenceId || typeof referenceId !== 'string') {
            throw new Error('[MtnDisbursementService] referenceId (UUID v4) is required for idempotency.');
        }
        if (!amountGhs || Number(amountGhs) <= 0) {
            throw new Error('[MtnDisbursementService] amountGhs must be positive.');
        }
        if (!recipientPhone) {
            throw new Error('[MtnDisbursementService] recipientPhone is required.');
        }

        const finalExternalId   = externalId   || `AZAMAN_${Date.now()}`;
        const finalPayerMessage = (payerMessage || 'Azaman MoMo withdrawal').slice(0, 160);
        const finalPayeeNote    = (payeeNote    || 'Azaman MoMo payout').slice(0, 160);

        if (this.providerMode === 'MOCK') {
            return this._mockInitiateTransfer({
                referenceId,
                amountGhs:      Number(amountGhs),
                recipientPhone,
                externalId:     finalExternalId,
                payerMessage:   finalPayerMessage,
                payeeNote:      finalPayeeNote
            });
        }

        // ── LIVE path ────────────────────────────────────────────────────────
        const { accessToken } = await this.getAccessToken();

        try {
            // 202 Accepted with no body on success.
            await axios.post(
                `${this.baseUrl}${TRANSFER_ENDPOINT}`,
                {
                    amount:       String(amountGhs),
                    currency:     SUPPORTED_CURRENCY,
                    externalId:   finalExternalId,
                    payee: {
                        partyIdType: 'MSISDN',
                        partyId:     this._sanitizeMsisdn(recipientPhone)
                    },
                    payerMessage: finalPayerMessage,
                    payeeNote:    finalPayeeNote
                },
                {
                    headers: {
                        Authorization:                `Bearer ${accessToken}`,
                        'X-Reference-Id':             referenceId,
                        'X-Target-Environment':       this.targetEnv,
                        'Ocp-Apim-Subscription-Key':  this.subscriptionKey,
                        'Content-Type':               'application/json'
                    },
                    timeout: 15000
                }
            );

            return {
                provider:       PROVIDER_NAME,
                referenceId,
                externalId:     finalExternalId,
                status:         'PENDING',                  // settlement is async
                amountGhs:      Number(amountGhs),
                recipientPhone,
                message:        'MTN MoMo accepted disbursement (PENDING).',
                source:         'LIVE'
            };
        } catch (err) {
            const apiMsg = err.response?.data?.message || err.response?.data?.code || err.message;
            throw new Error(`[MtnDisbursementService] MTN transfer rejected: ${apiMsg}`);
        }
    }

    /**
     * Step 3 — poll the disbursement status by referenceId.
     * Used by the admin War Room and by reconciliation jobs.
     *
     * @param {string} referenceId
     */
    async getTransferStatus(referenceId) {
        if (!referenceId) {
            throw new Error('[MtnDisbursementService] referenceId is required.');
        }

        if (this.providerMode === 'MOCK') {
            return this._mockGetTransferStatus(referenceId);
        }

        const { accessToken } = await this.getAccessToken();

        try {
            const { data } = await axios.get(
                `${this.baseUrl}${STATUS_ENDPOINT(referenceId)}`,
                {
                    headers: {
                        Authorization:                `Bearer ${accessToken}`,
                        'X-Target-Environment':       this.targetEnv,
                        'Ocp-Apim-Subscription-Key':  this.subscriptionKey
                    },
                    timeout: 10000
                }
            );
            return {
                provider:    PROVIDER_NAME,
                referenceId,
                externalId:  data.externalId || null,
                status:      (data.status || 'PENDING').toUpperCase(),
                amountGhs:   data.amount ? Number(data.amount) : null,
                reason:      data.reason || null,
                source:      'LIVE'
            };
        } catch (err) {
            const apiMsg = err.response?.data?.message || err.message;
            throw new Error(`[MtnDisbursementService] MTN status lookup failed: ${apiMsg}`);
        }
    }

    /**
     * Convenience: a freshly-minted X-Reference-Id (UUID v4). Provided so
     * callers don't need to import the uuid module separately.
     */
    newReferenceId() {
        return randomUUID();
    }

    /**
     * MOCK-ONLY helper — forces a tracked transfer into a terminal state so
     * tests and the admin-only simulate endpoint can drive the settlement
     * webhook locally. Returns null in LIVE mode.
     */
    simulateInboundWebhook(referenceId, status) {
        if (this.providerMode !== 'MOCK') return null;
        const entry = this._mockTransfers.get(referenceId);
        if (!entry) return null;
        const normalized = (status || 'SUCCESSFUL').toUpperCase();
        entry.status      = ['SUCCESSFUL', 'FAILED', 'PENDING'].includes(normalized) ? normalized : 'SUCCESSFUL';
        entry.settledAt   = new Date().toISOString();
        this._mockTransfers.set(referenceId, entry);
        return entry;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    _sanitizeMsisdn(phone) {
        // Strip "+" and any non-digits — MTN MoMo expects bare MSISDN.
        return String(phone).replace(/\D+/g, '');
    }

    _mockGetAccessToken() {
        const expiresIn = 3600;
        const accessToken =
            'MOCK_MOMO_TOKEN_' +
            Buffer.from(`${Date.now()}_${Math.random()}`).toString('hex').slice(0, 24);
        this._tokenCache = {
            accessToken,
            expiresAt: Date.now() + (expiresIn * 1000)
        };
        return Promise.resolve({
            accessToken,
            tokenType:   'access_token',
            expiresIn,
            source:      'MOCK'
        });
    }

    _mockInitiateTransfer({ referenceId, amountGhs, recipientPhone, externalId, payerMessage, payeeNote }) {
        // Idempotency: replaying the same X-Reference-Id is a no-op echo.
        const existing = this._mockTransfers.get(referenceId);
        if (existing) {
            return Promise.resolve({
                provider:       PROVIDER_NAME,
                referenceId,
                externalId:     existing.externalId,
                status:         existing.status,
                amountGhs:      existing.amountGhs,
                recipientPhone: existing.recipientPhone,
                message:        'Mock MTN MoMo idempotent replay (no-op).',
                source:         'MOCK'
            });
        }

        const entry = {
            provider:       PROVIDER_NAME,
            referenceId,
            externalId,
            status:         'PENDING',
            amountGhs,
            recipientPhone: this._sanitizeMsisdn(recipientPhone),
            payerMessage,
            payeeNote,
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
            message:        'Mock MTN MoMo accepted disbursement (PENDING).',
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

module.exports = MtnDisbursementService;
