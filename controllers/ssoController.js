// controllers/ssoController.js
// =============================================================================
// AZAMAN V4 — SSO CONTROLLER (Google & Apple Sign-In)
//
// Handles federated authentication via Firebase ID tokens.
// Flow:
//   1. Frontend authenticates with Google/Apple via Firebase Auth SDK
//   2. Frontend sends the Firebase ID token to POST /api/auth/sso
//   3. Backend verifies the token, finds/creates the user, returns JWT
//
// Endpoints:
//   POST /api/auth/sso — Authenticate via Firebase ID token
// =============================================================================

const { issueTokenPair } = require('../services/authTokenService');

// Phase K hardening: when no Firebase Admin is initialised, the dev
// fallback decodes the JWT WITHOUT verifying the signature. That's a
// massive security hole if it ever leaks into a non-dev deployment, so
// we gate it behind an explicit env flag AND require an aud match. The
// flag is OFF by default — production must initialise Firebase Admin.
const SSO_DEV_FALLBACK = process.env.SSO_DEV_FALLBACK === '1';
const SSO_EXPECTED_AUD = process.env.FIREBASE_PROJECT_ID || process.env.SSO_EXPECTED_AUD || '';

/**
 * POST /api/auth/sso
 * Body: { idToken, provider: 'google' | 'apple', referredByCode? }
 *
 * Verifies the Firebase ID token, creates or finds the user, and returns
 * a JWT session token. If the user doesn't exist, auto-registers them.
 */
exports.ssoLogin = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { idToken, provider, referredByCode } = req.body;

        if (!idToken || typeof idToken !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'idToken is required.'
            });
        }

        if (!provider || !['google', 'apple'].includes(provider)) {
            return res.status(400).json({
                success: false,
                message: 'provider must be "google" or "apple".'
            });
        }

        // ── Verify Firebase ID Token ─────────────────────────────────────
        let decodedToken;
        try {
            const admin = require('firebase-admin');
            // Firebase Admin should be initialized once at server startup
            // If not initialized, skip verification in dev mode
            if (!admin.apps.length) {
                // Phase K: this fallback used to silently decode the JWT
                // WITHOUT verifying the signature, which is fine for a
                // local dev box but a critical hole if the env-flag
                // lands in production. Now gated behind an explicit
                // SSO_DEV_FALLBACK=1 env flag, AND we still verify the
                // `aud` claim against FIREBASE_PROJECT_ID so a token
                // minted for a different Firebase project can't be
                // replayed against this backend.
                if (process.env.NODE_ENV === 'production' || !SSO_DEV_FALLBACK) {
                    return res.status(503).json({
                        success: false,
                        message: 'Firebase Admin not initialized. SSO unavailable.'
                    });
                }
                // Phase K hardening: dev fallback ALSO refuses when no
                // expected audience is configured. Without that guard,
                // a non-prod env with SSO_DEV_FALLBACK=1 would accept
                // any unsigned JWT with a valid email — turning the dev
                // path into an unauthenticated identity oracle.
                if (!SSO_EXPECTED_AUD) {
                    console.error(
                        '[SSO][dev-fallback] refused: SSO_DEV_FALLBACK=1 ' +
                        'but no SSO_EXPECTED_AUD or FIREBASE_PROJECT_ID set.'
                    );
                    return res.status(503).json({
                        success: false,
                        message: 'SSO dev-fallback misconfigured (no aud).'
                    });
                }
                const parts = idToken.split('.');
                if (parts.length === 3) {
                    decodedToken = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                } else {
                    return res.status(401).json({ success: false, message: 'Invalid token format.' });
                }
                // Audience check on the dev path. The SSO_EXPECTED_AUD
                // guard above already proves it's set; this is the
                // actual comparison.
                if (decodedToken.aud !== SSO_EXPECTED_AUD) {
                    console.error('[SSO][dev-fallback] aud mismatch:', decodedToken.aud);
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid audience on ID token.'
                    });
                }
                // Expiry check — the SDK does this for us in production,
                // but the dev fallback has to do it manually.
                if (decodedToken.exp && decodedToken.exp * 1000 < Date.now()) {
                    return res.status(401).json({
                        success: false,
                        message: 'ID token has expired.'
                    });
                }
            } else {
                // Production path. verifyIdToken in firebase-admin already
                // checks signature, expiry, AND aud (it must equal the
                // initialised project id), so we get all three for free.
                decodedToken = await admin.auth().verifyIdToken(idToken);
                // Defence-in-depth: if SSO_EXPECTED_AUD is configured,
                // double-check it. The SDK's check is project-scoped
                // already, so this is mostly a belt-and-braces on
                // multi-tenant configs.
                if (SSO_EXPECTED_AUD && decodedToken.aud !== SSO_EXPECTED_AUD) {
                    console.error('[SSO] aud mismatch (post-verify):', decodedToken.aud);
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid audience on ID token.'
                    });
                }
            }
        } catch (verifyError) {
            console.error('[SSO] Token verification failed:', verifyError.message);
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired ID token.'
            });
        }

        // ── Extract user info from token ─────────────────────────────────
        const firebaseUid = decodedToken.uid || decodedToken.sub;
        const email = decodedToken.email || '';
        const name = decodedToken.name || decodedToken.displayName || '';
        const picture = decodedToken.picture || decodedToken.photoURL || null;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email not available from SSO provider. Please use email/password login.'
            });
        }

        // ── Find or create user ──────────────────────────────────────────
        let user;
        const normalizedEmail = email.toLowerCase().trim();

        // Check by provider-specific ID first
        if (provider === 'google') {
            user = await prisma.user.findUnique({ where: { googleId: firebaseUid } });
        } else {
            user = await prisma.user.findUnique({ where: { appleId: firebaseUid } });
        }

        // If not found by provider ID, check by email
        if (!user) {
            user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        }

        let isNewUser = false;

        if (!user) {
            // Auto-register new user
            isNewUser = true;
            const username = _generateUsername(name, normalizedEmail);

            const createData = {
                username,
                email: normalizedEmail,
                password: '', // SSO users don't have a password
                availableBalance: 0.0,
                profilePictureUrl: picture,
                lastLoginAt: new Date(),
                loginStreak: 1,
            };

            // Link provider ID
            if (provider === 'google') {
                createData.googleId = firebaseUid;
            } else {
                createData.appleId = firebaseUid;
            }

            // Apply referral code if provided
            if (referredByCode && typeof referredByCode === 'string') {
                createData.referredByCode = referredByCode.trim();
            }

            user = await prisma.user.create({ data: createData });
        } else {
            // Existing user — link provider if not already linked
            const updateData = { lastLoginAt: new Date() };

            if (provider === 'google' && !user.googleId) {
                updateData.googleId = firebaseUid;
            } else if (provider === 'apple' && !user.appleId) {
                updateData.appleId = firebaseUid;
            }

            // Update profile picture if not set
            if (!user.profilePictureUrl && picture) {
                updateData.profilePictureUrl = picture;
            }

            // Track login streak
            if (user.lastLoginAt) {
                const lastLogin = new Date(user.lastLoginAt);
                const daysSince = Math.floor((Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24));
                if (daysSince === 1) {
                    updateData.loginStreak = (user.loginStreak || 0) + 1;
                } else if (daysSince > 1) {
                    updateData.loginStreak = 1;
                }
            } else {
                updateData.loginStreak = 1;
            }

            user = await prisma.user.update({
                where: { id: user.id },
                data: updateData
            });
        }

        // ── Generate JWT ─────────────────────────────────────────────────
        // Phase K — issues access (15min) + refresh (30day) pair.
        const { accessToken, refreshToken, refreshExpiresAt } = await issueTokenPair(
            prisma,
            user,
            { userAgent: req.headers['user-agent'], ipAddress: req.ip }
        );

        return res.status(isNewUser ? 201 : 200).json({
            success: true,
            message: isNewUser ? 'Account created via SSO.' : 'Login successful.',
            isNewUser,
            token: accessToken,
            accessToken,
            refreshToken,
            refreshExpiresAt: refreshExpiresAt.toISOString(),
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                displayName: user.displayName || null,
                profilePictureUrl: user.profilePictureUrl || null,
                kycStatus: user.kycStatus || 'UNVERIFIED',
                availableBalance: user.availableBalance || 0.0,
                azmBalance: user.azmBalance || 0.0,
                vendorLevel: user.vendorLevel || 'BRONZE',
                loyaltyTier: user.loyaltyTier || 'STANDARD',
                onboardingCompleted: user.onboardingCompleted || false,
                selectedTheme: user.selectedTheme || 'dark',
                loginStreak: user.loginStreak || 1,
                tradesCompleted: user.tradesCompleted || 0
            }
        });

    } catch (error) {
        console.error('[SSO] error:', error.message);

        // Handle unique constraint violations (race condition on double-tap)
        if (error.code === 'P2002') {
            return res.status(409).json({
                success: false,
                message: 'Account already exists with this email. Please use email login.'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'SSO authentication failed. Please try again.'
        });
    }
};


// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a unique username from the user's name or email.
 * Format: FirstName_RandomSuffix (e.g., "John_8f2a")
 */
function _generateUsername(name, email) {
    const crypto = require('crypto');
    const suffix = crypto.randomBytes(2).toString('hex');

    if (name && name.trim().length > 0) {
        const cleanName = name.trim().split(' ')[0].replace(/[^a-zA-Z0-9_]/g, '');
        if (cleanName.length >= 2) {
            return `${cleanName}_${suffix}`;
        }
    }

    // Fallback to email prefix
    const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').substring(0, 12);
    return `${emailPrefix}_${suffix}`;
}
