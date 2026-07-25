// src/sockets/helpers.js
// =============================================================================
// Socket-related helper functions used across the server. Extracted from
// server.js to keep the entry point focused on wiring.
// =============================================================================

const logger = require('../config/logger');
const { sendPushNotification } = require('../../utils/firebaseService');

/**
 * Sends an FCM push notification to a user only if they have no active
 * socket connections (i.e. they're offline). Prevents double-notification
 * when the user is already viewing the app in real-time.
 *
 * @param {import('socket.io').Server} io
 * @param {object} prisma
 * @returns {function}
 */
function createPushIfOffline(io, prisma) {
    return async (userId, title, body, extra = {}) => {
        try {
            if (!userId) return;
            const room = `user_${userId}`;
            const sockets = await io.in(room).allSockets();
            if (sockets && sockets.size > 0) return;

            const user = await prisma.user.findUnique({
                where: { id: parseInt(userId) },
                select: { fcmToken: true }
            });
            if (!user || !user.fcmToken) return;

            await sendPushNotification(user.fcmToken, title, body, extra);
        } catch (err) {
            logger.error({ err }, 'pushIfOffline error');
        }
    };
}

/**
 * Emits a balance_update event to the user's balance room with their current
 * wallet balances. Called after any financial mutation (trade, deposit,
 * withdrawal, etc.) to keep the client UI in sync without polling.
 *
 * @param {import('socket.io').Server} io
 * @param {object} prisma
 * @returns {function}
 */
function createEmitBalanceUpdate(io, prisma) {
    return async (userId) => {
        try {
            const user = await prisma.user.findUnique({
                where: { id: parseInt(userId) },
                select: {
                    availableBalance: true,
                    vendorUnallocatedBalance: true,
                    escrowLockedBalance: true,
                    disputeEscrowBalance: true,
                    azmBalance: true
                }
            });
            if (user) {
                io.to(`balance_room_${userId}`).emit('balance_update', {
                    availableBalance: user.availableBalance,
                    vendorUnallocatedBalance: user.vendorUnallocatedBalance,
                    escrowLockedBalance: user.escrowLockedBalance,
                    disputeEscrowBalance: user.disputeEscrowBalance,
                    azmBalance: user.azmBalance,
                    currency: 'USDC'
                });
            }
        } catch (err) {
            logger.error({ err }, 'Balance emit error');
        }
    };
}

module.exports = { createPushIfOffline, createEmitBalanceUpdate };
