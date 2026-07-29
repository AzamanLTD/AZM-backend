// routes/friendRoutes.js
// =============================================================================
// AZAMAN V3 — SOCIAL FRIEND SYSTEM ROUTES
//
// Mounts all friend-related endpoints under /api/friends
// Includes: user search, friend requests, friend list, direct messaging,
// and peer-to-peer transfers.
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const friendController = require('../controllers/friendController');
const directMessageController = require('../controllers/directMessageController');
const chatProfileController = require('../controllers/chatProfileController');
const peerTransferController = require('../controllers/peerTransferController');

const protect = authMiddleware.protect;
const { require2FA } = require('../middleware/require2FA');
const { idempotency } = require('../middleware/idempotency');

// =============================================================================
// USER DISCOVERY
// =============================================================================
router.get('/search', protect, friendController.searchUsers);
router.get('/profile/:userId', protect, friendController.getFriendProfile);

// =============================================================================
// FRIEND REQUESTS
// =============================================================================
router.post('/request', protect, friendController.sendFriendRequest);
router.get('/requests', protect, friendController.getPendingRequests);
router.get('/requests/sent', protect, friendController.getSentRequests);
router.put('/request/:id/accept', protect, friendController.acceptFriendRequest);
router.put('/request/:id/reject', protect, friendController.rejectFriendRequest);

// =============================================================================
// FRIENDS LIST
// =============================================================================
router.get('/', protect, friendController.getFriends);
router.delete('/:id', protect, friendController.removeFriend);

// =============================================================================
// DIRECT MESSAGING
// =============================================================================
router.get('/chat/unread-count', protect, directMessageController.getUnreadCount);
router.get('/chat/:friendshipId/messages', protect, directMessageController.getMessages);
router.post('/chat/:friendshipId/messages', protect, directMessageController.sendMessage);
router.put('/chat/:friendshipId/read', protect, directMessageController.markAsRead);
router.get('/chat/:friendshipId/info', protect, directMessageController.getConversationInfo);
router.put('/chat/messages/:id/edit', protect, directMessageController.editMessage);
router.delete('/chat/messages/:id', protect, directMessageController.deleteMessage);
router.post('/chat/messages/:id/react', protect, directMessageController.reactToMessage);

// =============================================================================
// CHAT PROFILE + VAULT (Phase UI-5) + TRUST METRICS (Phase UI-6)
// =============================================================================
router.get('/:friendshipId/profile', protect, chatProfileController.getProfile);
router.patch('/:friendshipId/nickname', protect, chatProfileController.setNickname);
router.get('/:friendshipId/media', protect, chatProfileController.getMedia);
router.get('/:friendshipId/docs-links', protect, chatProfileController.getDocsAndLinks);
router.get('/:friendshipId/receipts', protect, chatProfileController.getReceipts);
router.get('/:friendshipId/trust-metrics', protect, chatProfileController.getTrustMetrics);

// =============================================================================
// PEER TRANSFERS
// =============================================================================
router.post('/transfer/send', protect, require2FA(), idempotency(), peerTransferController.sendFunds);
router.post('/transfer/request', protect, peerTransferController.requestFunds);
router.get('/transfer/pending', protect, peerTransferController.getPendingTransferRequests);
router.get('/transfer/history/:friendshipId', protect, peerTransferController.getTransferHistory);
router.get('/transfer/:id', protect, peerTransferController.getTransferDetails);
router.put('/transfer/:id/fulfill', protect, peerTransferController.fulfillTransferRequest);
router.put('/transfer/:id/decline', protect, peerTransferController.declineTransferRequest);


// =============================================================================
// CHAT PROFILE + VAULT (Phase UI-5, 2026-05-26)
//
// Powers the upgraded "Chat Profile Detail" screen reachable by tapping a
// friend's avatar inside any chat surface. Identity tier + tabbed Media /
// Docs & Links / Tickets / Receipts vault.
// =============================================================================
router.get('/:friendshipId/profile',     protect, chatProfileController.getProfile);
router.patch('/:friendshipId/nickname',  protect, chatProfileController.setNickname);
router.get('/:friendshipId/media',       protect, chatProfileController.getMedia);
router.get('/:friendshipId/docs-links',  protect, chatProfileController.getDocsAndLinks);
router.get('/:friendshipId/receipts',    protect, chatProfileController.getReceipts);

module.exports = router;
