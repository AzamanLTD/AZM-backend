const authMiddleware = require('../middleware/authMiddleware');

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

        // If this is the first destination, make it the default
        const existingCount = await prisma.payoutDestination.count({
            where: { userId }
        });

        const newDestination = await prisma.payoutDestination.create({
            data: {
                userId,
                nickname,
                destinationType,
                destinationAddress,
                isExternalCrypto: isExternalCrypto || false,
                isDefault: existingCount === 0,
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
            where: { userId },
            orderBy: [{ isDefault: 'desc' }, { createdAt: "desc" }]
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

exports.deletePayoutDestination = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const destId = req.params.id;

        const dest = await prisma.payoutDestination.findUnique({ where: { id: destId } });
        if (!dest || dest.userId !== userId) {
            return res.status(404).json({ success: false, message: "Destination not found." });
        }

        const wasDefault = dest.isDefault;
        await prisma.payoutDestination.delete({ where: { id: destId } });

        // If we deleted the default, make the most recent remaining one the default
        if (wasDefault) {
            const nextDest = await prisma.payoutDestination.findFirst({
                where: { userId },
                orderBy: { createdAt: 'desc' }
            });
            if (nextDest) {
                await prisma.payoutDestination.update({
                    where: { id: nextDest.id },
                    data: { isDefault: true }
                });
            }
        }

        res.json({ success: true, message: "Destination removed." });
    } catch (error) {
        console.error("Delete Payout Destination Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.setDefaultPayoutDestination = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const destId = req.params.id;

        const dest = await prisma.payoutDestination.findUnique({ where: { id: destId } });
        if (!dest || dest.userId !== userId) {
            return res.status(404).json({ success: false, message: "Destination not found." });
        }

        // Unset all others, then set this one
        await prisma.payoutDestination.updateMany({
            where: { userId, isDefault: true },
            data: { isDefault: false }
        });
        await prisma.payoutDestination.update({
            where: { id: destId },
            data: { isDefault: true }
        });

        res.json({ success: true, message: "Default destination updated." });
    } catch (error) {
        console.error("Set Default Payout Destination Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
