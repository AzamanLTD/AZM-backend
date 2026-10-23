// services/gatewayService.js
// =============================================================================
// AZAMAN V2 — KOTANI PAY V3 GATEWAY SERVICE  (Phase B)
//
// Mirrors the Kotani Pay V3 API surface for two flows:
//   1. Off-ramp rate quote   — POST /api/v3/rate/offramp (documented v3
//      contract: JSON body {from, to, cryptoAmount}; the rate is returned
//      as data.value — a GET with query params is NOT the v3 surface and
//      previously made every LIVE call fail into a silent MOCK fallback)
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

const logger = require('../src/config/logger');
const axios  = require('axios');
const crypto = require('crypto');
// Single source of parsing truth for the SAME documented endpoint
// (POST /api/v3/rate/offramp): the oracle's extractor + pair
// validation. The gateway must never parse this payload shape
// independently.
const { extractKotaniRate, kotaniPairMatches } = require('./oracleService');

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
            logger.info('[GatewayService] Running in MOCK mode (set KOTANI_API_KEY + KOTANI_PROVIDER=LIVE for live calls).');
        } else {
            logger.info(`[GatewayService] Running in LIVE mode → ${this.baseUrl}`);
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
            // 2026-10-17 (A3) — the LIVE path previously issued a GET with
            // query params (the v3 rate endpoint is POST with a JSON body)
            // and read data.rate/data.corporateRate — fields the documented
            // v3 envelope never carries — so EVERY LIVE call failed and
            // silently fell back to MOCK rates while the logs claimed LIVE.
            // It also failed OPEN for the war-room OTC quote: the admin
            // corporate buy traded at a fabricated rate whenever Kotani
            // hiccuped. The path now makes the documented call, validates
            // the response exactly like the oracle (success + echoed pair
            // + usable rate), and FAILS CLOSED on any failure — null, not
            // a MOCK rate. MOCK is an explicit provider configuration
            // (KOTANI_PROVIDER unset), never a fallback state.
            try {
                const { data } = await axios.post(
                    `${this.baseUrl}${RATE_ENDPOINT}`,
                    {
                        from:         SUPPORTED_CRYPTO,
                        to:           SUPPORTED_FIAT_CURRENCY,
                        cryptoAmount: 1,
                    },
                    {
                        headers: this._authHeaders(),
                        timeout: 10000,
                    }
                );
                // Strict-schema review (2026-10-23): the documented v3
                // contract declares success:true on a usable response —
                // an ABSENT or non-true declaration (undefined, null,
                // "1", anything else) is a contract violation and must
                // FAIL CLOSED, exactly like the oracle path. The earlier
                // `=== false` check silently accepted a response whose
                // success field was missing entirely.
                if (data?.success !== true) {
                    throw new Error(
                        `[KOTANI_GATEWAY_SUCCESS_DECLARATION] Kotani offramp rates did not explicitly declare success:true `
                        + `(success=${JSON.stringify(data?.success ?? null)}, message=${JSON.stringify(data?.message ?? null)}) `
                        + '— failing closed, no MOCK fallback.'
                    );
                }
                if (!kotaniPairMatches(data, SUPPORTED_CRYPTO, SUPPORTED_FIAT_CURRENCY)) {
                    throw new Error(
                        `Kotani pair mismatch: requested ${SUPPORTED_CRYPTO}->${SUPPORTED_FIAT_CURRENCY}, `
                        + `echoed ${JSON.stringify(data?.data?.from ?? null)}->${JSON.stringify(data?.data?.to ?? null)}`
                    );
                }
                // The documented offramp envelope carries ONE rate
                // (data.value). There is no separate corporate/OTC feed in
                // the v3 surface, so LIVE corporate === retail (spread 0)
                // — the truthful answer, not a fabricated discount.
                const retail = extractKotaniRate(data);
                if (!retail) {
                    throw new Error('Kotani rate response did not contain a usable rate (data.value).');
                }
                return {
                    provider:      PROVIDER_NAME,
                    currency:      SUPPORTED_FIAT_CURRENCY,
                    retailRate:    retail,
                    corporateRate: retail,
                    spread:        0,
                    validUntil:    new Date(Date.now() + 5 * 60_000).toISOString(),
                    source:        'LIVE'
                };
            } catch (err) {
                logger.error({ err: err }, '[GatewayService.fetchOfframpRates] LIVE call failed → FAILING CLOSED (no MOCK fallback)');
                return null; // fail closed — the caller (war-room OTC quote) 503s
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
     * ECHO-ONLY rate sync — persists the corporate (admin OTC) rate into
     * GlobalSettings (singleton id=1). Driven on a 5-minute interval by
     * .startRateSync().
     *
     * Provenance contract (issue #271 / PR 271B; Kotani-only authority,
     * 2026-10-16 wave; A3 hardening 2026-10-17):
     *   The ORACLE is the single canonical writer of the transaction-rate
     *   fields (liveRetailRate / liveUsdToGhs / liveRateSource =
     *   'KOTANI_PAY' / lastRateSync / lastExternalSync). This loop is
     *   RETIRED as a rate source: previously a successful LIVE fetch here
     *   stamped ALL of those canonical fields a SECOND time from its own
     *   (previously broken GET-based) call — a competing writer that
     *   could disagree with the oracle's validated observation. It now
     *   only EVER writes the corporate rate and lastEchoAt, in every
     *   provider mode: liveCorporateRate is derived from the canonical
     *   current retail snapshot (liveRetailRate), never from an
     *   independent fetch, so the oracle's USDC adjustment can no longer
     *   be erased and no second writer exists.
     *
     * liveRetailRate, liveUsdToGhs, liveRateSource, lastRateSync and
     * lastExternalSync are NEVER touched by this method.
     */
    async syncRatesToGlobalSettings() {
        try {
            // Cached-value copy, NOT an external observation. Derive the
            // corporate rate from the canonical current retail snapshot
            // (liveRetailRate), never from the echoed liveUsdToGhs →
            // liveRetailRate overwrite that previously erased the oracle's
            // USDC adjustment every 5 minutes.
            const settings   = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
            const retailRate = Number(settings?.liveRetailRate ?? 12.5);
            const corporate  = parseFloat((retailRate * (1 - MOCK_CORPORATE_DISCOUNT)).toFixed(6));
            const echoAt     = new Date();
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update: {
                    liveCorporateRate: corporate,
                    lastEchoAt:        echoAt
                },
                create: {
                    id: 1,
                    liveCorporateRate: corporate,
                    lastEchoAt:        echoAt
                }
            });
            logger.info(
                `[GatewayService] Rate echo ✓ (cached retail preserved: ${retailRate}) ` +
                `corporate=${corporate} (echo-only: canonical fields untouched)`
            );
            return {
                provider:      PROVIDER_NAME,
                currency:      SUPPORTED_FIAT_CURRENCY,
                retailRate,   // the canonical snapshot, for display only
                corporateRate: corporate,
                spread:        Math.max(0, parseFloat((retailRate - corporate).toFixed(6))),
                validUntil:    echoAt.toISOString(),
                source:        'ECHO'
            };
        } catch (err) {
            logger.error({ err: err }, '[GatewayService] Rate sync failed');
            return null;
        }
    }

    /**
     * Boot the periodic rate sync. Mirrors OracleService.startOracle().
     */
    startRateSync() {
        logger.info(`[GatewayService] Rate sync booting (interval: ${this.syncIntervalMs / 1000}s)`);
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
        // B fix (lead review 2026-10-17): anchor to the canonical
        // liveRetailRate snapshot (the oracle no longer writes
        // liveUsdToGhs); legacy field kept only as the admin-override
        // fallback.
        const retailRate  = (Number(settings?.liveRetailRate) > 0)
            ? Number(settings.liveRetailRate)
            : Number(settings?.liveUsdToGhs ?? 12.5);
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
