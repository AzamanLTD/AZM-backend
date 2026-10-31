// __tests__/firebase-replacement.test.js
// Proves the two capabilities firebase-admin provides today, without it.
// No service-account credential and no live token is used anywhere here:
// every keypair is generated in-process and every HTTP call is a stub.
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const {
    verifyIdToken, createKeyResolver, createDefaultFetcher, maxAgeFromCacheControl,
    EXP_SKEW_SECONDS, IAT_TOLERANCE_SECONDS,
} = require('../services/firebase/idTokenVerifier');
const {
    createFcmClient, buildAssertion, classifySendFailure, parseRetryAfter,
} = require('../services/firebase/fcmClient');

const PROJECT = 'azaman-app';
const KID = 'test-kid-1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const NOW = 1_700_000_000_000;
const nowFn = () => NOW;
const SEC = Math.floor(NOW / 1000);

function mint({ claims = {}, header = {}, key = privateKey, drop = [] } = {}) {
    const h = { alg: 'RS256', kid: KID, typ: 'JWT', ...header };
    const base = {
        iss: `https://securetoken.google.com/${PROJECT}`,
        aud: PROJECT,
        sub: 'user-123',
        user_id: 'user-123',
        iat: SEC - 10,
        exp: SEC + 3600,
        auth_time: SEC - 60,
        ...claims,
    };
    for (const field of drop) delete base[field];
    const unsigned = `${b64(h)}.${b64(base)}`;
    return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

const resolveKey = async () => jwk;
const verify = (token, opts = {}) => verifyIdToken(token, { projectId: PROJECT, resolveKey, now: nowFn, ...opts });

describe('ID token: signature and algorithm', () => {
    test('accepts a correctly signed token for azaman-app', async () => {
        const claims = await verify(mint());
        expect(claims.sub).toBe('user-123');
        expect(claims.aud).toBe(PROJECT);
    });

    test('refuses alg none', async () => {
        await expect(verify(`${b64({ alg: 'none', kid: KID })}.${b64({ aud: PROJECT })}.`))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
    });

    test('refuses HS256 signed with the public key as an HMAC secret', async () => {
        const h = b64({ alg: 'HS256', kid: KID });
        const p = b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'x', iat: 1, exp: 2 });
        const sig = crypto.createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' }))
            .update(`${h}.${p}`).digest('base64url');
        await expect(verify(`${h}.${p}.${sig}`)).rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
    });

    test('refuses a token signed by a different key under the same kid', async () => {
        await expect(verify(mint({ key: other.privateKey })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SIGNATURE' });
    });

    test('refuses malformed and unsigned tokens', async () => {
        await expect(verify('not-a-jwt')).rejects.toMatchObject({ code: 'ID_TOKEN_MALFORMED' });
        await expect(verify(`${b64({ alg: 'RS256', kid: KID })}.garbage.sig`))
            .rejects.toMatchObject({ code: 'ID_TOKEN_MALFORMED' });
    });
});

describe('ID token: project binding', () => {
    test('refuses a validly signed token for another project (audience)', async () => {
        await expect(verify(mint({ claims: { aud: 'someone-else' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_AUDIENCE' });
    });

    test('refuses a token with the wrong issuer', async () => {
        await expect(verify(mint({ claims: { iss: 'https://securetoken.google.com/attacker' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ISSUER' });
    });

    test('requires an explicit project id and a key resolver', async () => {
        await expect(verifyIdToken(mint(), { resolveKey }))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_PROJECT' });
        await expect(verifyIdToken(mint(), { projectId: PROJECT }))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_KEYS' });
    });
});

describe('ID token: time claims and skew parity', () => {
    test('expiry tolerance matches firebase-admin exactly: zero skew', () => {
        // firebase-admin 14.3.0 delegates to jsonwebtoken with no options, and
        // jsonwebtoken's default clockTolerance is 0. Verified in the installed
        // library, so this constant must stay 0 for parity.
        expect(EXP_SKEW_SECONDS).toBe(0);
    });

    test('a token that expired one second ago is refused', async () => {
        await expect(verify(mint({ claims: { exp: SEC - 1 } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_EXPIRED' });
    });

    test('a token expiring in the future is accepted', async () => {
        await expect(verify(mint({ claims: { exp: SEC + 1 } }))).resolves.toBeTruthy();
    });

    test('iat is our own guard, so it keeps a tolerance firebase-admin does not have', () => {
        expect(IAT_TOLERANCE_SECONDS).toBeGreaterThan(0);
    });

    test('rejects iat beyond the tolerance, accepts inside it', async () => {
        await expect(verify(mint({ claims: { iat: SEC + IAT_TOLERANCE_SECONDS + 1 } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ISSUED_AT' });
        await expect(verify(mint({ claims: { iat: SEC + IAT_TOLERANCE_SECONDS - 1 } }))).resolves.toBeTruthy();
    });

    test('auth_time is required', async () => {
        await expect(verify(mint({ drop: ['auth_time'] })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_AUTH_TIME' });
    });

    test('auth_time must be a number', async () => {
        await expect(verify(mint({ claims: { auth_time: String(SEC - 60) } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_AUTH_TIME' });
    });

    test('auth_time in the future is refused', async () => {
        await expect(verify(mint({ claims: { auth_time: SEC + 600 } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_AUTH_TIME_FUTURE' });
        await expect(verify(mint({ claims: { auth_time: SEC + IAT_TOLERANCE_SECONDS + 1 } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_AUTH_TIME_FUTURE' });
    });

    test('auth_time in the past is accepted', async () => {
        await expect(verify(mint({ claims: { auth_time: SEC - 86400 } }))).resolves.toBeTruthy();
    });
});

describe('ID token: subject claims', () => {
    test('refuses a missing or oversized subject', async () => {
        await expect(verify(mint({ claims: { sub: '', user_id: '' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SUBJECT' });
        await expect(verify(mint({ claims: { sub: 'a'.repeat(129), user_id: 'a'.repeat(129) } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SUBJECT' });
    });

    test('refuses sub and user_id disagreement', async () => {
        await expect(verify(mint({ claims: { user_id: 'someone-else' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_SUBJECT_MISMATCH' });
    });
});

describe('JWKS: cache lifetime, dedupe and rotation', () => {
    test('parses max-age and treats no-store as uncacheable', () => {
        expect(maxAgeFromCacheControl('public, max-age=60')).toBe(60000);
        expect(maxAgeFromCacheControl('max-age=0')).toBe(0);
        expect(maxAgeFromCacheControl('no-store')).toBeNull();
        expect(maxAgeFromCacheControl('no-cache, max-age=600')).toBeNull();
        expect(maxAgeFromCacheControl(undefined)).toBeUndefined();
    });

    test('parses the header Google actually sends today', () => {
        // Captured from the live securetoken endpoint (no credential needed; it
        // is a public key set). must-revalidate must not look like no-cache.
        const real = 'public, max-age=22152, must-revalidate, no-transform';
        expect(maxAgeFromCacheControl(real)).toBe(22_152_000);
        expect(maxAgeFromCacheControl(real)).toBeGreaterThan(60 * 60 * 1000);
    });

    test('honours Cache-Control max-age instead of assuming an hour', async () => {
        let clock = NOW;
        let calls = 0;
        const fetcher = async () => { calls += 1; return { keys: [jwk], cacheControl: 'public, max-age=60' }; };
        const resolve = createKeyResolver({ fetcher, now: () => clock });

        await resolve(KID);
        await resolve(KID);
        expect(calls).toBe(1); // still within 60s

        clock += 61_000;
        await resolve(KID);
        expect(calls).toBe(2); // expired by max-age, refetched
    });

    test('refetches every call when the response says no-store', async () => {
        let calls = 0;
        const fetcher = async () => { calls += 1; return { keys: [jwk], cacheControl: 'no-store' }; };
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await resolve(KID);
        await resolve(KID);
        expect(calls).toBe(2);
    });

    test('falls back to the 1h ttl when Cache-Control is absent', async () => {
        let calls = 0;
        const fetcher = async () => { calls += 1; return { keys: [jwk] }; };
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await resolve(KID);
        await resolve(KID);
        expect(calls).toBe(1);
    });

    test('concurrent verifications share one in-flight fetch', async () => {
        let calls = 0;
        const fetcher = async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 10));
            return { keys: [jwk] };
        };
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await Promise.all([resolve(KID), resolve(KID), resolve(KID), resolve(KID)]);
        expect(calls).toBe(1);
    });

    test('an unknown kid triggers exactly one refetch, then fails closed', async () => {
        const fetcher = jest.fn(async () => ({ keys: [jwk] }));
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await expect(resolve('rotated-kid')).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('a genuine new RSA keypair signs a token that verifies, and the old key cannot', async () => {
        const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwkNew = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'kid-new', alg: 'RS256' };
        const fetcher = async () => ({ keys: [jwk, jwkNew] });
        const resolve = createKeyResolver({ fetcher, now: nowFn });

        // Signed by the NEW private key, header names the NEW kid: accepted.
        const fresh = mint({ header: { kid: 'kid-new' }, key: rotated.privateKey });
        await expect(verifyIdToken(fresh, { projectId: PROJECT, resolveKey: resolve, now: nowFn }))
            .resolves.toMatchObject({ sub: 'user-123' });

        // Same header (kid-new) but signed by the OLD key: rejected. This is what
        // proves the new key is genuinely the one being verified against.
        const forged = mint({ header: { kid: 'kid-new' }, key: privateKey });
        await expect(verifyIdToken(forged, { projectId: PROJECT, resolveKey: resolve, now: nowFn }))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SIGNATURE' });
    });

    test('a non-JWKS response fails closed', async () => {
        const resolve = createKeyResolver({ fetcher: async () => ({ nope: true }), now: nowFn });
        await expect(resolve(KID)).rejects.toMatchObject({ code: 'JWKS_UNAVAILABLE' });
    });

    test('the HTTP fetcher times out instead of hanging a login', async () => {
        const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        });
        const fetcher = createDefaultFetcher({ fetchImpl, timeoutMs: 20 });
        await expect(fetcher('https://example.invalid/jwks')).rejects.toMatchObject({ code: 'JWKS_TIMEOUT' });
    });

    test('the HTTP fetcher surfaces Cache-Control from the response', async () => {
        const fetchImpl = async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => (h === 'cache-control' ? 'public, max-age=31240' : null) },
            json: async () => ({ keys: [jwk] }),
        });
        const out = await createDefaultFetcher({ fetchImpl })('https://example.invalid/jwks');
        expect(out.cacheControl).toBe('public, max-age=31240');
        expect(maxAgeFromCacheControl(out.cacheControl)).toBe(31240000);
    });
});

describe('FCM classification', () => {
    const withDetail = (status, errorCode, extra = {}) => ({
        status,
        json: { error: { code: status, status: 'X', details: [
            { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode },
        ] } },
        ...extra,
    });

    test('a bare 404 is NOT an unregistered device', () => {
        const err = classifySendFailure({ status: 404, json: { error: { status: 'NOT_FOUND' } } });
        expect(err.code).toBe('FCM_NOT_FOUND');
        expect(err.code).not.toBe('FCM_UNREGISTERED');
    });

    test('generic NOT_FOUND without an FCM error code stays not-found', () => {
        const err = classifySendFailure({ status: 404, json: { error: { status: 'NOT_FOUND', details: [{ '@type': 'other' }] } } });
        expect(err.code).toBe('FCM_NOT_FOUND');
    });

    test('a confirmed FCM UNREGISTERED is a dead token', () => {
        expect(classifySendFailure(withDetail(404, 'UNREGISTERED')).code).toBe('FCM_UNREGISTERED');
    });

    test('a wrong-project credential is a configuration error', () => {
        expect(classifySendFailure(withDetail(403, 'SENDER_ID_MISMATCH')).code).toBe('FCM_PROJECT_MISMATCH');
        expect(classifySendFailure(withDetail(403, 'THIRD_PARTY_AUTH_ERROR')).code).toBe('FCM_THIRD_PARTY_AUTH');
    });

    test('a malformed message is not retryable', () => {
        const err = classifySendFailure(withDetail(400, 'INVALID_ARGUMENT'));
        expect(err.code).toBe('FCM_INVALID_ARGUMENT');
        expect(err.retryable).toBe(false);
    });

    test('429 and 5xx are retryable and carry Retry-After', () => {
        const throttled = classifySendFailure({ status: 429, json: {}, headers: { 'retry-after': '30' } });
        expect(throttled.code).toBe('FCM_RETRYABLE');
        expect(throttled.retryable).toBe(true);
        expect(throttled.retryAfterMs).toBe(30000);

        const down = classifySendFailure({ status: 503, json: {} });
        expect(down.retryable).toBe(true);
        expect(down.retryAfterMs).toBeNull();

        const quota = classifySendFailure(withDetail(429, 'QUOTA_EXCEEDED', { headers: { 'retry-after': '5' } }));
        expect(quota.retryable).toBe(true);
        expect(quota.retryAfterMs).toBe(5000);
    });

    test('Retry-After also accepts an HTTP date', () => {
        const inThirty = new Date(NOW + 30_000).toUTCString();
        expect(parseRetryAfter(inThirty, nowFn)).toBe(30000);
        expect(parseRetryAfter('not-a-date', nowFn)).toBeNull();
        expect(parseRetryAfter(undefined, nowFn)).toBeNull();
    });
});

describe('FCM send', () => {
    const sa = {
        client_email: 'sender@azaman-app.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        project_id: PROJECT,
        token_uri: 'https://oauth2.googleapis.com/token',
    };

    function httpStub({ tokenStatus = 200, sendResponse = { status: 200, json: { name: 'projects/azaman-app/messages/1' } } } = {}) {
        return jest.fn(async (req) => {
            if (req.url.includes('oauth2')) {
                return tokenStatus === 200
                    ? { status: 200, json: { access_token: 'stub-token', expires_in: 3600 } }
                    : { status: tokenStatus, json: {} };
            }
            return sendResponse;
        });
    }

    test('signs a correct assertion for the service account', () => {
        const { assertion, claims } = buildAssertion(sa, { now: nowFn });
        expect(claims.iss).toBe(sa.client_email);
        expect(claims.aud).toBe(sa.token_uri);
        expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
        const [h, p, s] = assertion.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString()).alg).toBe('RS256');
        expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    });

    test('sends to the project-scoped endpoint with a bearer token', async () => {
        const http = httpStub();
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        const out = await client.send({ token: 'device-1', title: 'Hi', body: 'There', data: { orderId: 42 } });
        expect(out.ok).toBe(true);
        const sendCall = http.mock.calls[1][0];
        expect(sendCall.url).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`);
        expect(sendCall.headers.Authorization).toBe('Bearer stub-token');
        expect(JSON.parse(sendCall.body).message.data.orderId).toBe('42');
    });

    test('reuses the access token across sends', async () => {
        const http = httpStub();
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await client.send({ token: 'd1', title: 'a', body: 'b' });
        await client.send({ token: 'd2', title: 'a', body: 'b' });
        expect(http.mock.calls.filter(([r]) => r.url.includes('oauth2'))).toHaveLength(1);
    });

    test('does not retry a transient failure on its own', async () => {
        const http = httpStub({ sendResponse: { status: 503, json: {} } });
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
            .rejects.toMatchObject({ code: 'FCM_RETRYABLE', retryable: true });
        // token exchange + exactly one send attempt: no silent duplicate risk.
        expect(http.mock.calls).toHaveLength(2);
    });

    test('a generic 404 send failure is not treated as a dead token', async () => {
        const http = httpStub({ sendResponse: { status: 404, json: { error: { status: 'NOT_FOUND' } } } });
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
            .rejects.toMatchObject({ code: 'FCM_NOT_FOUND' });
    });

    test('a real UNREGISTERED response is surfaced as a dead token', async () => {
        const http = httpStub({
            sendResponse: {
                status: 404,
                json: { error: { status: 'NOT_FOUND', details: [
                    { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' },
                ] } },
            },
        });
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
            .rejects.toMatchObject({ code: 'FCM_UNREGISTERED', fcmErrorCode: 'UNREGISTERED' });
    });

    test('a failed token exchange refuses instead of sending', async () => {
        const http = httpStub({ tokenStatus: 400 });
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
            .rejects.toMatchObject({ code: 'FCM_TOKEN_FAILED' });
        expect(http.mock.calls).toHaveLength(1);
    });

    test('an incomplete credential is refused without echoing values', async () => {
        expect(() => createFcmClient({ serviceAccount: { client_email: 'x' }, http: httpStub(), now: nowFn }))
            .toThrow(/missing: private_key, project_id/);
    });
});
