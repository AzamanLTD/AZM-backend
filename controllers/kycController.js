// controllers/kycController.js
// Phase Q6 — KYC Integration (Dojah) — 2026-05-25
//
// Endpoints:
//   POST /api/kyc/initialize       — Create Dojah session, return widget URL
//   POST /api/kyc/webhook/dojah    — HMAC-secured webhook receiver (no auth middleware)
//   GET  /api/kyc/status           — Current KYC status for authenticated user
//   POST /api/kyc/admin/override   — Admin manual approve/reject (admin-only)

/**
 * 1. INITIALIZE KYC SESSION
 * Creates a Dojah verification session and returns the widget URL
 * for the frontend to open in a WebView.
 */
exports.initializeKyc = async (req, res) => {
    try {
        const kycService = req.app.get('kycService');
        const userId = req.user.id;
        const { firstName, lastName } = req.body;

        const result = await kycService.initializeSession({
            userId,
            email: req.user.email,
            firstName: firstName || req.user.username,
            lastName: lastName || undefined
        });

        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }

        res.status(200).json({
            success: true,
            message: 'KYC session initialized. Open the widget URL to begin verification.',
            widgetUrl: result.widgetUrl,
            referenceId: result.referenceId,
            provider: result.provider,
            expiresAt: result.expiresAt,
            // Only include mock hint in non-production
            ...(process.env.NODE_ENV !== 'production' && result._mockHint ? { _mockHint: result._mockHint } : {})
        });
    } catch (error) {
        console.error('❌ [KYC] Initialize error:', error);
        res.status(500).json({ success: false, message: 'Server error during KYC initialization.' });
    }
};

/**
 * 2. DOJAH WEBHOOK RECEIVER
 * Receives verification results from Dojah.
 * NO auth middleware — secured via HMAC signature verification.
 * Route: POST /api/kyc/webhook/dojah
 */
exports.handleDojahWebhook = async (req, res) => {
    try {
        const kycService = req.app.get('kycService');

        // Dojah sends signature in x-dojah-signature header
        const signature = req.headers['x-dojah-signature'] || req.headers['x-webhook-signature'] || '';
        const payload = req.body;

        if (!payload || Object.keys(payload).length === 0) {
            return res.status(400).json({ success: false, message: 'Empty webhook payload.' });
        }

        // Phase H12 (2026-05-27): pass req.rawBody through so HMAC
        // verifies against the byte-exact request body, not a Node
        // re-stringification of the parsed object. The express.json
        // verify hook in server.js captures rawBody.
        const result = await kycService.processWebhook(payload, signature, req.rawBody);

        if (!result.success) {
            // Return 200 to Dojah anyway to prevent retries on signature failures
            // (log the error server-side for investigation)
            console.error(`❌ [KYC/Webhook] Processing failed: ${result.message}`);
            return res.status(200).json({ received: true, processed: false });
        }

        // Always return 200 to webhook providers to acknowledge receipt
        res.status(200).json({
            received: true,
            processed: true,
            userId: result.userId,
            newStatus: result.newStatus
        });
    } catch (error) {
        console.error('❌ [KYC/Webhook] Unhandled error:', error);
        // Still return 200 to prevent infinite webhook retries
        res.status(200).json({ received: true, processed: false, error: 'Internal processing error.' });
    }
};

/**
 * 3. GET KYC STATUS
 * Returns current KYC status for the authenticated user.
 * Enriched response with re-initialization eligibility.
 */
exports.getKycStatus = async (req, res) => {
    try {
        const kycService = req.app.get('kycService');
        const userId = req.user.id;

        const result = await kycService.getStatus(userId);

        if (!result.success) {
            return res.status(404).json({ success: false, message: result.message });
        }

        res.status(200).json({
            success: true,
            kyc: {
                status: result.kycStatus,
                legalName: result.legalName,
                idType: result.idType,
                idNumber: result.idNumber,
                canReinitialize: result.canReinitialize
            }
        });
    } catch (error) {
        console.error('❌ [KYC] Status check error:', error);
        res.status(500).json({ success: false, message: 'Server error checking KYC status.' });
    }
};

/**
 * 4. ADMIN MANUAL OVERRIDE
 * Admin can approve or reject KYC regardless of Dojah result.
 * Route: POST /api/kyc/admin/override
 * Body: { userId, action: 'approve'|'reject', reason }
 */
exports.adminKycOverride = async (req, res) => {
    try {
        const kycService = req.app.get('kycService');
        const adminId = req.user.id;
        const { userId, action, reason } = req.body;

        if (!userId || !action) {
            return res.status(400).json({
                success: false,
                message: 'userId and action (approve/reject) are required.'
            });
        }

        if (!reason) {
            return res.status(400).json({
                success: false,
                message: 'reason is required for audit trail.'
            });
        }

        const result = await kycService.adminOverride({
            userId,
            action,
            reason,
            adminId
        });

        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }

        res.status(200).json({
            success: true,
            message: `KYC ${action === 'approve' ? 'approved' : 'rejected'} successfully.`,
            userId: result.userId,
            newStatus: result.newStatus,
            overriddenBy: result.overriddenBy,
            reason: result.reason
        });
    } catch (error) {
        console.error('❌ [KYC] Admin override error:', error);
        res.status(500).json({ success: false, message: 'Server error during KYC override.' });
    }
};
