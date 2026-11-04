// services/firebase/ssoVerifier.js
// =============================================================================
// Fail-closed SSO verifier for the Firebase replacement.
//
// PROOF OF CONCEPT - isolated branch. Not wired into any production route.
//
// This exists because of the weakness in controllers/ssoController.js: when the
// SDK is not initialised it can fall back to DECODING a token without checking
// its signature (SSO_DEV_FALLBACK=1). That fallback is not a weaker check, it is
// authentication bypass: the only thing an attacker must know is the Firebase
// project id, which ships in every client build.
//
// The shape here removes the category of bug rather than guarding it. There is
// exactly one path: verify, or refuse. No decode-only branch exists to be
// mis-gated later, so an unconfigured process cannot authenticate anyone and a
// caller cannot accidentally ask for the unsafe behaviour - there is no flag to
// pass. The controller's replacement for its two current branches is:
//
//   if (!ssoVerifier.configured) return res.status(503).json({ success: false,
//       message: 'SSO unavailable.' });
//   try { decodedToken = await ssoVerifier.verify(idToken); }
//   catch (err) { return res.status(401).json({ success: false,
//       message: 'Invalid or expired ID token.' }); }
//
// 503 is returned in EVERY environment, not just production, so a preview or
// staging deployment cannot become an alternate authentication path.
// =============================================================================

const { verifyIdToken, IdTokenError } = require('./idTokenVerifier');

const UNAVAILABLE = 'SSO_UNAVAILABLE';

function createSsoVerifier({ projectId, resolveKey, now = () => Date.now() } = {}) {
    // Readiness is decided once, from configuration that must both be present.
    // A missing key resolver cannot be satisfied later, so refusing at call time
    // is exactly as safe as refusing at construction and keeps boot fail-safe.
    const configured = typeof projectId === 'string' && projectId.length > 0
        && typeof resolveKey === 'function';

    async function verify(idToken) {
        if (!configured) {
            // Deliberately before any parsing: an unconfigured process never
            // looks at token contents at all.
            throw new IdTokenError(UNAVAILABLE, 'SSO is not configured on this deployment.');
        }
        return verifyIdToken(idToken, { projectId, resolveKey, now });
    }

    return { configured, verify };
}

module.exports = { createSsoVerifier, SSO_UNAVAILABLE: UNAVAILABLE };
