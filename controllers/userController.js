// controllers/userController.js
// =============================================================================
// AZAMAN — user account management
//
// deleteAccount (POST /api/users/delete) — soft delete.
//
// Hardened per audit B-09: an account may not be soft-deleted while it still
// has money or obligations in flight (open trades, pending withdrawals, active
// Susu memberships). Deleting underneath an in-flight trade or a pending payout
// would strand counterparties and funds. We block with 409 and enumerate the
// blockers so the client can tell the user exactly what to resolve first.
//
// The route + request body shape (textReason, audioFileUrl) is preserved so
// the existing Flutter deactivation screen keeps working unchanged.
// =============================================================================

// Trade statuses that represent an unsettled obligation for either party.
const OPEN_TRADE_STATUSES = ['PENDING', 'PENDING_PAYMENT', 'PAID', 'DISPUTED'];

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

        // ── Guard: no deletion with funds/obligations in flight (B-09) ──────
        // The user may be a buyer OR a vendor on an open trade, so check both
        // sides. Susu membership counts as "active" only in the ACTIVE state —
        // PENDING_VOUCH / PENDING_CONTRACT haven't committed funds yet, and
        // DEFAULTED / REMOVED are terminal.
        const [openTrades, pendingWithdrawals, activeSusu] = await Promise.all([
            prisma.trade.count({
                where: {
                    status: { in: OPEN_TRADE_STATUSES },
                    OR: [{ userId }, { vendorId: userId }],
                },
            }),
            prisma.withdrawal.count({
                where: { userId, status: 'PENDING' },
            }),
            prisma.susuMember.count({
                where: { userId, status: 'ACTIVE' },
            }),
        ]);

        if (openTrades > 0 || pendingWithdrawals > 0 || activeSusu > 0) {
            return res.status(409).json({
                success: false,
                code: 'CANNOT_DELETE_WITH_ACTIVE_TRANSACTIONS',
                message: 'Resolve your active transactions before deleting your account.',
                blockers: {
                    openTrades,
                    pendingWithdrawals,
                    activeSusuMemberships: activeSusu,
                },
            });
        }

        // Feedback row is best-effort context, not part of the deletion's
        // integrity — but keep it inside the try so a schema mismatch surfaces.
        await prisma.accountFeedback.create({
            data: {
                userId: String(userId),
                textReason,
                audioFileUrl: audioFileUrl || null,
            },
        });

        const deletedTag = `deleted_${userId}`;

        // Scrub PII and free up the unique columns. The previous version set
        // email = '' which collides on the second deletion (email is @unique) —
        // namespace by id instead so any number of accounts can be deleted.
        // Bump tokenVersion in the same update so every outstanding access JWT
        // is rejected by protect() on its next request, and revoke refresh
        // tokens so no new access token can be minted.
        await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: {
                    isDeleted: true,
                    email: `${deletedTag}@azaman.deleted`,
                    username: deletedTag,
                    googleId: null,
                    appleId: null,
                    profilePictureUrl: null,
                    tokenVersion: { increment: 1 },
                },
            }),
            prisma.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: new Date() },
            }),
        ]);

        // Kick any live sockets for this user so the app can't keep acting on a
        // now-deleted session. Fire-and-forget — never block the response.
        try {
            const io = req.app.get('socketio');
            if (io) io.in(`user_${userId}`).disconnectSockets(true);
        } catch (_) { /* non-fatal */ }

        return res.status(200).json({
            success: true,
            message: 'Account deleted successfully',
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};
