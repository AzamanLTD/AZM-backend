// services/firebase/fcmClient.js
// =============================================================================
// Firebase Cloud Messaging (HTTP v1) WITHOUT firebase-admin.
//
// PROOF OF CONCEPT - isolated branch only. Not wired into production routes.
//
// Replaces getMessaging().send(). Two calls, both explicit:
//   1. sign a JWT assertion with the service-account private key (RS256)
//   2. exchange it at the token endpoint for an OAuth2 access token
//   3. POST the message to projects/{project}/messages:send
//
// The http() dependency is injected so tests never touch the network and the
// production caller cannot accidentally receive a stub.
// =============================================================================

const crypto = require('crypto');

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

class FcmError extends Error {
    constructor(code, message, detail) {
        super(message || code);
        this.name = 'FcmError';
        this.code = code;
        if (detail) this.detail = detail;
    }
}

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertServiceAccount(sa) {
    const missing = ['client_email', 'private_key', 'project_id'].filter((f) => !sa || !sa[f]);
    if (missing.length > 0) {
        // Field NAMES only. The values are credentials and must never surface
        // in a message, a log line or a stack trace.
        throw new FcmError('FCM_CREDENTIAL_INCOMPLETE', 'Service account is missing: ' + missing.join(', '));
    }
    if (!String(sa.private_key).includes('BEGIN PRIVATE KEY')) {
        throw new FcmError('FCM_CREDENTIAL_INCOMPLETE', 'Service account private_key is not a PEM private key.');
    }
}

/**
 * Build the signed JWT assertion Google's token endpoint expects.
 * Exported so the tests can inspect the claims directly.
 */
function buildAssertion(sa, { now = () => Date.now(), ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS } = {}) {
    assertServiceAccount(sa);
    const iat = Math.floor(now() / 1000);
    const claims = {
        iss: sa.client_email,
        scope: SCOPE,
        aud: sa.token_uri || TOKEN_URI,
        iat,
        exp: iat + ttlSeconds,
    };
    const header = { alg: 'RS256', typ: 'JWT' };
    const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
    let signature;
    try {
        signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned, 'utf8'), sa.private_key);
    } catch (err) {
        throw new FcmError('FCM_CREDENTIAL_INCOMPLETE', 'Service account private_key could not sign.');
    }
    return { assertion: unsigned + '.' + base64url(signature), claims };
}

/**
 * Fetch an access token. Cached until 60s before expiry so a burst of pushes
 * does not mint a token per message.
 */
function createTokenProvider({ serviceAccount, http, now = () => Date.now(), skewMs = 60000 }) {
    let token = null;
    let expiresAt = 0;

    return async function getAccessToken() {
        if (token && now() < expiresAt - skewMs) return token;

        const { assertion } = buildAssertion(serviceAccount, { now });
        const res = await http({
            url: serviceAccount.token_uri || TOKEN_URI,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
                + '&assertion=' + encodeURIComponent(assertion),
        });
        if (!res || res.status !== 200 || !res.json || !res.json.access_token) {
            throw new FcmError('FCM_TOKEN_FAILED', 'Token exchange did not return an access token.',
                { status: res && res.status });
        }
        token = res.json.access_token;
        const lifetimeMs = (Number(res.json.expires_in) || DEFAULT_TOKEN_TTL_SECONDS) * 1000;
        expiresAt = now() + lifetimeMs;
        return token;
    };
}

/**
 * Send one notification to one device token.
 *
 * Shape mirrors the existing sendPushNotification call site: title + body +
 * optional data payload.
 */
function createFcmClient({ serviceAccount, http, now = () => Date.now() }) {
    assertServiceAccount(serviceAccount);
    const getAccessToken = createTokenProvider({ serviceAccount, http, now });

    async function send({ token, title, body, data, imageUrl }) {
        if (!token || typeof token !== 'string') {
            throw new FcmError('FCM_NO_TOKEN', 'A device token is required.');
        }
        const accessToken = await getAccessToken();
        const message = {
            message: {
                token,
                notification: { title: title || '', body: body || '' },
                ...(imageUrl ? { notification: { title: title || '', body: body || '', image: imageUrl } } : {}),
                ...(data ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) } : {}),
            },
        };

        const res = await http({
            url: 'https://fcm.googleapis.com/v1/projects/' + serviceAccount.project_id + '/messages:send',
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
        });

        if (res && res.status === 200) {
            return { ok: true, name: (res.json && res.json.name) || null };
        }

        const status = res && res.status;
        const errorCode = res && res.json && res.json.error && res.json.error.status;
        // UNREGISTERED / NOT_FOUND mean the device token is dead. That is a
        // normal lifecycle event the caller must be able to prune on, not a
        // provider outage.
        if (status === 404 || errorCode === 'NOT_FOUND' || errorCode === 'UNREGISTERED') {
            throw new FcmError('FCM_UNREGISTERED', 'Device token is no longer registered.', { status });
        }
        if (status === 401 || status === 403) {
            throw new FcmError('FCM_UNAUTHORIZED', 'Provider rejected the credential.', { status });
        }
        if (status === 429 || (status >= 500 && status < 600)) {
            throw new FcmError('FCM_RETRYABLE', 'Provider is throttling or unavailable.', { status });
        }
        throw new FcmError('FCM_SEND_FAILED', 'Message was not accepted.', { status, errorCode });
    }

    return { send, getAccessToken };
}

module.exports = { createFcmClient, createTokenProvider, buildAssertion, FcmError, SCOPE, TOKEN_URI };
