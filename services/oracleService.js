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

    // Some Kotani quote responses expose both sides of the conversion rather
    // than a dedicated rate field. Prefer an actual USDC→CGHS conversion when
    // both values are present rather than assuming USD and USDC are identical.
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
        this.updateInterval = 10 * 60 * 1000; // Run every 10 minutes
        this.rateAlertService = null; // Injected by server.js after construction
    }

    startOracle() {
        logger.info('🌐 Azaman Live Market Oracle: INITIALIZED');
        this.fetchAndUpdateRates();
        setInterval(() => this.fetchAndUpdateRates(), this.updateInterval);
    }

    async fetchKotaniUsdcToGhsRate() {
        const provider = String(process.env.KOTANI_PROVIDER || 'MOCK').toUpperCase();
        const apiKey = process.env.KOTANI_API_KEY;
        if (provider !== 'LIVE' || !apiKey || apiKey === 'mock-key') return null;

        const baseUrl = String(process.env.KOTANI_API_BASE_URL || KOTANI_DEFAULT_BASE_URL).replace(/\/$/, '');
        const from = process.env.KOTANI_RATE_FROM || 'USDC';
        const to = process.env.KOTANI_RATE_TO || 'CGHS';
        const response = await axios.get(`${baseUrl}/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
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

    async fetchAndUpdateRates() {
        try {
            const cryptoResponse = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin,dai&vs_currencies=usd',
                { timeout: 8000 }
            );

            const tetherPrice = asFinitePositive(cryptoResponse.data?.tether?.usd);
            const usdcPrice = asFinitePositive(cryptoResponse.data?.['usd-coin']?.usd);
            const daiPrice = asFinitePositive(cryptoResponse.data?.dai?.usd);
            if (!tetherPrice || !usdcPrice || !daiPrice) throw new Error('CoinGecko returned incomplete stablecoin rates.');

            let usdToGhsRate = null;
            let rateSource = 'FALLBACK_FX';
            try {
                usdToGhsRate = await this.fetchKotaniUsdcToGhsRate();
                if (usdToGhsRate) rateSource = 'KOTANI_PAY';
            } catch (error) {
                logger.warn({ err: error }, '[Oracle] Kotani Pay rate unavailable; using fallback FX provider.');
            }

            if (!usdToGhsRate) usdToGhsRate = await this.fetchFallbackUsdToGhsRate();
            if (!usdToGhsRate) throw new Error('No usable USD/USDC to GHS rate is available.');

            const lastRateSync = new Date();
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update: {
                    liveUsdToGhs: usdToGhsRate,
                    liveUsdtToUsd: tetherPrice,
                    liveUsdcToUsd: usdcPrice,
                    liveDaiToUsd: daiPrice,
                    liveRateSource: rateSource,
                    lastRateSync,
                },
                create: {
                    id: 1,
                    liveUsdToGhs: usdToGhsRate,
                    liveUsdtToUsd: tetherPrice,
                    liveUsdcToUsd: usdcPrice,
                    liveDaiToUsd: daiPrice,
                    liveRateSource: rateSource,
                    lastRateSync,
                }
            });

            logger.info(`📈 Oracle Sync: 1 USDC ≈ ${usdToGhsRate} GHS | source=${rateSource}`);

            if (this.rateAlertService && usdToGhsRate) {
                setImmediate(() => {
                    this.rateAlertService.checkAlerts(usdToGhsRate, 'USD_GHS')
                        .catch(err => logger.error({ err: err }, '[Oracle] alert check error'));
                });
            }
        } catch (error) {
            logger.error({ err: error }, '🚨 Oracle Sync Failed. Existing cached rate preserved.');
        }
    }
}

module.exports = OracleService;
module.exports.extractKotaniRate = extractKotaniRate;