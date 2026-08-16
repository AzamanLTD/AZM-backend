// controllers/webauthnController.js
// =============================================================================
// AZAMAN — WebAuthn / Passkey Controller (Phase 2: Scalability & Security)
//
// Implements FIDO2 passwordless authentication using @simplewebauthn/server.
// Users can register passkeys (Face ID, Touch ID, YubiKey, etc.) and use them
// for passwordless login or as a step-up auth factor alongside TOTP 2FA.
//
// Endpoints:
//   POST /api/security/webauthn/register/begin   — start passkey registration
//   POST /api/security/webauthn/register/finish  — verify + store credential
//   POST /api/security/webauthn/login/begin      — start passkey login challenge
//   POST /api/security/webauthn/login/finish      — verify assertion + issue JWT
//   GET  /api/security/webauthn/credentials        — list user's passkeys
//   DELETE /api/security/webauthn/credentials/:id  — remove a passkey
//
// Relying Party (RP) config comes from env:
//   WEBAUTHN_RP_NAME   — Display name (default: "Azaman")
//   WEBAUTHN_RP_ID     — Domain (default: derived from CORS_ORIGINS)
//   WEBAUTHN_ORIGIN    — Expected origin (default: first CORS origin)
// =============================================================================

const logger = require('../src/config/logger');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

/**
 * Derive Relying Party config from environment.
 */
function getRpConfig() {
    const rpName = process.env.WEBAUTHN_RP_NAME || 'Azaman';

    // Try WEBAUTHN_RP_ID, fall back to parsing CORS_ORIGINS
    let rpId = process.env.WEBAUTHN_RP_ID;
    let expectedOrigin = process.env.WEBAUTHN_ORIGIN;

    if (!rpId || !expectedOrigin) {
        const corsRaw = process.env.CORS_ORIGINS || '*';
        if (corsRaw !== '*') {
            const firstOrigin = corsRaw.split(',')[0].trim();
            try {
                const url = new URL(firstOrigin);
                if (!rpId) rpId = url.hostname;
                if (!expectedOrigin) expectedOrigin = firstOrigin;
            } catch {
                // Not a URL — skip
            }
        }
    }

    // Dev fallback
    if (!rpId) rpId = 'localhost';
    if (!expectedOrigin) expectedOrigin = 'http://localhost:5173';

    return { rpName, rpId, expectedOrigin };
}

/**
 * POST /api/security/webauthn/register/begin
 * Initiates passkey registration. Requires authenticated user.
 */
exports.beginRegistration = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { webAuthnCredentials: true },
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const { rpName, rpId } = getRpConfig();

        // Get existing credential IDs to exclude them (prevent duplicates)
        const existingCredentialIds = user.webAuthnCredentials.map(c => c.id);

        const options = await generateRegistrationOptions({
            rpName,
            rpID: rpId,
            userID: String(user.id),
            userName: user.email,
            userDisplayName: user.username,
            excludeCredentials: existingCredentialIds.map(id => ({ id: id, type: 'public-key' })),
            authenticatorSelection: {
                // Prefer platform authenticators (Face ID / Touch ID) but allow cross-platform (YubiKey)
                authenticatorAttachment: 'platform',
                userVerification: 'preferred',
                residentKey: 'preferred',
            },
            timeout: 60000,
        });

        // Store the challenge temporarily (in-memory — single instance is fine for the challenge,
        // the verification is stateless via the signed challenge)
        req.app.set(`webauthn:challenge:${userId}`, options.challenge);

        // Expire challenge after 5 minutes
        setTimeout(() => {
            req.app.delete(`webauthn:challenge:${userId}`);
        }, 5 * 60 * 1000);

        return res.json({ success: true, options });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: beginRegistration error');
        return res.status(500).json({ success: false, message: 'Failed to start passkey registration' });
    }
};

/**
 * POST /api/security/webauthn/register/finish
 * Verifies the authenticator's response and stores the credential.
 */
exports.finishRegistration = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { credential, name } = req.body;

        if (!credential) {
            return res.status(400).json({ success: false, message: 'Missing credential response' });
        }

        const storedChallenge = req.app.get(`webauthn:challenge:${userId}`);
        if (!storedChallenge) {
            return res.status(400).json({ success: false, message: 'No active registration challenge. Please start again.' });
        }

        const { rpId, expectedOrigin } = getRpConfig();

        const verification = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: storedChallenge,
            expectedOrigin,
            expectedRPID: rpId,
            requireUserVerification: false,
        });

        if (!verification.verified || !verification.registrationInfo) {
            return res.status(400).json({ success: false, message: 'Passkey verification failed' });
        }

        const { credentialID, credentialPublicKey, counter, transports, credentialDeviceType, credentialBackedUp } =
            verification.registrationInfo;

        // Store the credential
        await prisma.webAuthnCredential.create({
            data: {
                id: credentialID,
                userId,
                publicKey: Buffer.from(credentialPublicKey),
                counter,
                transports: transports || [],
                deviceType: credentialDeviceType || null,
                backedUp: credentialBackedUp || false,
                name: name || null,
            },
        });

        // Clean up challenge
        req.app.delete(`webauthn:challenge:${userId}`);

        logger.info({ userId, credentialID }, 'WebAuthn: passkey registered');

        return res.json({
            success: true,
            message: 'Passkey registered successfully',
            credentialId: credentialID,
        });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: finishRegistration error');
        return res.status(500).json({ success: false, message: 'Failed to verify passkey' });
    }
};

/**
 * POST /api/security/webauthn/login/begin
 * Starts a passkey authentication challenge. Does NOT require prior auth
 * (used for passwordless login). Accepts optional email to scope the challenge.
 */
exports.beginLogin = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { email } = req.body;

        let allowCredentials = [];

        if (email) {
            // Scope challenge to user's existing credentials
            const user = await prisma.user.findUnique({
                where: { email },
                include: { webAuthnCredentials: true },
            });

            if (user && user.webAuthnCredentials.length > 0) {
                allowCredentials = user.webAuthnCredentials.map(c => ({
                    id: c.id,
                    type: 'public-key',
                    transports: c.transports,
                }));
            }
        }

        const { rpId } = getRpConfig();

        const options = await generateAuthenticationOptions({
            rpID: rpId,
            allowCredentials,
            userVerification: 'preferred',
            timeout: 60000,
        });

        // Store challenge keyed by a random session token
        const challengeToken = `login:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        req.app.set(`webauthn:challenge:${challengeToken}`, options.challenge);

        setTimeout(() => {
            req.app.delete(`webauthn:challenge:${challengeToken}`);
        }, 5 * 60 * 1000);

        return res.json({ success: true, options, challengeToken });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: beginLogin error');
        return res.status(500).json({ success: false, message: 'Failed to start passkey login' });
    }
};

/**
 * POST /api/security/webauthn/login/finish
 * Verifies the assertion and issues a JWT + refresh token.
 */
exports.finishLogin = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { credential, challengeToken, email } = req.body;

        if (!credential) {
            return res.status(400).json({ success: false, message: 'Missing credential assertion' });
        }

        const storedChallenge = req.app.get(`webauthn:challenge:${challengeToken}`);
        if (!storedChallenge) {
            return res.status(400).json({ success: false, message: 'Challenge expired. Please start again.' });
        }

        // Find the credential by its ID
        const credRecord = await prisma.webAuthnCredential.findUnique({
            where: { id: credential.id },
            include: { user: true },
        });

        if (!credRecord) {
            return res.status(401).json({ success: false, message: 'Unknown passkey' });
        }

        // If email was provided, verify it matches
        if (email && credRecord.user.email !== email) {
            return res.status(401).json({ success: false, message: 'Passkey does not belong to this account' });
        }

        const { rpId, expectedOrigin } = getRpConfig();

        const verification = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: storedChallenge,
            expectedOrigin,
            expectedRPID: rpId,
            authenticator: {
                credentialID: credRecord.id,
                credentialPublicKey: new Uint8Array(credRecord.publicKey),
                counter: credRecord.counter,
                transports: credRecord.transports,
            },
            requireUserVerification: false,
        });

        if (!verification.verified) {
            return res.status(401).json({ success: false, message: 'Passkey verification failed' });
        }

        // Update counter (replay protection)
        await prisma.webAuthnCredential.update({
            where: { id: credRecord.id },
            data: {
                counter: verification.authenticationInfo.newCounter,
                lastUsedAt: new Date(),
            },
        });

        // Clean up challenge
        req.app.delete(`webauthn:challenge:${challengeToken}`);

        // Issue JWT + refresh token (reuse existing auth flow)
        const jwt = require('jsonwebtoken');
        const crypto = require('crypto');
        const token = jwt.sign(
            { id: credRecord.user.id, username: credRecord.user.username, email: credRecord.user.email },
            process.env.JWT_SECRET || process.env.SESSION_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
        );

        const refreshTokenId = crypto.randomUUID();
        await prisma.refreshToken.create({
            data: {
                id: refreshTokenId,
                userId: credRecord.user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                userAgent: req.headers['user-agent'] || null,
                ipAddress: req.ip || null,
            },
        });

        logger.info({ userId: credRecord.user.id, credentialId: credRecord.id }, 'WebAuthn: passkey login successful');

        return res.json({
            success: true,
            message: 'Passkey login successful',
            token,
            refreshToken: refreshTokenId,
            user: {
                id: credRecord.user.id,
                username: credRecord.user.username,
                email: credRecord.user.email,
            },
        });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: finishLogin error');
        return res.status(500).json({ success: false, message: 'Failed to verify passkey login' });
    }
};

/**
 * GET /api/security/webauthn/credentials
 * Lists the authenticated user's registered passkeys.
 */
exports.listCredentials = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const credentials = await prisma.webAuthnCredential.findMany({
            where: { userId: req.user.id },
            select: {
                id: true,
                name: true,
                deviceType: true,
                backedUp: true,
                transports: true,
                createdAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        return res.json({ success: true, credentials });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: listCredentials error');
        return res.status(500).json({ success: false, message: 'Failed to list passkeys' });
    }
};

/**
 * DELETE /api/security/webauthn/credentials/:id
 * Removes a passkey from the user's account.
 */
exports.deleteCredential = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { id } = req.params;

        const credential = await prisma.webAuthnCredential.findUnique({ where: { id } });
        if (!credential) {
            return res.status(404).json({ success: false, message: 'Passkey not found' });
        }

        if (credential.userId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not your passkey' });
        }

        await prisma.webAuthnCredential.delete({ where: { id } });

        logger.info({ userId: req.user.id, credentialId: id }, 'WebAuthn: passkey deleted');

        return res.json({ success: true, message: 'Passkey removed' });
    } catch (err) {
        logger.error({ err: err.message }, 'WebAuthn: deleteCredential error');
        return res.status(500).json({ success: false, message: 'Failed to remove passkey' });
    }
};
