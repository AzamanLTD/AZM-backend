// services/gatewayService.js
// =============================================================================
// AZAMAN V2 — KOTANI PAY V3 GATEWAY SERVICE  (Phase B)
//
// Mirrors the Kotani Pay V3 API surface for two flows:
//   1. Off-ramp rate quote   — GET  /api/v3/rate/offramp
//   2. Mobile-money payout   — POST /api/v3/payouts/mobile-money
//   3. Payout status poll    — GET  /api/v3/payouts/{reference}/status
//
// MODES
// -----
//   • LIVE  — used when KOTANI_API_KEY is set AND KOTANI_PROVIDER === 'LIVE'.
//   • MOCK  — default. Deterministic in-memory adapter, anchored to the live
//             oracle so retail rate ≈ GlobalSettings.liveUsdToGhs and the
//             corporate (admin-buy) rate is retail × (1 - MOCK_DISCOUNT).
//
// The class is instantiated once in server.js with the shared Prisma client
// and started via .startRateSync(). The rate-sync loop persists the live
// retail/corporate pair into GlobalSettings every 5 minutes so the rest of
// the codebase reads from a single source (the GlobalSettings singleton).
// =============================================================================

const axios  = require('axios');
const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────────────────
const PROVIDER_NAME            = 'KOTANI_PAY';
const DEFAULT_BASE_URL         = 'https://api.kotanipay.com';
const RATE_ENDPOINT            = '/api/v3/rate/offramp';
const PAYOUT_ENDPOINT          = '/api/v3/payouts/mobile-money';
const STATUS_ENDPOINT          = (ref) => `/api/v3/payouts/${ref}/status`;
const SUPPORTED_FIAT_CURRENCY  = 'GHS';
const SUPPORTED_CRYPTO         = 'USDC';

// Mock spread between retail (user-facing Hologram) and corporate (admin OTC
// buy) rates. 1.5 % below retail is a realistic stablecoin off-ramp discount.
const MOCK_CORPORATE_DISCOUNT  = 0.015;

// Default to a 5-minute sync cadence — same shape as OracleService.
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

class GatewayService {
    constructor(prisma, opts = {}) {
        this.prisma         = prisma;
        this.apiKey         = process.env.KOTANI_API_KEY     || null;
        this.baseUrl        = process.env.KOTANI_API_BASE_URL || DEFAULT_BASE_URL;
        this.providerMode   = (process.env.KOTANI_PROVIDER === 'LIVE' && this.apiKey) ? 'LIVE' : 'MOCK';
        this.syncIntervalMs = opts.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS;
        this._mockPayouts   = new Map();   // reference → mock state (for status polling + simulateInbound)

        if (this.providerMode === 'MOCK') {
            console.log('[GatewayService] Running in MOCK mode (set KOTANI_API_KEY + KOTANI_PROVIDER=LIVE for live calls).');
        } else {
            console.log(`[GatewayService] Running in LIVE mode → ${this.baseUrl}`);
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Fetch the current retail (UI Hologram) and corporate (OTC) off-ramp
     * rates for USDC → GHS.
     *
     * @returns {Promise<{
     *   provider: string,
     *   currency: string,
     *   retailRate: number,
     *   corporateRate: number,
     *   spread: number,
     *   validUntil: string,
     *   source: 'LIVE'|'MOCK'
     * }>}
     */
    async fetchOfframpRates() {
        if (this.providerMode === 'LIVE') {
            try {
                const { data } = await axios.get(`${this.baseUrl}${RATE_ENDPOINT}`, {
                    params:  { from: SUPPORTED_CRYPTO, to: SUPPORTED_FIAT_CURRENCY },
                    headers: this._authHeaders(),
                    timeout: 10000
                });
                const retail    = parseFloat(data.rate ?? data.retailRate);
                const corporate = parseFloat(data.corporateRate ?? data.otcRate ?? retail);
                if (!Number.isFinite(retail) || !Number.isFinite(corporate) || retail <= 0) {
                    throw new Error('Kotani returned a non-numeric rate.');
                }
                return {
                    provider:      PROVIDER_NAME,
                    currency:      SUPPORTED_FIAT_CURRENCY,
                    retailRate:    retail,
                    corporateRate: corporate,
                    spread:        Math.max(0, parseFloat((retail - corporate).toFixed(6))),
                    validUntil:    data.validUntil || new Date(Date.now() + 5 * 60_000).toISOString(),
                    source:        'LIVE'
                };
            } catch (err) {
                console.error('[GatewayService.fetchOfframpRates] LIVE call failed → falling back to MOCK:', err.message);
                // Fall through — never let a transient gateway outage break the platform.
            }
        }
        return this._mockOfframpRates();
    }

    /**
     * Initiate a mobile-money payout (USDC → GHS via Kotani).
     *
     * @param {{
     *   amountGhs: number,
     *   recipientPhone: string,
     *   network: 'MTN'|'TELECEL'|'AIRTELTIGO',  // VODAFONE accepted as legacy alias
     *   reference: string,                       // idempotency key — reuses TransactionHistory.txHash
     *   accountName?: string
     * }} payload
     *
     * @returns {Promise<{
     *   provider: string,
     *   reference: string,
     *   providerTxId: string,
     *   status: 'PENDING'|'SUCCESS'|'FAILED',
     *   amountGhs: number,
     *   message: string,
     *   source: 'LIVE'|'MOCK'
     * }>}
     */
    async initiateMobileMoneyPayout(payload) {
        const { amountGhs, recipientPhone, network, reference, accountName } = payload || {};

        if (!reference || typeof reference !== 'string') {
            throw new Error('[GatewayService] reference is required (use the TransactionHistory.txHash idempotency key).');
        }
        if (!amountGhs || Number(amountGhs) <= 0) {
            throw new Error('[GatewayService] amountGhs must be positive.');
        }
        if (!recipientPhone) {
            throw new Error('[GatewayService] recipientPhone is required.');
        }

        if (this.providerMode === 'LIVE') {
            try {
                const { data } = await axios.post(`${this.baseUrl}${PAYOUT_ENDPOINT}`, {
                    amount:             amountGhs,
                    currency:           SUPPORTED_FIAT_CURRENCY,
                    recipient_phone:    recipientPhone,
                    network,
                    account_name:       accountName,
                    external_reference: reference
                }, {
                    headers: this._authHeaders(),
                    timeout: 15000
                });
                return {
                    provider:     PROVIDER_NAME,
                    reference,
                    providerTxId: data.id || data.transactionId || data.transaction_id,
                    status:       (data.status || 'PENDING').toUpperCase(),
                    amountGhs:    Number(amountGhs),
                    message:      data.message || 'Payout accepted by gateway.',
                    source:       'LIVE'
                };
            } catch (err) {
                const apiMsg = err.response?.data?.message || err.message;
                throw new Error(`[GatewayService] Kotani payout rejected: ${apiMsg}`);
            }
        }

        return this._mockInitiatePayout(payload);
    }

    /**
     * Poll the gateway for the current state of a payout. Used by the admin
     * War Room UI and by reconciliation jobs.
     */
    async getPayoutStatus(reference) {
        if (!reference) throw new Error('[GatewayService] reference is required.');

        if (this.providerMode === 'LIVE') {
            try {
                const { data } = await axios.get(`${this.baseUrl}${STATUS_ENDPOINT(reference)}`, {
                    headers: this._authHeaders(),
                    timeout: 10000
                });
                return {
                    provider:     PROVIDER_NAME,
                    reference,
                    providerTxId: data.id,
                    status:       (data.status || 'PENDING').toUpperCase(),
                    source:       'LIVE'
                };
            } catch (err) {
                const apiMsg = err.response?.data?.message || err.message;
                throw new Error(`[GatewayService] Kotani status lookup failed: ${apiMsg}`);
            }
        }
        return this._mockGetPayoutStatus(reference);
    }

    /**
     * Fetch fresh rates and persist them to GlobalSettings (singleton id=1).
     * Driven on a 5-minute interval by .startRateSync().
     */
    async syncRatesToGlobalSettings() {
        try {
            const rates = await this.fetchOfframpRates();
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update: {
                    liveRetailRate:    rates.retailRate,
                    liveCorporateRate: rates.corporateRate,
                    liveRateSource:    rates.source,
                    lastRateSync:      new Date(),
                    // Keep liveUsdToGhs in sync so legacy code paths (oracle,
                    // p2p.completeTrade margin math, depositController) keep
                    // returning the same Hologram value.
                    liveUsdToGhs:      rates.retailRate
                },
                create: {
                    id: 1,
                    liveRetailRate:    rates.retailRate,
                    liveCorporateRate: rates.corporateRate,
                    liveRateSource:    rates.source,
                    lastRateSync:      new Date(),
                    liveUsdToGhs:      rates.retailRate
                }
            });
            console.log(
                `[GatewayService] Rate sync ✓ retail=${rates.retailRate} ` +
                `corporate=${rates.corporateRate} source=${rates.source}`
            );
            return rates;
        } catch (err) {
            console.error('[GatewayService] Rate sync failed:', err.message);
            return null;
        }
    }

    /**
     * Boot the periodic rate sync. Mirrors OracleService.startOracle().
     */
    startRateSync() {
        console.log(`[GatewayService] Rate sync booting (interval: ${this.syncIntervalMs / 1000}s)`);
        this.syncRatesToGlobalSettings();   // fire once immediately
        setInterval(() => this.syncRatesToGlobalSettings(), this.syncIntervalMs);
    }

    /**
     * MOCK-ONLY helper. Forces an in-memory tracked payout into a terminal
     * state so tests (and the admin-only simulate endpoint) can drive the
     * settlement webhook locally. Returns null in LIVE mode.
     */
    simulateInboundWebhook(reference, status) {
        if (this.providerMode !== 'MOCK') return null;
        const entry = this._mockPayouts.get(reference);
        if (!entry) return null;
        entry.status = (status || 'SUCCESS').toUpperCase();
        entry.settledAt = new Date().toISOString();
        this._mockPayouts.set(reference, entry);
        return entry;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    _authHeaders() {
        return {
            'Content-Type': 'application/json',
            'x-api-key':    this.apiKey || 'mock-kotani-api-key'
        };
    }

    async _mockOfframpRates() {
        // Anchor mock retail rate to the live oracle snapshot. If the oracle
        // hasn't run yet, fall back to the schema default (12.50). The
        // corporate rate is a realistic OTC discount below retail.
        const settings    = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const retailRate  = settings?.liveUsdToGhs ?? 12.5;
        const corporate   = parseFloat((retailRate * (1 - MOCK_CORPORATE_DISCOUNT)).toFixed(6));
        return {
            provider:      PROVIDER_NAME,
            currency:      SUPPORTED_FIAT_CURRENCY,
            retailRate:    parseFloat(retailRate.toFixed(6)),
            corporateRate: corporate,
            spread:        parseFloat((retailRate - corporate).toFixed(6)),
            validUntil:    new Date(Date.now() + 5 * 60_000).toISOString(),
            source:        'MOCK'
        };
    }

    _mockInitiatePayout({ amountGhs, recipientPhone, network, reference, accountName }) {
        const providerTxId = `MOCK_KP_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const entry = {
            provider:       PROVIDER_NAME,
            reference,
            providerTxId,
            status:         'PENDING',
            amountGhs:      Number(amountGhs),
            recipientPhone,
            network:        network || 'MTN',
            accountName:    accountName || null,
            createdAt:      new Date().toISOString(),
            source:         'MOCK'
        };
        this._mockPayouts.set(reference, entry);
        return Promise.resolve({
            ...entry,
            message: 'Mock gateway accepted payout (PENDING).'
        });
    }

    _mockGetPayoutStatus(reference) {
        const entry = this._mockPayouts.get(reference);
        if (!entry) {
            return Promise.resolve({
                provider:     PROVIDER_NAME,
                reference,
                providerTxId: null,
                status:       'UNKNOWN',
                source:       'MOCK'
            });
        }
        return Promise.resolve({
            provider:     PROVIDER_NAME,
            reference,
            providerTxId: entry.providerTxId,
            status:       entry.status,
            amountGhs:    entry.amountGhs,
            source:       'MOCK'
        });
    }
}

module.exports = GatewayService;
