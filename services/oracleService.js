// services/oracleService.js
const logger = require('../src/config/logger');
const axios = require('axios');

const KOTANI_DEFAULT_BASE_URL = 'https://sandbox-api.kotanipay.io/api/v3';
const FALLBACK_FX_URL = 'https://open.er-api.com/v6/latest/USD';

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

    async fetchFallbackUsdToGhsRate() {
        const response = await axios.get(FALLBACK_FX_URL, { timeout: 8000 });
        return asFinitePositive(response.data?.rates?.GHS);
    }

    // §271 per-source isolation (issue #271 recommendation D): the old flow
    // made CoinGecko a HARD gate — a single CoinGecko 429 aborted the whole
    // sync, freezing even the Kotani direct observation that does not
    // depend on CoinGecko at all. The restructured flow isolates every
    // external source, and the single freshness contract is preserved:
    //
    //   lastExternalSync/lastRateSync advance ONLY when the CANONICAL retail
    //   rate (liveRetailRate, USDC/GHS) was genuinely observed:
    //     • Kotani LIVE direct USDC/GHS          → full write, KOTANI_PAY
    //     • FX(USD/GHS) + CoinGecko(USDC/USD)    → composite write,
    //                                               FALLBACK_FX (BOTH must
    //                                               succeed — the raw USD/GHS
    //                                               alone is NOT a USDC/GHS
    //                                               observation and must not
    //                                               refresh freshness)
    //   Stablecoin prices (tether/usdc/dai vs USD) are supplementary display
    //   fields: a CoinGecko failure never blocks the Kotani write, and a
    //   Kotani/MOCK mode never blocks the stablecoin update.
    //
    //   Repeated failure: cached values and ALL timestamps stay untouched —
    //   the freshness gate (/rateFreshness) fails new quotes closed after
    //   RATE_FRESHNESS_MAX_AGE_SECONDS, and /api/oracle/rates exposes the
    //   true age (externalRateAgeSeconds). No code path can present the
    //   frozen number as fresh (271B echo isolation + this isolation).
    //   Recovery: the next successful observation simply resumes; there is no
    //   stuck backoff state to clear.
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

    async fetchAndUpdateRates() {
        try {
            let usdcToGhsRate = null;
            let usdToGhsRate = null;
            let rateSource = null;
            let stablecoins = null;

            // ── Source 1 (isolated): Kotani direct USDC/GHS ────────────────
            try {
                usdcToGhsRate = await this.fetchKotaniUsdcToGhsRate();
                if (usdcToGhsRate) {
                    // Kotani supplies the direct USDC/GHS rate. Keep the
                    // legacy USD/GHS field at the same value for
                    // backward-compatible API consumers; the canonical retail
                    // field is the authoritative USDC/GHS display rate.
                    rateSource = 'KOTANI_PAY';
                }
            } catch (kotaniErr) {
                logger.warn(
                    { err: kotaniErr },
                    '[Oracle] Kotani Pay rate unavailable; trying the fallback FX composite.'
                );
            }

            // ── Source 2 (isolated): FX × CoinGecko composite ─────────────
            if (!usdcToGhsRate) {
                // In MOCK mode there is no external Kotani observation at
                // all; the composite is the only genuine external path.
                let usdcPrice = null;
                let usdToGhs = null;
                let coingeckoErr = null;
                let fxErr = null;
                try {
                    stablecoins = await this.fetchStablecoinUsdPrices();
                    usdcPrice = stablecoins.usdcPrice;
                } catch (err) {
                    coingeckoErr = err;
                }
                try {
                    usdToGhs = await this.fetchFallbackUsdToGhsRate();
                } catch (err) {
                    fxErr = err;
                }
                if (usdToGhs && usdcPrice) {
                    // The fallback quotes USD/GHS; apply the live USDC/USD
                    // market price so the user-facing rate remains USDC/GHS.
                    usdcToGhsRate = usdToGhs * usdcPrice;
                    usdToGhsRate = usdToGhs;
                    rateSource = 'FALLBACK_FX';
                } else {
                    // Partial observation is NOT a retail observation: the
                    // raw USD/GHS alone can never write liveRetailRate or
                    // refresh freshness (that would misprice every USDC
                    // conversion during a depeg). Nothing is written; the
                    // cached rate and every timestamp stay untouched.
                    if (coingeckoErr) {
                        logger.error(
                            { err: coingeckoErr },
                            '[Oracle] CoinGecko stablecoin observation failed — composite rate unavailable; cached rate preserved.'
                        );
                    }
                    if (fxErr) {
                        logger.error(
                            { err: fxErr },
                            '[Oracle] Fallback FX observation failed — composite rate unavailable; cached rate preserved.'
                        );
                    }
                    if (!coingeckoErr && !fxErr) {
                        logger.error('[Oracle] Composite sources returned no usable rate; cached rate preserved.');
                    }
                    throw new Error('No usable external USDC/GHS observation is available.');
                }
            } else {
                // Kotani succeeded: stablecoin prices are supplementary —
                // fetch best-effort, never blocking the canonical write.
                usdToGhsRate = usdcToGhsRate;
                try {
                    stablecoins = await this.fetchStablecoinUsdPrices();
                } catch (err) {
                    logger.warn(
                        { err },
                        '[Oracle] Stablecoin price update unavailable (non-blocking); prior values preserved.'
                    );
                }
            }

            // ── ONE success-only external write ───────────────────────────
            // One observation timestamp for both freshness fields (issue
            // #271 / PR 271B): the oracle is the canonical success-only
            // EXTERNAL writer, so lastRateSync and lastExternalSync always
            // describe the same successful observation. On failure the cached
            // rate and both timestamps are left untouched (see catch below).
            const observationTimestamp = new Date();
            const update = {
                liveUsdToGhs: usdToGhsRate,
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: rateSource,
            };
            const create = {
                id: 1,
                liveUsdToGhs: usdToGhsRate,
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: rateSource,
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

            logger.info(`📈 Oracle Sync: 1 USDC ≈ ${usdcToGhsRate} GHS | source=${rateSource}`);

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
