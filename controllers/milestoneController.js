// controllers/milestoneController.js
// =============================================================================
// AZAMAN V2 — MILESTONE CONTROLLER
// =============================================================================

// =============================================================================
// GET MILESTONES
// =============================================================================
exports.getMilestones = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                tradesCompleted: true,
                completionRate: true,
                loyaltyTier: true,
            },
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Fetch latest LeaderboardRecord for volume
        const latestLeaderboard = await prisma.leaderboardRecord.findFirst({
            where: { userId },
            orderBy: { weekStartDate: 'desc' },
            take: 1,
        });

        const currentVolume = latestLeaderboard ? latestLeaderboard.totalVolume : 0;

        // Calculate tier progress
        let nextTier = null;
        let tradesNeeded = 0;

        if (user.loyaltyTier === 'STANDARD') {
            nextTier = 'GOLD';
            tradesNeeded = Math.max(0, 50 - user.tradesCompleted);
        } else if (user.loyaltyTier === 'GOLD') {
            nextTier = 'PLATINUM';
            tradesNeeded = Math.max(0, 200 - user.tradesCompleted);
        } else {
            // Already PLATINUM or highest tier
            nextTier = null;
            tradesNeeded = 0;
        }

        res.status(200).json({
            success: true,
            data: {
                currentVolume,
                targetVolume: 100000,
                tierName: user.loyaltyTier,
                tradesCompleted: user.tradesCompleted,
                completionRate: user.completionRate,
                nextTier,
                tradesNeeded,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};
