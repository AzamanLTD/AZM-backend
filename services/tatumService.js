// services/tatumService.js
// =============================================================================
// AZAMAN V2 — TATUM WEB3 INTEGRATION SERVICE   (Phase C: Polygon On-Chain)
//
// Purpose
// -------
// Derives Polygon (MATIC) HD wallet deposit addresses for users using the
// Tatum REST API. Each user gets a unique address derived from the platform's
// master xpub at derivation index === user.id. This allows the platform to:
//
//   1. Assign a permanent, deterministic on-chain deposit address per user.
//   2. Receive inbound USDC (Polygon) deposits via Tatum webhook notifications.
//   3. Sweep deposited funds into the Master Treasury (SYSTEM_MASTER_CRYPTO).
//
// Tatum API Endpoints Used
// -------------------------
//   • POST https://api.tatum.io/v3/polygon/address/{xpub}/{index}
//     Derives an address from the HD wallet xpub at the given index.
//     Header: x-api-key: <TATUM_API_KEY>
//
//   • POST https://api.tatum.io/v3/subscription
//     Creates a webhook subscription to monitor the derived address.
//     Header: x-api-key: <TATUM_API_KEY>
//     Body: { type: 'ADDRESS_TRANSACTION', attr: { address, chain: 'MATIC', url } }
//
// Modes
// -----
//   • LIVE — when TATUM_API_KEY + TATUM_XPUB are set AND TATUM_PROVIDER === 'LIVE'.
//   • MOCK — default. Generates deterministic mock addresses using a hash of
//     the xpub placeholder + user index. No external calls.
//
// Environment Variables
// ---------------------
//   TATUM_API_KEY            — Tatum API key (mainnet or testnet)
//   TATUM_XPUB              — Polygon HD wallet extended public key
//   TATUM_PROVIDER           — 'LIVE' to enable real API calls; else MOCK
//   TATUM_WEBHOOK_SECRET     — HMAC secret for verifying inbound webhooks
//   TATUM_WEBHOOK_URL        — Public URL Tatum will POST deposit events to
//
// This module does NOT touch Prisma. Ledger writes are owned by
// services/finance.service.js (processCryptoDeposit).
// =============================================================================

const axios          = require('axios');
const crypto         = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────
const PROVIDER_NAME    = 'TATUM_POLYGON';
const DEFAULT_BASE_URL = 'https://api.tatum.io/v3';
const CHAIN            = 'MATIC';

class TatumService {
    constructor(opts = {}) {
        this.apiKey         = process.env.TATUM_API_KEY         || null;
        this.xpub           = process.env.TATUM_XPUB            || null;
        this.webhookSecret  = process.env.TATUM_WEBHOOK_SECRET  || null;
        this.webhookUrl     = process.env.TATUM_WEBHOOK_URL     || null;
        this.baseUrl        = process.env.TATUM_BASE_URL        || DEFAULT_BASE_URL;

        const credsPresent  = this.apiKey && this.xpub;
        this.providerMode   = (process.env.TATUM_PROVIDER === 'LIVE' && credsPresent)
            ? 'LIVE'
            : 'MOCK';

        // Cache of derived addresses: index → address (avoids repeat API calls)
        this._addressCache = new Map();

        if (this.providerMode === 'MOCK') {
            console.log(
                '[TatumService] Running in MOCK mode ' +
                '(set TATUM_API_KEY + TATUM_XPUB + TATUM_PROVIDER=LIVE for live calls).'
            );
        } else {
            console.log(`[TatumService] Running in LIVE mode → ${this.baseUrl}`);
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Derive the Polygon deposit address for a user by their ID (used as the
     * HD wallet derivation index). Returns the address string.
     *
     * In LIVE mode: calls Tatum's GET /v3/polygon/address/{xpub}/{index}.
     * In MOCK mode: generates a deterministic 0x-prefixed address from a hash.
     *
     * @param {number} userId — derivation index
     * @returns {Promise<{ address: string, derivationIndex: number, source: 'LIVE'|'MOCK' }>}
     */
    async deriveDepositAddress(userId) {
        const index = parseInt(userId, 10);
        if (isNaN(index) || index < 0) {
            throw new Error('[TatumService] userId must be a non-negative integer (derivation index).');
        }

        // Return cached if available
        if (this._addressCache.has(index)) {
            return {
                address:          this._addressCache.get(index),
                derivationIndex:  index,
                source:           this.providerMode
            };
        }

        if (this.providerMode === 'MOCK') {
            return this._mockDeriveAddress(index);
        }

        // ── LIVE path ────────────────────────────────────────────────────────
        try {
            const { data } = await axios.get(
                `${this.baseUrl}/polygon/address/${this.xpub}/${index}`,
                {
                    headers: { 'x-api-key': this.apiKey },
                    timeout: 10000
                }
            );

            const address = data.address;
            this._addressCache.set(index, address);

            return { address, derivationIndex: index, source: 'LIVE' };
        } catch (err) {
            const apiMsg = err.response?.data?.message || err.message;
            throw new Error(`[TatumService] Address derivation failed: ${apiMsg}`);
        }
    }

    /**
     * Subscribe a derived address to Tatum's webhook notification system so
     * inbound deposits trigger a POST to our webhook endpoint.
     *
     * @param {string} address — the Polygon address to monitor
     * @returns {Promise<{ subscriptionId: string|null, source: 'LIVE'|'MOCK' }>}
     */
    async subscribeAddress(address) {
        if (!address) {
            throw new Error('[TatumService] address is required for subscription.');
        }

        if (this.providerMode === 'MOCK') {
            const mockSubId = `sub_mock_${crypto.createHash('md5').update(address).digest('hex').slice(0, 16)}`;
            return { subscriptionId: mockSubId, source: 'MOCK' };
        }

        if (!this.webhookUrl) {
            console.warn('[TatumService] TATUM_WEBHOOK_URL not set — skipping subscription.');
            return { subscriptionId: null, source: 'LIVE' };
        }

        try {
            const { data } = await axios.post(
                `${this.baseUrl}/subscription`,
                {
                    type: 'ADDRESS_TRANSACTION',
                    attr: {
                        address,
                        chain: CHAIN,
                        url:   this.webhookUrl
                    }
                },
                {
                    headers: {
                        'x-api-key':    this.apiKey,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            return { subscriptionId: data.id || null, source: 'LIVE' };
        } catch (err) {
            const apiMsg = err.response?.data?.message || err.message;
            console.error(`[TatumService] Subscription failed for ${address}: ${apiMsg}`);
            // Non-fatal — the address is still valid, just won't get webhook pushes
            return { subscriptionId: null, source: 'LIVE' };
        }
    }

    /**
     * Verify the HMAC signature of an inbound Tatum webhook payload.
     * Tatum sends the HMAC in the `x-payload-hash` header using SHA-512.
     *
     * @param {string} rawBody — the raw request body as a string
     * @param {string} signatureHeader — value of the x-payload-hash header
     * @returns {boolean}
     */
    verifyWebhookSignature(rawBody, signatureHeader) {
        if (!this.webhookSecret) {
            console.warn('[TatumService] TATUM_WEBHOOK_SECRET not set — cannot verify HMAC.');
            return false;
        }
        if (!signatureHeader || !rawBody) {
            return false;
        }

        const computed = crypto
            .createHmac('sha512', this.webhookSecret)
            .update(rawBody, 'utf8')
            .digest('hex');

        // Timing-safe comparison
        try {
            return crypto.timingSafeEqual(
                Buffer.from(computed, 'hex'),
                Buffer.from(signatureHeader, 'hex')
            );
        } catch {
            return false;
        }
    }

    /**
     * Given a deposit address, attempt to look up which user owns it.
     * This is a utility that queries prisma — callers must pass prisma in.
     *
     * @param {object} prisma — PrismaClient instance
     * @param {string} address — Polygon address (lowercase comparison)
     * @returns {Promise<{ id: number, username: string }|null>}
     */
    async lookupUserByAddress(prisma, address) {
        if (!address) return null;
        const user = await prisma.user.findFirst({
            where:  { tatumPolygonAddress: address.toLowerCase() },
            select: { id: true, username: true }
        });
        return user || null;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    _mockDeriveAddress(index) {
        // Deterministic mock: sha256(MOCK_XPUB + index) → take first 40 hex chars → 0x prefix
        const seed    = `MOCK_AZAMAN_XPUB_${index}`;
        const hash    = crypto.createHash('sha256').update(seed).digest('hex');
        const address = '0x' + hash.slice(0, 40);
        this._addressCache.set(index, address);
        return Promise.resolve({
            address,
            derivationIndex: index,
            source:          'MOCK'
        });
    }
}

module.exports = TatumService;
