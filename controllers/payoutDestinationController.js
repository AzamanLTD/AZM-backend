exports.addPayoutDestination = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { nickname, destinationType, destinationAddress, isExternalCrypto } = req.body;
        const userId = req.user.id;

        if (!nickname || !destinationType || !destinationAddress) {
            return res.status(400).json({
                success: false,
                message: "nickname, destinationType, and destinationAddress are required."
            });
        }

        const newDestination = await prisma.payoutDestination.create({
            data: {
                userId: userId.toString(),
                nickname,
                destinationType,
                destinationAddress,
                isExternalCrypto: isExternalCrypto || false
            }
        });

        res.status(201).json({
            success: true,
            message: "Payout destination saved.",
            destination: newDestination
        });
    } catch (error) {
        console.error("Add Payout Destination Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getPayoutDestinations = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const destinations = await prisma.payoutDestination.findMany({
            where: {
                userId: userId.toString()
            },
            orderBy: { createdAt: "desc" }
        });

        res.status(200).json({
            success: true,
            destinations
        });
    } catch (error) {
        console.error("Get Payout Destinations Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
