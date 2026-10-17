// services/oracleService.js
const logger = require('../src/config/logger');
const axios = require('axios');

const KOTANI_DEFAULT_BASE_URL = 'https://sandbox-api.kotanipay.io/api/v3';

const asFinitePositive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};

// ── KOTANI V3 RESPONSE CONTRACT (2026-10-17 hardening, A2) ────────────────
//
// The documented POST /api/v3/rate/offramp response shape is
//   { "success": true, "message": "Available exchange rate.",
//     "data": { "from": "USDC", "to": "GHS", "value": "15.53",
//               "fiatAmount": ..., "cryptoAmount": ..., "fee": ... } }
// (https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate).
// The rate lives in data.value AS A STRING; the pair is echoed in
// data.from/data.to. Auth/quota failures can arrive as HTTP 200 with
// success:false and an empty data object — so an explicit success:false
// must fail closed, and the echoed pair must be validated before an
// observation is trusted: a misconfigured from/to (or an off-target
// response) must never write a foreign-pair rate into the canonical
// USDC/GHS slot.
const extractKotaniRate = (payload) => {
    // A 200 envelope that explicitly says failure is a failure.
    if (payload?.success === false) return null;
    const candidates = [
        // Documented v3 shape first: data.value (string rate).
        payload?.data?.value,
        payload?.value,
        // Legacy/observed shapes retained (parse-only; all are gated by
        // the same finite-positive check).
        payload?.rate,
        payload?.exchangeRate,
        payload?.data?.rate,
        payload?.data?.exchangeRate,
        payload?.result?.rate,
        payload?.result?.exchangeRate,
    ];
    for (const candidate of candidates) {
        const rate = asFinitePositive(candidate);
        if (rate) return rate;
    }

    const cryptoAmount = asFinitePositive(
        payload?.cryptoAmount ?? payload?.data?.cryptoAmount ?? payload?.result?.cryptoAmount
    );
    const fiatAmount = asFinitePositive(
        payload?.fiatAmount ?? payload?.data?.fiatAmount ?? payload?.result?.fiatAmount
    );
    if (cryptoAmount && fiatAmount) return fiatAmount / cryptoAmount;

    return null;
};

// C-prefix equivalence: the Kotani `from` enum lists C-prefixed
// stablecoins (CGHS, CKES...) that denote the same national currency as
// their unprefixed fiat code. A request for GHS may be echoed as CGHS
// (or vice versa) and still be the pair we asked for.
const sameCurrencyCode = (requested, echoed) => {
    if (requested === undefined || requested === null || echoed === undefined || echoed === null) {
        return false;
    }
    const a = String(requested).trim().toUpperCase();
    const b = String(echoed).trim().toUpperCase();
    return a === b || a === 'C' + b || b === 'C' + a;
};

// Validates that the response echoes the pair we requested. Fail-closed
// semantics: a response with NO echoed pair, or a mismatched one, must
// never be trusted as the requested rate.
const kotaniPairMatches = (payload, expectedFrom, expectedTo) => {
    const echoedFrom = payload?.data?.from ?? payload?.from;
    const echoedTo = payload?.data?.to ?? payload?.to;
    if (!sameCurrencyCode(expectedFrom, echoedFrom)) return false;
    if (!sameCurrencyCode(expectedTo, echoedTo)) return false;
    return true;
};

class OracleService {
    constructor(prisma) {
        this.prisma = prisma;
        this.updateInterval = 10 * 60 * 1000;
        this.rateAlertService = null;
    }

    startOracle() {
        logger.info('🌐 Azaman Live Market Oracle: INITIALIZED');
        this.logKotaniConfigAudit();
        this.fetchAndUpdateRates();
        setInterval(() => this.fetchAndUpdateRates(), this.updateInterval);
    }

    // ── SANDBOX-FALLBACK HARDENING (review follow-up on PR #353) ──────────
    //
    // Risk A — a misconfigured deployment is silent. `provider !== 'LIVE'`
    // or a placeholder token made the oracle return null and collapse
    // into the SAME generic fail-closed log as a Kotani outage: a
    // production deployment missing KOTANI_PROVIDER/KOTANI_API_TOKEN was
    // indistinguishable from an outage until quotes began failing
    // RATE_STALE. The arm state is now computed in ONE place, logged ONCE
    // LOUDLY at startup, and every cycle's fail-closed log names WHICH of
    // the two states it is (CONFIG_DISABLED vs UNAVAILABLE).
    //
    // Risk B — the DEFAULT base URL is the SANDBOX endpoint. A LIVE
    // provider with KOTANI_API_BASE_URL unset silently sent production
    // traffic to sandbox-api.kotanipay.io — a sandbox fallback baked into
    // the default. Using the sandbox during onboarding is legitimate, but
    // it must be an EXPLICIT choice: the startup audit names the endpoint
    // and says when it is the default-sandbox one, so promotion can be
    // checked from the logs at a glance.
    kotaniConfigState() {
        const provider = String(process.env.KOTANI_PROVIDER || 'MOCK').toUpperCase();
        const token = process.env.KOTANI_API_TOKEN || process.env.KOTANI_API_KEY;
        const explicitBaseUrl = process.env.KOTANI_API_BASE_URL
            ? String(process.env.KOTANI_API_BASE_URL).replace(/\/$/, '')
            : null;
        const baseUrl = explicitBaseUrl || KOTANI_DEFAULT_BASE_URL;
        if (provider !== 'LIVE') {
            return {
                armed: false,
                state: 'CONFIG_DISABLED',
                detail: `KOTANI_PROVIDER='${provider}' — the canonical transaction-rate source is DISABLED BY CONFIGURATION. `
                    + 'Quotes fail closed (RATE_UNAVAILABLE/RATE_STALE) once the cached observation ages out. '
                    + 'Set KOTANI_PROVIDER=LIVE with a real KOTANI_API_TOKEN to arm it.',
                provider,
                baseUrl,
                baseUrlExplicit: !!explicitBaseUrl,
            };
        }
        if (!token || token === 'mock-key') {
            return {
                armed: false,
                state: 'MISSING_TOKEN',
                detail: `KOTANI_PROVIDER=LIVE but the token is ${token ? "the placeholder 'mock-key'" : 'not set'} `
                    + '(KOTANI_API_TOKEN/KOTANI_API_KEY). The canonical transaction-rate source is DISABLED BY '
                    + 'CONFIGURATION; quotes fail closed once the cached observation ages out.',
                provider,
                baseUrl,
                baseUrlExplicit: !!explicitBaseUrl,
            };
        }
        return {
            armed: true,
            state: 'ARMED',
            detail: explicitBaseUrl
                ? `Kotani LIVE provider ARMED against ${explicitBaseUrl}.`
                : `Kotani LIVE provider ARMED — KOTANI_API_BASE_URL is NOT SET, so the DEFAULT SANDBOX endpoint is in use (${KOTANI_DEFAULT_BASE_URL}). `
                    + 'Legitimate during onboarding, but set the production endpoint explicitly before go-live.',
            provider,
            baseUrl,
            baseUrlExplicit: !!explicitBaseUrl,
        };
    }

    // One loud, startup-visible statement of the arm state (Risk A/B).
    logKotaniConfigAudit() {
        const cfg = this.kotaniConfigState();
        if (cfg.armed) {
            const log = cfg.baseUrlExplicit ? logger.info : logger.warn;
            log(`[Oracle] Kotani config audit: ${cfg.detail}`);
        } else {
            logger.error(`[Oracle] Kotani config audit: ${cfg.detail}`);
        }
        return cfg;
    }

    async fetchKotaniUsdcToGhsRate() {
        const cfg = this.kotaniConfigState();
        if (!cfg.armed) {
            // Distinct, greppable per-cycle tag: an operator can tell a
            // DISABLED-BY-CONFIG deployment from a Kotani outage instantly.
            logger.error(
                `[Oracle] [KOTANI_CONFIG_DISABLED] ${cfg.state}: no Kotani observation will be attempted this cycle. ${cfg.detail}`
            );
            return null;
        }

        const baseUrl = cfg.baseUrl;
        const from = process.env.KOTANI_RATE_FROM || 'USDC';
        // The documented `to` is the FIAT payout currency code (docs
        // example: "EUR"); CGHS is a stablecoin listed in the `from` enum,
        // not the fiat code for a cedi offramp. KOTANI_RATE_TO remains the
        // explicit override for operators.
        const to = process.env.KOTANI_RATE_TO || 'GHS';
        const response = await axios.post(`${baseUrl}/rate/offramp`, {
            from,
            to,
            cryptoAmount: 1,
        }, {
            headers: { Authorization: `Bearer ${process.env.KOTANI_API_TOKEN || process.env.KOTANI_API_KEY}` },
            timeout: 8000,
        });

        // A2 hardening: the response must explicitly declare success, echo
        // the requested pair, and carry a usable rate — anything else is
        // an unvalidated observation and fails closed with a distinct,
        // greppable tag.
        if (response.data?.success === false) {
            throw new Error(
                `[KOTANI_RATE_REJECTED] Kotani returned success:false (${response.data?.message ?? 'no message'}) `
                + '— the observation is rejected, not parsed.'
            );
        }
        if (!kotaniPairMatches(response.data, from, to)) {
            const echoedFrom = response.data?.data?.from ?? response.data?.from;
            const echoedTo = response.data?.data?.to ?? response.data?.to;
            throw new Error(
                `[KOTANI_RATE_PAIR_MISMATCH] requested ${from}->${to} but Kotani echoed `
                + `${JSON.stringify(echoedFrom ?? null)}->${JSON.stringify(echoedTo ?? null)} `
                + '— a foreign-pair response must never write the canonical USDC/GHS rate.'
            );
        }
        const rate = extractKotaniRate(response.data);
        if (!rate) throw new Error('[KOTANI_RATE_UNPARSEABLE] Kotani Pay rate response did not contain a usable USDC/GHS rate.');
        return rate;
    }

    // §Kotani-only transaction-rate authority (2026-10-16 hardening wave).
    //
    // Kotani Pay is the single canonical USDC/GHS transaction-rate provider.
    // The contract, preserved from the §271 per-source isolation work and
    // tightened from "fallback allowed" to "Kotani-only":
    //
    //   • ONLY a successfully validated Kotani observation may write the
    //     transaction-eligible liveRetailRate, the canonical liveRateSource
    //     ('KOTANI_PAY') and the freshness timestamps
    //     (lastRateSync === lastExternalSync, one observation, both fields —
    //     the 271B contract).
    //
    //   • The legacy CoinGecko USDC/USD × external USD/GHS FX composite is
    //     RETIRED as a rate source: it must never write liveRetailRate /
    //     liveRateSource and must never refresh canonical transaction-rate
    //     freshness. A successful supplementary feed must not launder the
    //     cached rate into "fresh" — a cached old value stays old.
    //
    //   • Stablecoin prices (tether/usdc/dai vs USD) remain SUPPLEMENTARY
    //     DISPLAY-ONLY data: cached in their dedicated non-authoritative
    //     GlobalSettings fields, never blocking the canonical write, and
    //     never advancing any freshness timestamp. When Kotani is missing
    //     (unconfigured/MOCK), fails, returns malformed data, or is stale,
    //     the sync performs at most this supplementary display refresh and
    //     NOTHING else — new rate-dependent financial quotes fail closed at
    //     the /rateFreshness gate (RATE_STALE / RATE_UNAVAILABLE).
    //
    //   Repeated Kotani failure: cached values and ALL timestamps stay
    //   untouched — no code path can present the frozen number as fresh.
    //   Recovery: the next successful Kotani observation simply resumes.
    async fetchStablecoinUsdPrices() {
        const cryptoResponse = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin,dai&vs_currencies=usd',
            { timeout: 8000 }
        );
        const tetherPrice = asFinitePositive(cryptoResponse.data?.tether?.usd);
        const usdcPrice = asFinitePositive(cryptoResponse.data?.['usd-coin']?.usd);
        const daiPrice = asFinitePositive(cryptoResponse.data?.dai?.usd);
        if (!tetherPrice || !usdcPrice || !daiPrice) {
            throw new Error('CoinGecko returned incomplete stablecoin rates.');
        }
        return { tetherPrice, usdcPrice, daiPrice };
    }

    // Supplementary display-only refresh. Deliberately uses update (not
    // upsert): a supplementary-only observation may never create or reshape
    // the canonical GlobalSettings row. Deliberately touches ONLY the
    // dedicated stablecoin display fields — no canonical rate, no source,
    // no freshness timestamp.
    async _updateSupplementaryDisplayRates() {
        let stablecoins = null;
        try {
            stablecoins = await this.fetchStablecoinUsdPrices();
        } catch (err) {
            logger.warn(
                { err },
                '[Oracle] Supplementary stablecoin prices unavailable; prior display values preserved.'
            );
            return;
        }
        try {
            await this.prisma.globalSettings.update({
                where: { id: 1 },
                data: {
                    liveUsdtToUsd: stablecoins.tetherPrice,
                    liveUsdcToUsd: stablecoins.usdcPrice,
                    liveDaiToUsd: stablecoins.daiPrice,
                },
            });
            logger.info(
                '[Oracle] Supplementary display rates refreshed (non-authoritative; transaction-rate freshness untouched).'
            );
        } catch (err) {
            logger.warn(
                { err },
                '[Oracle] Supplementary display update skipped (settings row unavailable or DB error); canonical fields untouched.'
            );
        }
    }

    async fetchAndUpdateRates() {
        try {
            // ── CANONICAL source: Kotani direct USDC/GHS ───────────────────
            let usdcToGhsRate = null;
            try {
                usdcToGhsRate = await this.fetchKotaniUsdcToGhsRate();
            } catch (kotaniErr) {
                logger.warn(
                    { err: kotaniErr },
                    '[Oracle] [KOTANI_UNAVAILABLE] the LIVE provider is armed but the canonical USDC/GHS observation failed — outage path, NOT a configuration problem.'
                );
            }

            if (!usdcToGhsRate) {
                // Kotani is missing (unconfigured/MOCK), failed, or returned
                // a malformed response. There is NO fallback transaction rate:
                // the retired FX × CoinGecko composite must never write the
                // canonical fields or refresh freshness. At most the
                // supplementary display cache is refreshed; the cached
                // canonical rate, its source and every freshness timestamp
                // stay untouched, so the 271C gate fails new quotes closed
                // once the last genuine Kotani observation ages out.
                logger.error(
                    '[Oracle] No valid Kotani USDC/GHS observation — canonical retail rate, source and freshness preserved (fail-closed; no fallback rate).'
                );
                await this._updateSupplementaryDisplayRates();
                return;
            }

            // ── SUPPLEMENTARY source: stablecoin USD prices (display-only) ──
            // Never blocking the canonical write; failure leaves the prior
            // display values preserved.
            let stablecoins = null;
            try {
                stablecoins = await this.fetchStablecoinUsdPrices();
            } catch (err) {
                logger.warn(
                    { err },
                    '[Oracle] Stablecoin price update unavailable (non-blocking); prior values preserved.'
                );
            }

            // ── ONE success-only canonical write (Kotani observation) ─────
            // One observation timestamp for both freshness fields (issue
            // #271 / PR 271B): the oracle is the canonical success-only
            // EXTERNAL writer, so lastRateSync and lastExternalSync always
            // describe the same successful Kotani observation. On failure
            // the cached rate and both timestamps are left untouched (see
            // the fail-closed branch above).
            const observationTimestamp = new Date();
            const update = {
                liveUsdToGhs: usdcToGhsRate,
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: 'KOTANI_PAY',
            };
            const create = {
                id: 1,
                liveUsdToGhs: usdcToGhsRate,
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: 'KOTANI_PAY',
            };
            if (stablecoins) {
                update.liveUsdtToUsd = stablecoins.tetherPrice;
                update.liveUsdcToUsd = stablecoins.usdcPrice;
                update.liveDaiToUsd = stablecoins.daiPrice;
                create.liveUsdtToUsd = stablecoins.tetherPrice;
                create.liveUsdcToUsd = stablecoins.usdcPrice;
                create.liveDaiToUsd = stablecoins.daiPrice;
            }
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update,
                create,
            });

            logger.info(`📈 Oracle Sync: 1 USDC ≈ ${usdcToGhsRate} GHS | source=KOTANI_PAY`);

            if (this.rateAlertService && usdcToGhsRate) {
                setImmediate(() => {
                    this.rateAlertService.checkAlerts(usdcToGhsRate, 'USDC_GHS')
                        .catch(err => logger.error({ err }, '[Oracle] alert check error'));
                });
            }
        } catch (error) {
            logger.error({ err: error }, '🚨 Oracle Sync Failed. Existing cached rate and every freshness timestamp preserved.');
        }
    }
}

module.exports = OracleService;
module.exports.extractKotaniRate = extractKotaniRate;
module.exports.kotaniPairMatches = kotaniPairMatches;
