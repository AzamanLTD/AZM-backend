const logger = require('../src/config/logger');
const authMiddleware = require('../middleware/authMiddleware');
const {
    resolvePayoutDestination,
    payoutDestinationRefusal,
    DESTINATION_TYPES,
} = require('../services/payoutDestinationClassification');

// Saved payout destinations adopt the SAME owner-approved contract
// (2026-10-27) as payout dispatch: an explicit, validated destinationType
// consistent with the stored address. Legacy rows (written before the
// contract, with free-text types like "BINANCE_PAY" or "BANK") are never
// mutated — the read path reports them with typeStatus NEEDS_CONFIRMATION
// plus, for unambiguous formats, a suggestedDestinationType the client may
// offer as a one-tap migration. Numeric legacy rows are never auto-typed:
// a suggestion would be the digit-length guess the contract abolishes.

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

        // Single shared resolution — the saved destination must be valid
        // under the SAME contract payout dispatch uses, so a saved
        // destination can never encode a dispatch that would refuse.
        const resolution = resolvePayoutDestination(destinationAddress, destinationType, req.body?.networkPref);
        if (resolution.status !== 'RESOLVED') {
            const refusal = payoutDestinationRefusal(resolution);
            return res.status(400).json({ success: false, code: refusal.code, message: refusal.message });
        }

        // If this is the first destination, make it the default
        const existingCount = await prisma.payoutDestination.count({
            where: { userId }
        });

        const newDestination = await prisma.payoutDestination.create({
            data: {
                userId,
                nickname,
                destinationType: resolution.destinationType,
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
        logger.error("Add Payout Destination Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Honest read-path classification for legacy rows: VALID for rows already
// carrying a contract-valid type that matches their address format;
// NEEDS_CONFIRMATION otherwise, with a format-derived suggestion ONLY for
// unambiguous formats (never a numeric guess).
function _classifySavedDestination(row) {
    const resolution = resolvePayoutDestination(row.destinationAddress, row.destinationType, null);
    if (resolution.status === 'RESOLVED') {
        return { typeStatus: 'VALID', suggestedDestinationType: null };
    }
    // Unambiguous formats get a migration suggestion; numeric rows never do.
    const untyped = resolvePayoutDestination(row.destinationAddress, null, null);
    if (untyped.status === 'RESOLVED') {
        return { typeStatus: 'NEEDS_CONFIRMATION', suggestedDestinationType: untyped.destinationType };
    }
    return { typeStatus: 'NEEDS_CONFIRMATION', suggestedDestinationType: null };
}

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
            destinations: destinations.map(d => ({
                ...d,
                ..._classifySavedDestination(d),
            }))
        });
    } catch (error) {
        logger.error("Get Payout Destinations Error:", error);
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
            const next = await prisma.payoutDestination.findFirst({
                where: { userId },
                orderBy: { createdAt: "desc" }
            });
            if (next) {
                await prisma.payoutDestination.update({
                    where: { id: next.id },
                    data: { isDefault: true }
                });
            }
        }

        res.json({ success: true, message: "Destination removed." });
    } catch (error) {
        logger.error("Delete Payout Destination Error:", error);
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
        logger.error("Set Default Payout Destination Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.DESTINATION_TYPES = DESTINATION_TYPES;
