// services/firebase/fcmClient.js
// =============================================================================
// Firebase Cloud Messaging (HTTP v1) WITHOUT firebase-admin.
//
// PROOF OF CONCEPT - isolated branch only. Not wired into any production route.
//
// Replaces getMessaging().send(). The HTTP client is injected so tests never
// touch the network.
//
// ERROR CLASSIFICATION - the important part, and previously wrong here:
// a bare HTTP 404 is NOT proof that a device token is dead. A 404 can mean a
// wrong project, a bad path or a mistyped resource. Only FCM's own structured
// error (`details[].errorCode === 'UNREGISTERED'`) is evidence that the token
// should be revoked. Everything else stays a distinct failure so a caller never
// silently deletes a live device.
//
// NO AUTOMATIC RETRY: a failed send is not proof the message was not delivered.
// FCM can accept a request and fail the response, so retrying blind risks
// double-delivery. Retryable failures surface `retryable` and `retryAfterMs`
// and the caller decides.
// =============================================================================

const crypto = require('crypto');

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
// Imported lazily to keep this module free of a hard dependency cycle: the
// credentials module is the only place that names these constants for callers.
const { DEFAULT_CLICK_ACTION, LOCAL_CREDENTIAL_FILE: _LCF } = require('./credentials');
const DEFAULT_CLICK_ACTION_FIELD = 'click_action';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_HTTP_TIMEOUT_MS = 10000;
const FCM_ERROR_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

class FcmError extends Error {
    constructor(code, message, meta) {
        super(message || code);
        this.name = 'FcmError';
        this.code = code;
        const m = meta || {};
        this.status = m.status;
        this.fcmErrorCode = m.fcmErrorCode || null;
        this.retryable = Boolean(m.retryable);
        this.phase = m.phase || null;
        // A send that died after the request left us may still have been
        // accepted by FCM. Retrying it can deliver the same push twice, so the
        // outcome is recorded explicitly instead of being flattened to
        // "retryable".
        this.deliveryUnknown = Boolean(m.deliveryUnknown);
        this.retryPolicy = m.retryPolicy || 'never';
        this.retryAfterMs = typeof m.retryAfterMs === 'number' ? m.retryAfterMs : null;
    }
}

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertServiceAccount(sa) {
    const missing = ['client_email', 'private_key', 'project_id'].filter((f) => !sa || !sa[f]);
    if (missing.length > 0) {
        throw new FcmError('FCM_CREDENTIAL_INCOMPLETE', 'Service account is missing: ' + missing.join(', '));
    }
    if (!String(sa.private_key).includes('BEGIN PRIVATE KEY')) {
        throw new FcmError('FCM_CREDENTIAL_INCOMPLETE', 'Service account private_key is not a PEM private key.');
    }
}

/** Retry-After is either delta-seconds or an HTTP date. Both become ms. */
function parseRetryAfter(value, now = () => Date.now()) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    return Math.max(0, when - now());
}

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
 * The only place an error body is interpreted. Structured `errorCode` values
 * are the evidence; HTTP status alone is not.
 */
function classifySendFailure(res, { expectedProjectId, now = () => Date.now() } = {}) {
    const status = res && res.status;
    const err = (res && res.json && res.json.error) || {};
    const details = Array.isArray(err.details) ? err.details : [];
    // The @type must match exactly. A 404 carrying errorCode UNREGISTERED under
    // some other (or no) @type is not evidence from FCM's own error contract, so
    // it must never justify revoking a device token.
    const fcmDetail = details.find(
        (d) => d && d['@type'] === FCM_ERROR_TYPE && typeof d.errorCode === 'string',
    );
    const fcmCode = fcmDetail ? fcmDetail.errorCode : null;
    const retryAfterMs = parseRetryAfter(res && res.headers && res.headers['retry-after'], now);

    // Confirmed dead token: FCM itself said the registration is gone.
    if (fcmCode === 'UNREGISTERED') {
        return new FcmError('FCM_UNREGISTERED', 'Device token is no longer registered.',
            { status, fcmErrorCode: fcmCode });
    }
    // Wrong project / credential-project mismatch. Configuration, not a device.
    if (fcmCode === 'SENDER_ID_MISMATCH') {
        return new FcmError('FCM_PROJECT_MISMATCH',
            'Message targeted a project this credential cannot send for.',
            { status, fcmErrorCode: fcmCode });
    }
    if (fcmCode === 'THIRD_PARTY_AUTH_ERROR') {
        return new FcmError('FCM_THIRD_PARTY_AUTH', 'Provider rejected APNs or web-push credentials.',
            { status, fcmErrorCode: fcmCode });
    }
    if (fcmCode === 'INVALID_ARGUMENT') {
        return new FcmError('FCM_INVALID_ARGUMENT', 'Message was rejected as malformed.',
            { status, fcmErrorCode: fcmCode });
    }
    if (fcmCode === 'QUOTA_EXCEEDED' || fcmCode === 'UNAVAILABLE' || fcmCode === 'INTERNAL') {
        return new FcmError('FCM_RETRYABLE', 'Provider is throttling or unavailable.',
            { status, fcmErrorCode: fcmCode, retryable: true, retryAfterMs });
    }

    // No FCM detail. Status alone decides, and 404 stays "not found", never
    // "unregistered": the device may be perfectly alive.
    if (status === 404) {
        return new FcmError('FCM_NOT_FOUND', 'Send endpoint or resource not found.',
            { status, fcmErrorCode: fcmCode });
    }
    if (status === 429) {
        return new FcmError('FCM_RETRYABLE', 'Provider is throttling.',
            { status, retryable: true, retryAfterMs });
    }
    if (status >= 500 && status < 600) {
        return new FcmError('FCM_RETRYABLE', 'Provider is unavailable.',
            { status, retryable: true, retryAfterMs });
    }
    if (status === 401 || status === 403) {
        return new FcmError('FCM_UNAUTHORIZED', 'Provider rejected the credential.',
            { status, fcmErrorCode: fcmCode });
    }
    return new FcmError('FCM_SEND_FAILED', 'Message was not accepted.',
        { status, fcmErrorCode: fcmCode });
}

/**
 * Concrete HTTP transport with an enforced abort. Passing timeoutMs through to
 * an injected stub proves nothing; this is what actually bounds the call. It
 * covers both the OAuth token exchange and the FCM send because both go
 * through it. Errors are typed and never carry the request body, the assertion
 * or the access token.
 */
function createHttpTransport({ fetchImpl = global.fetch, defaultTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
    return async function http(req) {
        if (typeof fetchImpl !== 'function') {
            throw new FcmError('FCM_TRANSPORT_UNAVAILABLE', 'No HTTP client is available.');
        }
        const timeoutMs = typeof req.timeoutMs === 'number' ? req.timeoutMs : defaultTimeoutMs;
        const phase = req.phase === 'send' ? 'send' : 'token';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // A send that timed out may have been accepted by FCM before the
        // response was lost; the exchange has no such ambiguity.
        const timeoutError = () => (phase === 'send'
            ? new FcmError('FCM_SEND_OUTCOME_UNKNOWN',
                'Send exceeded ' + timeoutMs + 'ms; FCM may have accepted the message.',
                { phase, retryable: false, deliveryUnknown: true, retryPolicy: 'reconcile-first' })
            : new FcmError('FCM_TIMEOUT', 'Token exchange exceeded ' + timeoutMs + 'ms.',
                { phase, retryable: true, deliveryUnknown: false, retryPolicy: 'safe' }));
        try {
            const res = await fetchImpl(req.url, {
                method: req.method || 'GET',
                headers: req.headers,
                body: req.body,
                signal: controller.signal,
            });
            let text = '';
            try {
                text = await res.text();
            } catch (err) {
                // The body read can be what stalls, and it aborts on the same
                // signal. Classify it by phase rather than as a generic
                // transport failure, otherwise a timeout is reported as
                // something that never timed out.
                if (controller.signal.aborted || (err && err.name === 'AbortError')) throw timeoutError();
                // The request was already delivered when a body read fails, so a
                // send cannot be reported as a plain transport failure: FCM may
                // well have accepted the message.
                if (phase === 'send') {
                    throw new FcmError('FCM_SEND_OUTCOME_UNKNOWN',
                        'Response body could not be read after the send; FCM may have accepted the message.',
                        { status: res && res.status, phase, retryable: false, deliveryUnknown: true,
                          retryPolicy: 'reconcile-first' });
                }
                throw new FcmError('FCM_TRANSPORT_FAILED', 'Token response body could not be read.',
                    { status: res && res.status, phase, retryable: false, deliveryUnknown: false,
                      retryPolicy: 'never' });
            }
            let json = null;
            if (text) {
                try { json = JSON.parse(text); } catch (err) { json = null; }
            }
            const headers = {};
            if (res.headers && typeof res.headers.forEach === 'function') {
                res.headers.forEach((value, name) => { headers[String(name).toLowerCase()] = value; });
            }
            return { status: res.status, ok: res.ok !== false, headers, json };
        } catch (err) {
            if (err instanceof FcmError) throw err;
            if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
                throw timeoutError();
            }
            throw new FcmError('FCM_TRANSPORT_FAILED', 'Request failed before a response was received.',
                phase === 'send'
                    ? { phase, retryable: false, deliveryUnknown: true, retryPolicy: 'reconcile-first' }
                    : { phase, retryable: true, retryPolicy: 'safe' });
        } finally {
            clearTimeout(timer);
        }
    };
}

function createTokenProvider({ serviceAccount, http, now = () => Date.now(), skewMs = 60000, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }) {
    let token = null;
    let expiresAt = 0;
    let inFlight = null;

    // Simultaneous sends share one exchange. Without this, a burst of pushes
    // would each mint its own OAuth token for the same service account.
    return async function getAccessToken() {
        if (token && now() < expiresAt - skewMs) return token;
        if (inFlight) return inFlight;
        inFlight = exchange();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    };

    async function exchange() {
        const { assertion } = buildAssertion(serviceAccount, { now });
        const res = await http({
            url: serviceAccount.token_uri || TOKEN_URI,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
                + '&assertion=' + encodeURIComponent(assertion),
            timeoutMs,
            phase: 'token',
        });
        if (!res || res.status !== 200 || !res.json || !res.json.access_token) {
            throw new FcmError('FCM_TOKEN_FAILED', 'Token exchange did not return an access token.',
                { status: res && res.status });
        }
        token = res.json.access_token;
        const lifetimeMs = (Number(res.json.expires_in) || DEFAULT_TOKEN_TTL_SECONDS) * 1000;
        expiresAt = now() + lifetimeMs;
        return token;
    }
}

function createFcmClient({ serviceAccount, http, fetchImpl, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, now = () => Date.now() }) {
    assertServiceAccount(serviceAccount);
    const projectId = serviceAccount.project_id;
    // Default to a transport that actually aborts; an injected `http` is used
    // as-is so tests stay network-free.
    const transport = http || createHttpTransport({ fetchImpl, defaultTimeoutMs: timeoutMs });
    const getAccessToken = createTokenProvider({ serviceAccount, http: transport, now, timeoutMs });

    async function send({ token, title, body, data, imageUrl }) {
        if (!token || typeof token !== 'string') {
            throw new FcmError('FCM_NO_TOKEN', 'A device token is required.');
        }
        const accessToken = await getAccessToken();
        const notification = { title: title || '', body: body || '' };
        if (imageUrl) notification.image = imageUrl;

        // Production seeds this default inside its string-normalising reduce
        // (utils/firebaseService.js), so every push the Flutter app receives
        // carries it and its click routing depends on it. A caller-supplied
        // value wins, which is the behaviour the reduce also produced.
        const payloadData = { [DEFAULT_CLICK_ACTION_FIELD]: DEFAULT_CLICK_ACTION, ...(data || {}) };

        const message = {
            message: {
                token,
                notification,
                data: Object.fromEntries(Object.entries(payloadData).map(([k, v]) => [k, String(v)])),
            },
        };

        const res = await transport({
            url: 'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send',
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
            timeoutMs,
            phase: 'send',
        });

        if (res && res.status === 200) {
            return { ok: true, name: (res.json && res.json.name) || null };
        }
        throw classifySendFailure(res, { expectedProjectId: projectId, now });
    }

    return { send, getAccessToken };
}

module.exports = {
    createFcmClient,
    createHttpTransport,
    createTokenProvider,
    buildAssertion,
    classifySendFailure,
    parseRetryAfter,
    FcmError,
    SCOPE,
    TOKEN_URI,
};
