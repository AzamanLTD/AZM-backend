// services/oracleService.js
const axios = require('axios');

class OracleService {
    constructor(prisma) {
        this.prisma = prisma;
        this.updateInterval = 10 * 60 * 1000; // Run every 10 minutes
        this.rateAlertService = null; // Injected by server.js after construction
    }

    startOracle() {
        console.log("🌐 Azaman Live Market Oracle: INITIALIZED");
        this.fetchAndUpdateRates(); 
        setInterval(() => this.fetchAndUpdateRates(), this.updateInterval);
    }

    async fetchAndUpdateRates() {
        try {
            // 1. Fetch Crypto to USD (USDT, USDC, DAI) from CoinGecko
            const cryptoResponse = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin,dai&vs_currencies=usd'
            );
            
            const tetherPrice = cryptoResponse.data['tether'].usd;
            const usdcPrice = cryptoResponse.data['usd-coin'].usd;
            const daiPrice = cryptoResponse.data['dai'].usd;

            // 2. Fetch Fiat USD to GHS (Using an open exchange API)
            const fiatResponse = await axios.get('https://open.er-api.com/v6/latest/USD');
            const usdToGhsRate = fiatResponse.data.rates.GHS;

            // 3. Lock it into the GlobalSettings Vault
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update: {
                    liveUsdToGhs: usdToGhsRate,
                    liveUsdtToUsd: tetherPrice,
                    liveUsdcToUsd: usdcPrice,
                    liveDaiToUsd: daiPrice,
                },
                create: {
                    id: 1,
                    liveUsdToGhs: usdToGhsRate,
                    liveUsdtToUsd: tetherPrice,
                    liveUsdcToUsd: usdcPrice,
                    liveDaiToUsd: daiPrice,
                }
            });

            console.log(`📈 Oracle Sync: 1 USD = ${usdToGhsRate} GHS | USDT = $${tetherPrice}`);

            // Phase Q12: Check rate alerts after successful sync
            if (this.rateAlertService && usdToGhsRate) {
                setImmediate(() => {
                    this.rateAlertService.checkAlerts(usdToGhsRate, 'USD_GHS')
                        .catch(err => console.error('[Oracle] alert check error:', err.message));
                });
            }

        } catch (error) {
            console.error("🚨 Oracle Sync Failed. Retrying in 10 mins.", error.message);
        }
    }
}

module.exports = OracleService;