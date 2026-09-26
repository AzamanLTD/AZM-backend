class MarginCalculatorService {
    calculateBuyerFiatCost(tradeAmountUsdc, baseMargin, vendorMargin, currentYellowCardRate) {
        const totalMarginPercent = baseMargin + vendorMargin;
        const finalCustomerRate = currentYellowCardRate * (1 + totalMarginPercent / 100);
        const totalFiatCost = tradeAmountUsdc * finalCustomerRate;
        return {
            totalMarginPercent,
            finalCustomerRate,
            totalFiatCost
        };
    }

    splitProfit(tradeAmountUsdc, baseMargin, vendorMargin) {
        const totalMarginPercent = baseMargin + vendorMargin;
        const totalProfitUsdc = tradeAmountUsdc * (totalMarginPercent / 100);

        let adminCutUsdc;
        let vendorCutUsdc;

        if (tradeAmountUsdc < 1000) {
            adminCutUsdc = totalProfitUsdc * 0.60;
            vendorCutUsdc = totalProfitUsdc * 0.40;
        } else {
            adminCutUsdc = totalProfitUsdc * 0.50;
            vendorCutUsdc = totalProfitUsdc * 0.50;
        }

        return {
            totalProfitUsdc,
            adminCutUsdc,
            vendorCutUsdc
        };
    }
}

module.exports = new MarginCalculatorService();
