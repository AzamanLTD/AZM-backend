const logger = require('../src/config/logger');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

exports.setup2FA = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.isTwoFactorEnabled) {
            return res.status(400).json({ success: false, message: '2FA is already enabled' });
        }

        const secret = speakeasy.generateSecret({
            name: `Azaman (${user.email})`,
            issuer: 'Azaman',
        });

        const dataURL = await QRCode.toDataURL(secret.otpauth_url);

        await prisma.user.update({
            where: { id: userId },
            data: { twoFactorSecret: secret.base32 },
        });

        res.status(200).json({
            success: true,
            message: '2FA secret generated. Scan the QR code with Google Authenticator.',
            secret: secret.base32,
            qrCodeDataURL: dataURL,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.verify2FA = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.twoFactorSecret) {
            return res.status(400).json({ success: false, message: '2FA not set up. Call setup endpoint first.' });
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ success: false, message: 'Invalid 2FA token' });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { isTwoFactorEnabled: true },
        });

        res.status(200).json({
            success: true,
            message: '2FA verified and enabled successfully',
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};


const bcrypt = require('bcryptjs');

// =============================================================================
// DISABLE 2FA
// =============================================================================
exports.disable2FA = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required to disable 2FA.' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.isTwoFactorEnabled || !user.twoFactorSecret) {
            return res.status(400).json({ success: false, message: '2FA is not currently enabled.' });
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ success: false, message: 'Invalid 2FA token. Cannot disable.' });
        }

        await prisma.user.update({
            where: { id: userId },
            data: {
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
            },
        });

        res.status(200).json({
            success: true,
            message: '2FA has been disabled successfully.',
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// SET PIN
// =============================================================================
exports.setPin = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { pin } = req.body;

        if (!pin) {
            return res.status(400).json({ success: false, message: 'PIN is required.' });
        }

        if (!/^\d{4,6}$/.test(pin)) {
            return res.status(400).json({ success: false, message: 'PIN must be 4-6 numeric digits.' });
        }

        const pinHash = await bcrypt.hash(pin, 10);

        await prisma.user.update({
            where: { id: userId },
            data: { pinHash },
        });

        res.status(200).json({
            success: true,
            message: 'PIN has been set successfully.',
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// CHANGE PASSWORD
//
// Verifies the user's current password via bcrypt, then writes a freshly
// hashed new password. Refuses to operate on SSO-only accounts (those have
// `password === ''`) — those users must set a password via a separate flow
// before they can change it.
// =============================================================================
exports.changePassword = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Current password is required.',
            });
        }

        if (!newPassword || typeof newPassword !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'New password is required.',
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 8 characters long.',
            });
        }

        if (newPassword === currentPassword) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from the current password.',
            });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // SSO-only accounts have an empty password and cannot use this flow
        // until they've claimed a password through a dedicated set-password endpoint.
        if (!user.password || user.password.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'This account uses SSO sign-in. Set a password before changing it.',
            });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect.',
            });
        }

        const salt = await bcrypt.genSalt(12);
        const newHash = await bcrypt.hash(newPassword, salt);

        // Phase K — atomically write the new hash, bump tokenVersion (so any
        // existing access JWT is rejected by `protect`), revoke every active
        // refresh token (so the client can't bypass the access-JWT rejection
        // by silently refreshing), AND insert the new refresh-token row for
        // this device — all in one transaction. If any step fails, none
        // commit. Without folding the new-token insert into the same
        // transaction, a DB hiccup between the revoke and the insert would
        // leave the user with everything revoked and no replacement —
        // they'd be forced to log in again immediately on the device that
        // just changed its own password.
        const crypto = require('crypto');
        const newRefreshTokenId = crypto.randomUUID();
        const refreshExpiresAt = new Date(
            Date.now() + (parseInt(process.env.JWT_REFRESH_EXPIRY_DAYS || '30', 10)) * 24 * 60 * 60 * 1000
        );

        const [updatedUser] = await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: {
                    password: newHash,
                    tokenVersion: { increment: 1 },
                },
                select: { id: true, username: true, role: true, tokenVersion: true },
            }),
            prisma.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: new Date() },
            }),
            prisma.refreshToken.create({
                data: {
                    id: newRefreshTokenId,
                    userId,
                    expiresAt: refreshExpiresAt,
                    userAgent: req.headers['user-agent'] ?? null,
                    ipAddress: req.ip ?? null,
                },
            }),
        ]);

        // Sign the access token AFTER the transaction commits — the JWT
        // is stateless so no rollback concern, but we want it to carry
        // the post-commit tokenVersion. signAccessToken throws if the
        // user object is missing tokenVersion (Phase K invariant).
        const { signAccessToken } = require('../services/authTokenService');
        const accessToken = signAccessToken(updatedUser);
        const refreshToken = newRefreshTokenId;

        // Best-effort audit trail entry. Wrapped in try/catch so a logging
        // failure never blocks the password change itself.
        // Phase N2: route through notificationService for DB + socket + FCM
        try {
            const NotificationService = require('../services/notificationService');
            const io = req.app.get('socketio');
            const notifSvc = new NotificationService(prisma, io);
            await notifSvc.sendNotification({
                userId,
                title: 'Password changed',
                body: 'Your account password was changed successfully.',
                category: 'SECURITY_ACCOUNT',
                actionPayload: {}
            });
        } catch (logErr) {
            logger.warn('[SECURITY] failed to write password-change notification:', logErr.message);
        }

        return res.status(200).json({
            success: true,
            message: 'Password updated successfully.',
            // Phase K — replacement pair so the requesting device stays
            // logged in. Other devices using stale tokens will get
            // TOKEN_STALE on their next request and be forced to log in
            // again. Both `token` and `accessToken` keys are returned
            // for one release cycle to keep legacy FE consumers in sync.
            token: accessToken,
            accessToken,
            refreshToken,
            refreshExpiresAt: refreshExpiresAt.toISOString(),
        });
    } catch (error) {
        logger.error({ err: error }, '[SECURITY] changePassword error');
        return res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// VERIFY PIN
// =============================================================================
exports.verifyPin = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { pin } = req.body;

        if (!pin) {
            return res.status(400).json({ success: false, message: 'PIN is required.' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.pinHash) {
            return res.status(400).json({ success: false, message: 'No PIN has been set for this account.' });
        }

        const verified = await bcrypt.compare(pin, user.pinHash);

        res.status(200).json({
            success: true,
            verified,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};


// =============================================================================
// SEND PHONE OTP (Phase L2)
//
// POST /api/security/phone/send-otp
// Body: { phoneNumber } — E.164 format (e.g. "+233241234567")
//
// Dispatches a 6-digit OTP via smsService. The OTP is stored in-memory on the
// singleton (keyed by phone number, 5-min TTL, 3 attempts). The user must
// verify the OTP within the TTL via /phone/verify-otp.
//
// If the phoneNumber matches the user's existing phoneNumber, this is a
// re-verification flow. If it's different, we treat it as a "change phone"
// step — the DB isn't updated until the OTP is verified.
// =============================================================================
exports.sendPhoneOtp = async (req, res) => {
    const prisma     = req.app.get('prisma');
    const smsService = req.app.get('smsService');

    try {
        const userId = req.user.id;
        const { phoneNumber } = req.body;

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'phoneNumber is required (E.164 format, e.g. "+233241234567").'
            });
        }

        // Basic E.164 validation: starts with + followed by 7-15 digits
        const e164Regex = /^\+[1-9]\d{6,14}$/;
        if (!e164Regex.test(phoneNumber)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid phone number format. Use E.164 (e.g. "+233241234567").'
            });
        }

        if (!smsService) {
            logger.error('[sendPhoneOtp] smsService not bound to app context.');
            return res.status(503).json({
                success: false,
                message: 'SMS service is unavailable. Try again later.'
            });
        }

        const result = await smsService.sendOTP(phoneNumber, 6, 5);

        return res.status(200).json({
            success: true,
            message: 'OTP sent successfully. Check your phone.',
            expiresAt: result.expiresAt,
            // In test/dev mode, surface the OTP for easy testing
            ...(result.otp ? { testOtp: result.otp } : {})
        });
    } catch (error) {
        logger.error({ err: error }, '[sendPhoneOtp] error');
        return res.status(500).json({ success: false, message: 'Failed to send OTP.' });
    }
};

// =============================================================================
// VERIFY PHONE OTP (Phase L2)
//
// POST /api/security/phone/verify-otp
// Body: { phoneNumber, code }
//
// On successful verification:
//   1. Updates user.phoneNumber to the verified number (in case it changed).
//   2. Sets user.phoneVerified = true.
//
// This gates all transactional SMS sends (withdrawal confirmations, future
// trade alerts) to only OTP-verified phone numbers.
// =============================================================================
exports.verifyPhoneOtp = async (req, res) => {
    const prisma     = req.app.get('prisma');
    const smsService = req.app.get('smsService');

    try {
        const userId = req.user.id;
        const { phoneNumber, code } = req.body;

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'phoneNumber is required.'
            });
        }

        if (!code || typeof code !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'OTP code is required.'
            });
        }

        if (!smsService) {
            return res.status(503).json({
                success: false,
                message: 'SMS service is unavailable.'
            });
        }

        const verification = await smsService.verifyOTP(phoneNumber, code);

        if (!verification.success) {
            return res.status(400).json({
                success: false,
                message: verification.message,
                ...(verification.attemptsLeft !== undefined ? { attemptsLeft: verification.attemptsLeft } : {})
            });
        }

        // OTP verified — persist the verified phone number + its discovery
        // hash (Phase 6). phoneHash = HMAC-SHA256(E.164, server pepper); raw
        // numbers are never compared against plaintext in Contact_Discovery.
        const { hashPhone } = require('../services/identity/phoneHash');
        await prisma.user.update({
            where: { id: userId },
            data: {
                phoneNumber:   phoneNumber,
                phoneVerified: true,
                phoneHash:     hashPhone(phoneNumber),
            }
        });

        // Master Sprint (2026-05-27): Pre-registration Vouch Hook
        // Now that a phone is verified, link any pending VouchRecord rows
        // that targeted this number while the user was off-platform.
        setImmediate(() => {
            try {
                const { SusuService } = require('../services/susuService');
                SusuService.linkPreRegistrationVouches(prisma, userId, phoneNumber)
                    .then((linked) => {
                        if (linked > 0) {
                            logger.info(`[verifyPhoneOtp] Linked ${linked} pre-registration vouches for user ${userId}`);
                        }
                    })
                    .catch((err) => logger.error({ err: err }, '[verifyPhoneOtp] vouch link error'));
            } catch (_) { /* swallow */ }
        });

        return res.status(200).json({
            success: true,
            message: 'Phone number verified successfully.',
            phoneNumber
        });
    } catch (error) {
        logger.error({ err: error }, '[verifyPhoneOtp] error');
        return res.status(500).json({ success: false, message: 'Verification failed.' });
    }
};
