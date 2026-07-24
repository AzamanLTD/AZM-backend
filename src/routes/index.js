/**
 * Route Registry — mounts all API route modules onto the Express app.
 *
 * Extracted from server.js as part of Phase 1 modularization.
 * Rate limiters and middleware are passed in to keep this module
 * side-effect free and testable.
 *
 * @param {import('express').Express} app     - Express app instance
 * @param {object} limiters                     - { authLimiter, financialLimiter, generalLimiter, webhookLimiter }
 */
function mountRoutes(app, {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
}) {
    // API versioning + response helpers
    app.use('/api', require('../middleware/apiVersioning'));
    app.use((req, res, next) => {
        const m = req.url.match(/^\/api\/v(\d+)(?=\/|\?|$)/);
        if (m) req.url = '/api' + req.url.slice(m[0].length);
        next();
    });
    app.use('/api', require('../middleware/responseHelpers'));

    // ── API ROUTES (with rate limiting) ──────────────────────────────────────
    app.use('/api/public', generalLimiter, require('../../routes/publicRoutes'));

    const { adminBusinessScope } = require('../middleware/adminBusinessScope');
    app.use(adminBusinessScope);

    // ── Core Routes ──────────────────────────────────────────────────────────
    app.use('/api/auth',                 authLimiter,      require('../../routes/authRoutes'));
    app.use('/api/trades',               financialLimiter, require('../../routes/tradeRoutes'));
    app.use('/api/ads',                  generalLimiter,   require('../../routes/adRoutes'));
    app.use('/api/chat',                 generalLimiter,   require('../../routes/chatRoutes'));
    app.use('/api/chat-upload',          generalLimiter,   require('../../routes/chatUploadRoutes'));
    app.use('/api/direct-messages',      generalLimiter,   require('../../routes/businessDirectMessageRoutes'));
    app.use('/api/wallet',               financialLimiter, require('../../routes/walletRoutes'));
    app.use('/api/admin',                generalLimiter,   require('../../routes/adminRoutes'));
    app.use('/api/kyc',                  generalLimiter,   require('../../routes/kycRoutes'));
    app.use('/api/notifications',        generalLimiter,   require('../../routes/notificationRoutes'));
    app.use('/api/deposit',              webhookLimiter,   require('../../routes/depositRoutes'));
    app.use('/api/withdraw',             financialLimiter, require('../../routes/withdrawalRoutes'));
    app.use('/api/trade-accounts',       generalLimiter,   require('../../routes/tradeAccountRoutes'));
    app.use('/api/payout-destinations',  generalLimiter,   require('../../routes/payoutDestinationRoutes'));
    app.use('/api/admin/chat',           generalLimiter,   require('../../routes/adminChatRoutes'));
    app.use('/api/security',             generalLimiter,   require('../../routes/securityRoutes'));
    app.use('/api/users',                generalLimiter,   require('../../routes/userRoutes'));
    app.use('/api/stories',              generalLimiter,   require('../../routes/storyRoutes'));
    app.use('/api/contacts',             generalLimiter,   require('../../routes/contactRoutes'));
    app.use('/api/war-room',             generalLimiter,   require('../../routes/warRoomRoutes'));
    app.use('/api/ai',                   generalLimiter,   require('../../routes/aiRoutes'));
    app.use('/api/finance',              financialLimiter, require('../../routes/financeRoutes'));
    app.use('/api/p2p',                  financialLimiter, require('../../routes/p2pRoutes'));
    app.use('/api/friends',              generalLimiter,   require('../../routes/friendRoutes'));
    app.use('/api/vendor',               generalLimiter,   require('../../routes/vendorStatsRoutes'));
    app.use('/api/savings',              generalLimiter,   require('../../routes/savingsRoutes'));
    app.use('/api/oracle',               generalLimiter,   require('../../routes/oracleRoutes'));
    app.use('/api/azm',                  generalLimiter,   require('../../routes/azmRoutes'));
    app.use('/api/receipts',             generalLimiter,   require('../../routes/receiptRoutes'));
    app.use('/api/tickets',              generalLimiter,   require('../../routes/ticketRoutes'));

    // ── Smart Escrow & Business Accounts ─────────────────────────────────────
    app.use('/api/escrow',               financialLimiter, require('../../routes/escrowRoutes'));
    app.use('/api/business',             generalLimiter,   require('../../routes/businessRoutes'));

    // ── Marketplace Foundation: Reservation system ───────────────────────────
    app.use('/api/reservations',         generalLimiter,   require('../../routes/reservationRoutes'));

    // ── Marketplace Expansion ─────────────────────────────────────────────────
    app.use('/api/follows',              generalLimiter,   require('../../routes/followRoutes'));
    app.use('/api/ad-posts',             generalLimiter,   require('../../routes/adPostRoutes'));
    app.use('/api/dine-in',              financialLimiter, require('../../routes/dineInRoutes'));
    app.use('/api/showcases',            generalLimiter,   require('../../routes/showcaseRoutes'));
    app.use('/api/marketplace-finance',  financialLimiter, require('../../routes/marketplaceFinanceRoutes'));
    app.use('/api/marketplace-seat-map', generalLimiter,   require('../../routes/marketplaceSeatMapRoutes'));
    app.use('/api/marketplace-penalty',  generalLimiter,   require('../../routes/marketplacePenaltyRoutes'));

    // ── Master Sprint ─────────────────────────────────────────────────────────
    app.use('/api/vaults',               financialLimiter, require('../../routes/vaultRoutes'));
    app.use('/api/group-chats',          generalLimiter,   require('../../routes/groupChatRoutes'));
    app.use('/api/susu',                 financialLimiter, require('../../routes/susuRoutes'));
    app.use('/api/smart-routes',         financialLimiter, require('../../routes/smartRouteRoutes'));
    app.use('/api/azm-auction',          generalLimiter,   require('../../routes/azmAuctionRoutes'));

    // ── Master Sprint v2: Saved MoMo accounts ────────────────────────────────
    app.use('/api/saved-momo',           financialLimiter, require('../../routes/savedMomoRoutes'));

    // ── B-11: Transit booking system ─────────────────────────────────────────
    app.use('/api/transit',              generalLimiter,   require('../../routes/transitRoutes'));

    // ── Private Susu Ecosystem Overlay Routes ────────────────────────────────
    const { userRouter: porUserRouter, adminRouter: porAdminRouter } = require('../../routes/proofOfResidencyRoutes');
    const { publicRouter: liabPublicRouter, adminRouter: liabAdminRouter } = require('../../routes/liabilityContractRoutes');
    const adminWarRoomRoutes = require('../../routes/adminWarRoomRoutes');

    app.use('/api/users/proof-of-residency',  generalLimiter, porUserRouter);
    app.use('/api/admin/proof-of-residency',  generalLimiter, porAdminRouter);
    app.use('/api/liability-contract',        generalLimiter, liabPublicRouter);
    app.use('/api/admin/liability-contract',  generalLimiter, liabAdminRouter);
    app.use('/api/admin/war-room',            generalLimiter, adminWarRoomRoutes);

    // ── Phase 5: Admin Susu Monitor + Operator Actions ───────────────────────
    const adminSusuRoutes = require('../../routes/adminSusuRoutes');
    const businessOSRoutes = require('../../routes/businessOSRoutes');

    app.use('/api/admin/susu',            generalLimiter,   adminSusuRoutes);

    // ── Marketplace Expansion — Phase B-2 ─────────────────────────────────────
    app.use('/api/marketplace',           generalLimiter,   require('../../routes/marketplaceRoutes'));
    app.use('/api/business-os',           generalLimiter,   businessOSRoutes);
    app.use('/api/developer',             generalLimiter,   require('../../routes/developerRoutes'));
    app.use('/api/qr',                    generalLimiter,   require('../../routes/qrRoutes'));
    app.use('/api/storefront',            generalLimiter,   require('../../routes/storefrontRoutes'));
    app.use('/api/azm-stake',             generalLimiter,   require('../../routes/azmStakeRoutes'));
    app.use('/api/admin/storefront',      generalLimiter,   require('../../routes/adminStorefrontRoutes'));
}

module.exports = { mountRoutes };
