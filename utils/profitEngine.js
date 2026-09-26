const calculateP2PProfitSplit = (tradeAmountUsdc, marginPercentage) => {
    const totalMargin = parseFloat((tradeAmountUsdc * (marginPercentage / 100)).toFixed(6));

    let adminCut;
    let vendorCut;

    if (tradeAmountUsdc < 1000) {
        adminCut = parseFloat((totalMargin * 0.60).toFixed(6));
        vendorCut = parseFloat((totalMargin * 0.40).toFixed(6));
    } else {
        adminCut = parseFloat((totalMargin * 0.50).toFixed(6));
        vendorCut = parseFloat((totalMargin * 0.50).toFixed(6));
    }

    return { totalMargin, adminCut, vendorCut };
};

module.exports = { calculateP2PProfitSplit };
