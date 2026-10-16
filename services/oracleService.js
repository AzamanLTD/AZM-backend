// services/oracleService.js
const logger = require('../src/config/logger');
const axios = require('axios');

const KOTANI_DEFAULT_BASE_URL = 'https://sandbox-api.kotanipay.io/api/v3';

const asFinitePositive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};

const extractKotaniRate = (payload) => {
    const candidates = [
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

class OracleService {
    constructor(prisma) {
        this.prisma = prisma;
        this.updateInterval = 10 * 60 * 1000;
        this.rateAlertService = null;
    }

    startOracle() {
        logger.info('🌐 Azaman Live Market Oracle: INITIALIZED');
        this.fetchAndUpdateRates();
        setInterval(() => this.fetchAndUpdateRates(), this.updateInterval);
    }

    async fetchKotaniUsdcToGhsRate() {
        const provider = String(process.env.KOTANI_PROVIDER || 'MOCK').toUpperCase();
        const token = process.env.KOTANI_API_TOKEN || process.env.KOTANI_API_KEY;
        if (provider !== 'LIVE' || !token || token === 'mock-key') return null;

        const baseUrl = String(process.env.KOTANI_API_BASE_URL || KOTANI_DEFAULT_BASE_URL).replace(/\/$/, '');
        const from = process.env.KOTANI_RATE_FROM || 'USDC';
        const to = process.env.KOTANI_RATE_TO || 'CGHS';
        const response = await axios.post(`${baseUrl}/rate/offramp`, {
            from,
            to,
            cryptoAmount: 1,
        }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000,
        });
        const rate = extractKotaniRate(response.data);
        if (!rate) throw new Error('Kotani Pay rate response did not contain a usable USDC/GHS rate.');
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
                    '[Oracle] Kotani Pay rate unavailable; the canonical USDC/GHS observation failed.'
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
