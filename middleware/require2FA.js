// middleware/require2FA.js
// =============================================================================
// Step-up 2FA enforcement middleware for high-value financial operations.
//
// If the user has 2FA enabled, they MUST supply a valid `totpToken` in the
// request body. If 2FA is not enabled, they must supply their `password`
// instead. This prevents a stolen session from performing destructive
// financial actions without re-authentication.
//
// Usage:
//   router.post('/fiat', protect, require2FA(), withdrawalController.fiatWithdrawal);
//
// The middleware reads `totpToken` and `password` from req.body.
// =============================================================================

const bcrypt = require('bcryptjs');
const logger = require('../src/config/logger');
const {
    verifyAndClaimTotp,
    sendTotpFailure,
    sendTotpUnavailable,
    TOTP_CODES,
} = require('../src/services/totpStepClaimService');

function require2FA() {
    return async (req, res, next) => {
        try {
            const prisma = req.app.get('prisma');
            const userId = req.user.id;
            const { totpToken, password } = req.body;

            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { password: true, isTwoFactorEnabled: true, twoFactorSecret: true },
            });

            if (!user) {
                return res.status(401).json({ success: false, message: 'Authentication required.' });
            }

            if (user.isTwoFactorEnabled) {
                // 2FA path — require TOTP token
                if (!totpToken) {
                    return res.status(401).json({
                        success: false,
                        code: '2FA_REQUIRED',
                        message: 'Two-factor authentication token required for this operation.',
                    });
                }
                // §WP-F — one shared authority: verifying and claiming the
                // matched step is a single call, so a code accepted here is
                // spent for every other path too.
                const verdict = await verifyAndClaimTotp({
                    prisma,
                    userId,
                    secret: user.twoFactorSecret,
                    token: totpToken,
                });
                if (!verdict.ok) {
                    return sendTotpFailure(res, verdict, { invalidStatus: 401, invalidMessage: 'Invalid 2FA token.' });
                }
            } else {
                // Password path — require password re-confirmation
                if (!password) {
                    return res.status(401).json({
                        success: false,
                        code: 'PASSWORD_REQUIRED',
                        message: 'Password required to confirm this operation.',
                    });
                }
                const match = await bcrypt.compare(password, user.password);
                if (!match) {
                    return res.status(401).json({ success: false, message: 'Invalid password.' });
                }
            }

            // Strip the credentials from the body so downstream controllers
            // don't accidentally log or store them.
            delete req.body.totpToken;
            delete req.body.password;

            next();
        } catch (err) {
            // A claim-store outage is "not verified", never "verified".
            if (err && err.code === TOTP_CODES.UNAVAILABLE) return sendTotpUnavailable(res);
            logger.error({ err: err }, '[require2FA] error');
            return res.status(500).json({ success: false, message: 'Authentication verification failed.' });
        }
    };
}

module.exports = { require2FA };
