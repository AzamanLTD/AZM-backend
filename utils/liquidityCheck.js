const checkAvailableLiquidity = async (prisma, userId, requiredAmount) => {
    const user = await prisma.user.findUnique({
        where: { id: parseInt(userId, 10) },
        select: { availableBalance: true }
    });

    if (!user) {
        throw new Error("User not found.");
    }

    if (requiredAmount > user.availableBalance) {
        throw new Error(
            `Insufficient liquidity. Required: ${requiredAmount}, Available: ${user.availableBalance}`
        );
    }

    return true;
};

module.exports = { checkAvailableLiquidity };
