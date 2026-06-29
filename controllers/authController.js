// controllers/authController.js
// =============================================================================
// AZAMAN V3 — AUTH CONTROLLER (Production-Hardened)
//
// SECURITY FIXES APPLIED:
//   - Removed hardcoded admin backdoor (CRITICAL-1)
//   - Removed JWT secret fallback (CRITICAL-2)
//   - Admin provisioning via secure env vars only (ADMIN_SEED_EMAIL/PASSWORD)
//   - Admin seed only runs once on first login attempt with those credentials
// =============================================================================

const bcrypt = require('bcryptjs');
const { issueTokenPair } = require('../services/authTokenService');

// ── Startup validation ───────────────────────────────────────────────────────
// CRITICAL-2: Crash immediately if JWT_SECRET is not configured.
// This prevents accidental deployment with a guessable default secret.
// (The token-signing logic itself moved to services/authTokenService.js in
// Phase K. The startup-crash guard stays here because authController is
// imported early in routes/authRoutes.js and we want the process to refuse
// to even boot without a secret.)
if (!process.env.JWT_SECRET) {
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('  FATAL: JWT_SECRET environment variable is NOT SET.');
    console.error('  The server CANNOT start without a cryptographic signing key.');
    console.error('  Set JWT_SECRET in your .env file or deployment config.');
    console.error('═══════════════════════════════════════════════════════════════');
    process.exit(1);
}

// ── Input Validation Helpers ─────────────────────────────────────────────────

const validateLoginInput = (email, password) => {
    const errors = [];
    if (!email || typeof email !== 'string' || email.trim() === '') {
        errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('Invalid email format');
    }
    if (!password || typeof password !== 'string' || password.trim() === '') {
        errors.push('Password is required');
    }
    return errors;
};

const validateRegisterInput = (username, email, password) => {
    const errors = [];
    if (!username || typeof username !== 'string' || username.trim() === '') {
        errors.push('Username is required');
    } else if (username.length < 3) {
        errors.push('Username must be at least 3 characters long');
    } else if (username.length > 30) {
        errors.push('Username must be 30 characters or fewer');
    } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        errors.push('Username can only contain letters, numbers, and underscores');
    }
    if (!email || typeof email !== 'string' || email.trim() === '') {
        errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('Invalid email format');
    }
    if (!password || typeof password !== 'string' || password.trim() === '') {
        errors.push('Password is required');
    } else if (password.length < 8) {
        errors.push('Password must be at least 8 characters long');
    } else {
        // Complexity: enforce the same rules the Flutter UI shows, so a direct
        // API call (e.g. Postman) cannot bypass them with a weak password.
        const hasUpper = /[A-Z]/.test(password);
        const hasNumber = /[0-9]/.test(password);
        const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
        if (!hasUpper || !hasNumber || !hasSpecial) {
            errors.push('Password must contain at least one uppercase letter, one number, and one special character (!@#$%^&*)');
        }
    }
    return errors;
};

// =============================================================================
// REGISTER
// =============================================================================
exports.register = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { username, email, password, phoneNumber } = req.body;

        const validationErrors = validateRegisterInput(username, email, password);
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: validationErrors
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const trimmedUsername = username.trim();

        // Check if user exists
        const userExists = await prisma.user.findFirst({
            where: {
                OR: [
                    { email: normalizedEmail },
                    { username: trimmedUsername }
                ]
            }
        });

        if (userExists) {
            return res.status(400).json({
                success: false,
                message: userExists.email === normalizedEmail
                    ? "Email already registered"
                    : "Username already taken"
            });
        }

        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(password, salt);

        // PHASE 6: mint a unique Azaman_ID up front so the new row is born
        // fully identifiable. phoneHash stays null until OTP verification.
        const { IdentityService } = require('../services/identity/identity.service');
        const identitySvc = new IdentityService(prisma);
        const azamanId = await identitySvc.generateUniqueAzamanId();
        const trimmedPhone = phoneNumber ? String(phoneNumber).trim() : null;

        const newUser = await prisma.user.create({
            data: {
                username: trimmedUsername,
                email: normalizedEmail,
                password: hashedPassword,
                availableBalance: 0.0,
                azamanId,
                // Optional phone — used by the pre-registration vouch hook
                // below to auto-link any pending VouchRecord rows that
                // someone vouched for using this phone number while the
                // user wasn't yet on the platform. phoneHash stays null until
                // the number is OTP-verified (Contact_Discovery gate).
                phoneNumber: trimmedPhone,
            }
        });

        // ── Master Sprint (2026-05-27): Pre-registration Vouch Hook ─────
        // Scan VouchRecord for any rows that targeted this user via phone
        // number while they were off-platform, then re-key them to the
        // freshly minted userId. Fire-and-forget so a hook failure can't
        // block registration.
        if (newUser.phoneNumber) {
            setImmediate(() => {
                const { SusuService } = require('../services/susuService');
                SusuService.linkPreRegistrationVouches(prisma, newUser.id, newUser.phoneNumber)
                    .then((linked) => {
                        if (linked > 0) {
                            console.log(`[auth.register] Linked ${linked} pre-registration vouches for user ${newUser.id}`);
                        }
                    })
                    .catch((err) => console.error('[auth.register] Vouch link error:', err.message));
            });
        }

        // Auto-generate tokens on registration so user doesn't need to login separately.
        // Phase K — issues access (15min) + refresh (30day) pair.
        const { accessToken, refreshToken, refreshExpiresAt } = await issueTokenPair(
            prisma,
            newUser,
            { userAgent: req.headers['user-agent'], ipAddress: req.ip }
        );

        // Set initial login tracking
        await prisma.user.update({
            where: { id: newUser.id },
            data: { lastLoginAt: new Date(), loginStreak: 1 }
        });

        // ── Phase E1: Award AZM for the first login-streak day ────────────
        //
        // Registration sets loginStreak = 1 directly, so the streak-credit
        // branch in the `login` handler never fires for a brand-new user
        // (previousStreak === loginStreak === 1, so the `>` check is false).
        // Fire it explicitly here so day-1 of the streak counts, which is
        // what Phase E1 §LOGIN_STREAK promises ("1.0 AZM per consecutive
        // login day").
        const azmRewardService = req.app.get('azmRewardService');
        if (azmRewardService) {
            setImmediate(() => {
                azmRewardService.rewardLoginStreak(newUser.id, 1)
                    .catch(err => console.error('[auth.register] AZM first-day login streak reward error:', err.message));
            });
        }

        res.status(201).json({
            success: true,
            message: "Registration successful",
            token: accessToken,             // legacy field — clients expect `token`
            accessToken,                    // Phase K — explicit name
            refreshToken,
            refreshExpiresAt: refreshExpiresAt.toISOString(),
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                role: newUser.role,
                displayName: null,
                profilePictureUrl: null,
                kycStatus: 'UNVERIFIED',
                availableBalance: 0.0,
                azmBalance: 0.0,
                vendorLevel: 'BRONZE',
                loyaltyTier: 'STANDARD',
                onboardingCompleted: false,
                selectedTheme: 'dark',
                loginStreak: 1,
                tradesCompleted: 0,
                preferredCurrency: 'usdc',
            }
        });

    } catch (error) {
        console.error("REGISTER ERROR:", error.message);
        if (error.code === 'P2002') {
            return res.status(400).json({
                success: false,
                message: "Email or username already exists"
            });
        }
        res.status(500).json({
            success: false,
            message: "Internal server error during registration"
        });
    }
};

// =============================================================================
// LOGIN — Secure Admin Provisioning
//
// Admin access is granted ONLY when ALL of these conditions are true:
//   1. ADMIN_SEED_EMAIL env var is set
//   2. ADMIN_SEED_PASSWORD env var is set
//   3. The login credentials match those env vars exactly
//   4. The account doesn't already exist as ADMIN (one-time elevation only)
//
// After first successful admin login, the admin account exists in DB and
// subsequent logins work through normal bcrypt verification like any user.
// =============================================================================
exports.login = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { email, password } = req.body;

        const validationErrors = validateLoginInput(email, password);
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: validationErrors
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        let user = await prisma.user.findUnique({
            where: { email: normalizedEmail }
        });

        // ── Secure Admin Seed (env-var gated, one-time provisioning) ─────────
        const adminSeedEmail = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
        const adminSeedPassword = process.env.ADMIN_SEED_PASSWORD || '';

        if (
            adminSeedEmail &&
            adminSeedPassword &&
            normalizedEmail === adminSeedEmail &&
            password === adminSeedPassword
        ) {
            const salt = await bcrypt.genSalt(12);
            const hashedPassword = await bcrypt.hash(password, salt);

            if (!user) {
                // First-time admin provisioning
                user = await prisma.user.create({
                    data: {
                        username: process.env.ADMIN_SEED_USERNAME || 'AzamanAdmin',
                        email: adminSeedEmail,
                        password: hashedPassword,
                        role: 'ADMIN',
                        availableBalance: 0.0,
                    }
                });
                console.log('[AUTH] Admin account provisioned:', user.id);
            } else if (user.role !== 'ADMIN') {
                // Elevate existing account to admin (one-time)
                user = await prisma.user.update({
                    where: { id: user.id },
                    data: { role: 'ADMIN', password: hashedPassword }
                });
                console.log('[AUTH] Account elevated to admin:', user.id);
            } else {
                // Admin already exists — verify password normally
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) {
                    return res.status(401).json({
                        success: false,
                        message: "Invalid email or password"
                    });
                }
            }

            const { accessToken, refreshToken, refreshExpiresAt } = await issueTokenPair(
                prisma,
                user,
                { userAgent: req.headers['user-agent'], ipAddress: req.ip }
            );

            return res.status(200).json({
                success: true,
                message: "Login successful",
                token: accessToken,
                accessToken,
                refreshToken,
                refreshExpiresAt: refreshExpiresAt.toISOString(),
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    availableBalance: user.availableBalance || 0.0,
                    azmBalance: user.azmBalance || 0.0,
                    preferredCurrency: user.preferredCurrency || 'usdc',
                }
            });
        }

        // ── Normal login flow ────────────────────────────────────────────────
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        if (!user.password) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        // ── Track login streak ────────────────────────────────────────────
        const now = new Date();
        let loginStreak = user.loginStreak || 0;
        if (user.lastLoginAt) {
            const lastLogin = new Date(user.lastLoginAt);
            const daysSinceLastLogin = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));
            if (daysSinceLastLogin === 1) {
                loginStreak += 1; // Consecutive day
            } else if (daysSinceLastLogin > 1) {
                loginStreak = 1; // Streak broken, restart
            }
            // If daysSinceLastLogin === 0, same day login — keep streak as is
        } else {
            loginStreak = 1; // First login
        }

        await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: now, loginStreak }
        });

        // ── Phase E1: Award AZM for login streak (fire-and-forget) ────────
        const previousStreak = user.loginStreak || 0;
        if (loginStreak > previousStreak) {
            // Streak increased — award AZM asynchronously
            const azmRewardService = req.app.get('azmRewardService');
            if (azmRewardService) {
                setImmediate(() => {
                    azmRewardService.rewardLoginStreak(user.id, loginStreak)
                        .catch(err => console.error('[auth.login] AZM login streak reward error:', err.message));
                });
            }
        }

        // Re-fetch with the freshly bumped tokenVersion (it can stay stable here
        // — login does not bump it — but the read-back also picks up any pending
        // bump that an admin action made between our findUnique and now).
        const refreshedUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { id: true, username: true, role: true, tokenVersion: true },
        });

        const { accessToken, refreshToken, refreshExpiresAt } = await issueTokenPair(
            prisma,
            refreshedUser || user,
            { userAgent: req.headers['user-agent'], ipAddress: req.ip }
        );

        res.status(200).json({
            success: true,
            message: "Login successful",
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
                loginStreak: loginStreak,
                tradesCompleted: user.tradesCompleted || 0,
                preferredCurrency: user.preferredCurrency || 'usdc',
            }
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error.message);
        if (error.code === 'P1001') {
            return res.status(500).json({
                success: false,
                message: "Database connection failed"
            });
        }
        res.status(500).json({
            success: false,
            message: "Internal server error during login"
        });
    }
};

// =============================================================================
// GET USER DETAILS
// =============================================================================
exports.getUserDetails = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user ? req.user.id : parseInt(req.params.id);

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                email: true,
                displayName: true,
                profilePictureUrl: true,
                role: true,
                kycStatus: true,
                availableBalance: true,
                vendorUnallocatedBalance: true,
                escrowLockedBalance: true,
                azmBalance: true,
                vendorLevel: true,
                vendorXp: true,
                loyaltyTier: true,
                onboardingCompleted: true,
                selectedTheme: true,
                loginStreak: true,
                tradesCompleted: true,
                currentStreak: true,
                isTwoFactorEnabled: true
            }
        });

        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ success: true, data: user });
    } catch (error) {
        console.error("Get User Details Error:", error.message);
        res.status(500).json({ success: false, message: "Failed to fetch user details." });
    }
};

// =============================================================================
// SAVE FCM TOKEN
// =============================================================================
exports.saveFcmToken = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { fcmToken } = req.body;
        if (!fcmToken || typeof fcmToken !== 'string') {
            return res.status(400).json({ success: false, message: "fcmToken is required." });
        }

        await prisma.user.update({
            where: { id: req.user.id },
            data: { fcmToken: fcmToken }
        });

        return res.status(200).json({ success: true, message: "FCM token saved." });
    } catch (error) {
        console.error("Save FCM Token Error:", error.message);
        return res.status(500).json({ success: false, message: "Server error saving token." });
    }
};

// =============================================================================
// PUBLIC ORACLE RATES
// =============================================================================
exports.getPublicRates = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        res.status(200).json({
            success: true,
            liveUsdToGhs: settings ? settings.liveUsdToGhs : 11.02,
            bankMargin: settings ? settings.bankMargin : 3.0,
            thirdPartyMargin: settings ? settings.thirdPartyMargin : 2.0
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to fetch rates." });
    }
};
