exports.deleteAccount = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { textReason, audioFileUrl } = req.body;

        if (!textReason) {
            return res.status(400).json({ success: false, message: 'textReason is required' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.isDeleted) {
            return res.status(400).json({ success: false, message: 'Account is already deleted' });
        }

        await prisma.accountFeedback.create({
            data: {
                userId: String(userId),
                textReason,
                audioFileUrl: audioFileUrl || null,
            },
        });

        const deletedUsername = `DeletedUser_${String(userId).substring(0, 8)}`;

        await prisma.user.update({
            where: { id: userId },
            data: {
                isDeleted: true,
                email: '',
                googleId: null,
                appleId: null,
                profilePictureUrl: null,
                username: deletedUsername,
            },
        });

        res.status(200).json({
            success: true,
            message: 'Account deleted successfully',
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};
