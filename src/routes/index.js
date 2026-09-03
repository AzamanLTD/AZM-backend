/**
 * Route Registry — mounts all API route modules onto the Express app.
 */
function mountRoutes(app, {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
}) {
    const logger = require('../../src/config/logger');

    app.use('/api', require('../../middleware/apiVersioning'));
    app.use((req, res, next) => {
        const m = req.url.match(/^\/api\/v(\d+)(?=\/|\?|$)/);
        if (m) req.url = '/api' + req.url.slice(m[0].length);
        next();
    });
    app.use('/api', require('../../middleware/responseHelpers'));

    const prismaInjector = require('../../src/middleware/prismaInjector');
    app.use('/api', prismaInjector);

    app.use('/api/public', generalLimiter, require('../../routes/publicRoutes'));
    const { adminBusinessScope } = require('../../middleware/adminBusinessScope');
    app.use(adminBusinessScope);
    app.use('/api/auth', authLimiter, require('../../routes/authRoutes'));
    app.use('/api/trades', financialLimiter, require('../../routes/tradeRoutes'));
    app.use('/api/ads', generalLimiter, require('../../routes/adRoutes'));
    app.use('/api/chat', generalLimiter, require('../../routes/chatRoutes'));
    app.use('/api/chat-upload', generalLimiter, require('../../routes/chatUploadRoutes'));
    app.use('/api/direct-messages', generalLimiter, require('../../routes/businessDirectMessageRoutes'));
    app.use('/api/wallet', financialLimiter, require('../../routes/walletRoutes'));
    app.use('/api/admin', generalLimiter, require('../../routes/adminRoutes'));
    app.use('/api/kyc', generalLimiter, require('../../routes/kycRoutes'));
    app.use('/api/notifications', generalLimiter, require('../../routes/notificationRoutes'));
    app.use('/api/deposit', webhookLimiter, require('../../routes/depositRoutes'));
    app.use('/api/withdraw', financialLimiter, require('../../routes/withdrawalRoutes'));
    app.use('/api/trade-accounts', generalLimiter, require('../../routes/tradeAccountRoutes'));
    app.use('/api/payout-destinations', generalLimiter, require('../../routes/payoutDestinationRoutes'));
    app.use('/api/admin/chat', generalLimiter, require('../../routes/adminChatRoutes'));
    app.use('/api/security', generalLimiter, require('../../routes/securityRoutes'));
    app.use('/api/users', generalLimiter, require('../../routes/userRoutes'));
    app.use('/api/stories', generalLimiter, require('../../routes/storyRoutes'));
    app.use('/api/stories', generalLimiter, require('../../routes/storyHighlightRoutes'));
    app.use('/api/loyalty', generalLimiter, require('../../routes/loyaltyRoutes'));
    app.use('/api/contacts', generalLimiter, require('../../routes/contactRoutes'));
    app.use('/api/war-room', generalLimiter, require('../../routes/warRoomRoutes'));
    app.use('/api/ai', generalLimiter, require('../../routes/aiRoutes'));
    app.use('/api/admin/ai', generalLimiter, require('../../routes/aiRoutes'));
    app.use('/api/finance', financialLimiter, require('../../routes/financeRoutes'));
    app.use('/api/p2p', financialLimiter, require('../../routes/p2pRoutes'));
    app.use('/api/friends', generalLimiter, require('../../routes/friendRoutes'));
    app.use('/api/vendor', generalLimiter, require('../../routes/vendorStatsRoutes'));
    app.use('/api/savings', financialLimiter, require('../../routes/savingsRoutes'));
    app.use('/api/oracle', generalLimiter, require('../../routes/oracleRoutes'));
    app.use('/api/azm', generalLimiter, require('../../routes/azmRoutes'));
    app.use('/api/receipts', generalLimiter, require('../../routes/receiptRoutes'));
    app.use('/api/tickets', generalLimiter, require('../../routes/ticketRoutes'));
    app.use('/api/escrow', financialLimiter, require('../../routes/escrowRoutes'));
    app.use('/api/business', generalLimiter, require('../../routes/businessRoutes'));
    app.use('/api/reservations', generalLimiter, require('../../routes/reservationRoutes'));
    app.use('/api/follows', generalLimiter, require('../../routes/followRoutes'));
    app.use('/api/ad-posts', generalLimiter, require('../../routes/adPostRoutes'));
    app.use('/api/dine-in', financialLimiter, require('../../routes/dineInRoutes'));
    app.use('/api/showcases', generalLimiter, require('../../routes/showcaseRoutes'));
    app.use('/api/marketplace-finance', financialLimiter, require('../../routes/marketplaceFinanceRoutes'));
    app.use('/api/marketplace-seat-map', generalLimiter, require('../../routes/marketplaceSeatMapRoutes'));
    app.use('/api/journal', generalLimiter, require('../../routes/journalRoutes'));
    app.use('/api/e2ee', generalLimiter, require('../../routes/e2eeRoutes'));
    app.use('/api/marketplace-penalty', generalLimiter, require('../../routes/marketplacePenaltyRoutes'));
    app.use('/api/fraud', generalLimiter, require('../../routes/fraudRoutes'));
    app.use('/api/calls', generalLimiter, require('../../routes/callLogRoutes'));
    app.use('/api/messages', generalLimiter, require('../../routes/messageActionRoutes'));
    app.use('/api/webhooks', generalLimiter, require('../../routes/webhookRoutes'));
    app.use('/api/orders', generalLimiter, require('../../routes/orderTrackingRoutes'));
    app.use('/api/wallet-pass', generalLimiter, require('../../routes/walletPassRoutes'));
    app.use('/api/round-up', generalLimiter, require('../../routes/roundUpRoutes'));
    app.use('/api/vaults', generalLimiter, require('../../routes/vaultYieldRoutes'));
    app.use('/api/vaults', financialLimiter, require('../../routes/vaultRoutes'));
    app.use('/api/shared-vaults', financialLimiter, require('../../routes/sharedVaultRoutes'));
    app.use('/api/group-chats', generalLimiter, require('../../routes/groupChatRoutes'));
    app.use('/api/conversations', generalLimiter, require('../../routes/conversationRoutes'));
    app.use('/api/susu', financialLimiter, require('../../routes/susuRoutes'));
    app.use('/api/credit-score', generalLimiter, require('../../routes/creditScoreRoutes'));
    app.use('/api/azm-gifts', generalLimiter, require('../../routes/azmGiftRoutes'));
    app.use('/api/proof-of-reserves', generalLimiter, require('../../routes/proofOfReservesRoutes'));
    app.use('/api/azm-convert', generalLimiter, require('../../routes/azmConversionRoutes'));
    app.use('/api/order-book', generalLimiter, require('../../routes/orderBookRoutes'));
    app.use('/api/multi-currency', generalLimiter, require('../../routes/multiCurrencyRoutes'));
    app.use('/api/cross-border-susu', generalLimiter, require('../../routes/crossBorderSusuRoutes'));
    app.use('/api/governance', generalLimiter, require('../../routes/governanceRoutes'));
    app.use('/api/smart-routes', financialLimiter, require('../../routes/smartRouteRoutes'));
    app.use('/api/azm-auction', generalLimiter, require('../../routes/azmAuctionRoutes'));
    app.use('/api/saved-momo', financialLimiter, require('../../routes/savedMomoRoutes'));
    app.use('/api/transit', generalLimiter, require('../../routes/transitRoutes'));

    app.use('/api/quotes', financialLimiter, require('../../routes/transactionQuoteRoutes'));

    const { userRouter: porUserRouter, adminRouter: porAdminRouter } = require('../../routes/proofOfResidencyRoutes');
    const { publicRouter: liabPublicRouter, adminRouter: liabAdminRouter } = require('../../routes/liabilityContractRoutes');
    app.use('/api/users/proof-of-residency', generalLimiter, porUserRouter);
    app.use('/api/admin/proof-of-residency', generalLimiter, porAdminRouter);
    app.use('/api/liability-contract', generalLimiter, liabPublicRouter);
    app.use('/api/admin/liability-contract', generalLimiter, liabAdminRouter);
    app.use('/api/admin/war-room', generalLimiter, require('../../routes/adminWarRoomRoutes'));
    app.use('/api/admin/susu', generalLimiter, require('../../routes/adminSusuRoutes'));
    app.use('/api/admin/rbac', generalLimiter, require('../../routes/adminRbacRoutes'));
    app.use('/api/admin/control-plane', generalLimiter, require('../../routes/adminControlPlaneRoutes'));
    app.use('/api/admin/control-plane', generalLimiter, require('../../routes/adminControlPlaneSummaryRoutes'));
    app.use('/api/admin/control-plane', generalLimiter, require('../../routes/adminControlPlaneExecutiveRoutes'));
    app.use('/api/admin/control-plane', generalLimiter, require('../../routes/adminReconciliationRoutes'));

    app.use('/api/marketplace', generalLimiter, require('../../routes/marketplaceRoutes'));
    // Canonical scoped Business OS financial and operational security routes
    // run before the legacy monolithic router during cleanup.
    app.use('/api/business-os', financialLimiter, require('../../routes/businessOSFinanceRoutes'));
    app.use('/api/business-os', financialLimiter, require('../../routes/businessOSPosRoutes'));
    app.use('/api/business-os', generalLimiter, require('../../routes/businessOSKioskRoutes'));
    app.use('/api/business-os', generalLimiter, require('../../routes/businessOSRoutes'));
    app.use('/api/developer', generalLimiter, require('../../routes/developerRoutes'));
    app.use('/api/qr', generalLimiter, require('../../routes/qrRoutes'));
    app.use('/api/storefront', generalLimiter, require('../../routes/storefrontCheckoutReadinessRoutes'));
    app.use('/api/storefront', generalLimiter, require('../../routes/storefrontCheckoutIntegrityRoutes'));
    app.use('/api/storefront', generalLimiter, require('../../routes/storefrontExperienceRoutes'));
    app.use('/api/storefront', generalLimiter, require('../../routes/storefrontRoutes'));
    app.use('/api/azm-stake', generalLimiter, require('../../routes/azmStakeRoutes'));
    app.use('/api/admin/storefront', generalLimiter, require('../../routes/adminStorefrontRoutes'));
    app.use('/api/changelog', generalLimiter, require('../../routes/changelogRoutes'));

    const chatUploadExtended = require('../../routes/chatUploadRoutesExtended');
    app.use('/api/chat', chatUploadExtended);
    app.post('/api/business/upload/image', require('../../middleware/authMiddleware').protect, chatUploadExtended.imageUpload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        try {
            const folder = req.query.folder === 'logos' ? 'business/logos' : req.query.folder === 'kyb' ? 'business/kyb' : 'business/products';
            const { url } = await require('../../services/cloudinaryService').uploadToCloudinary(req.file, folder);
            res.status(200).json({ success: true, url, mimeType: req.file.mimetype, size: req.file.size, filename: req.file.originalname });
        } catch (err) {
            logger.error({ err }, 'Business image upload error');
            res.status(500).json({ success: false, message: 'Upload failed' });
        }
    });

    const { protect: protectVendorUpload } = require('../../middleware/authMiddleware');
    const vendorDocsUpload = chatUploadExtended.vendorDocsUpload;
    app.post('/api/vendor/upload-docs', protectVendorUpload, vendorDocsUpload.fields([{ name: 'idFront', maxCount: 1 }, { name: 'idBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }, { name: 'addressProof', maxCount: 1 }]), async (req, res) => {
        try {
            if (!req.files || Object.keys(req.files).length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });
            const { uploadToCloudinary } = require('../../services/cloudinaryService');
            const urls = {};
            for (const [field, files] of Object.entries(req.files)) if (files && files.length > 0) urls[field] = (await uploadToCloudinary(files[0], 'vendor-docs')).url;
            logger.info({ userId: req.user.id, keys: Object.keys(urls) }, 'Vendor: documents uploaded');
            return res.status(200).json({ success: true, urls });
        } catch (err) {
            logger.error({ err }, 'Vendor docs upload error');
            res.status(500).json({ success: false, message: 'Upload failed' });
        }
    });
}

module.exports = { mountRoutes };