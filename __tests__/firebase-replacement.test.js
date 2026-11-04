// __tests__/firebase-replacement.test.js
// Proves the two capabilities firebase-admin provides today, without it.
// No service-account credential and no live token is used anywhere here:
// every keypair is generated in-process and every HTTP call is a stub.
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const path = require('path');
const {
    verifyIdToken, createKeyResolver, createDefaultFetcher, maxAgeFromCacheControl,
    normalizeKeySet, EXP_SKEW_SECONDS, IAT_TOLERANCE_SECONDS,
    MAX_TOKEN_LENGTH, MIN_REFRESH_INTERVAL_MS,
} = require('../services/firebase/idTokenVerifier');
const {
    createFcmClient, buildAssertion, classifySendFailure, parseRetryAfter, createHttpTransport,
} = require('../services/firebase/fcmClient');
const {
    parseServiceAccount, resolveServiceAccount, createFailSafeMessaging,
    DEFAULT_CLICK_ACTION, CREDENTIAL_PARSE_ERROR, CREDENTIAL_MISSING,
} = require('../services/firebase/credentials');

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

    test('an unknown kid triggers one bounded refetch, then fails closed', async () => {
        let clock = NOW;
        const fetcher = jest.fn(async () => ({ keys: [jwk] }));
        const resolve = createKeyResolver({ fetcher, now: () => clock });
        // First call populates the cache.
        await expect(resolve('rotated-kid')).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        // Inside the interval the resolver must NOT hit Google again.
        clock += MIN_REFRESH_INTERVAL_MS - 1;
        await expect(resolve('rotated-kid')).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        // Past the interval a real rotation is picked up.
        clock += 2;
        await expect(resolve('rotated-kid')).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('random kids cannot drive one Google request per attempt', async () => {
        let clock = NOW;
        const fetcher = jest.fn(async () => ({ keys: [jwk] }));
        const resolve = createKeyResolver({ fetcher, now: () => clock });
        await resolve(KID); // warm the cache with a real fetch
        const baseline = fetcher.mock.calls.length;
        for (let i = 0; i < 50; i += 1) {
            clock += 10; // 500ms of attacker traffic, well inside the interval
            await expect(resolve('bogus-' + i)).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        }
        expect(fetcher.mock.calls.length).toBe(baseline);
    });

    test('a genuine new RSA keypair signs a token that verifies, and the old key cannot', async () => {
        const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwkNew = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'kid-new', alg: 'RS256', use: 'sig' };
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


describe('JWKS: strict key-set validation', () => {
  const base = () => ({ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' });

  test('accepts a well-formed RS256 signing key', () => {
    expect(normalizeKeySet([base()])).toHaveLength(1);
  });

  test('rejects a key with no kid', () => {
    const k = base(); delete k.kid;
    expect(() => normalizeKeySet([k])).toThrow(/JWKS_MALFORMED_KEY|no usable kid/);
  });

  test('rejects an empty or blank kid', () => {
    expect(() => normalizeKeySet([{ ...base(), kid: '   ' }])).toThrow(/no usable kid/);
  });

  test('rejects a non-RSA key', () => {
    expect(() => normalizeKeySet([{ ...base(), kty: 'EC' }])).toThrow(/not an RSA key/);
  });

  test('rejects a key with no modulus or exponent', () => {
    const noN = base(); delete noN.n;
    expect(() => normalizeKeySet([noN])).toThrow(/no usable modulus or exponent/);
    const noE = base(); delete noE.e;
    expect(() => normalizeKeySet([noE])).toThrow(/no usable modulus or exponent/);
  });

  test('rejects a key published for encryption', () => {
    expect(() => normalizeKeySet([{ ...base(), use: 'enc' }])).toThrow(/not published for signing/);
  });

  test('accepts a key that omits use, as RFC 7517 permits', () => {
    const noUse = base(); delete noUse.use;
    expect(normalizeKeySet([noUse])).toHaveLength(1);
  });

  test('accepts a key whose key_ops permits verification', () => {
    const k = base(); delete k.use;
    expect(normalizeKeySet([{ ...k, key_ops: ['verify'] }])).toHaveLength(1);
    expect(normalizeKeySet([{ ...k, key_ops: ['sign', 'verify'] }])).toHaveLength(1);
  });

  test('rejects key_ops that excludes verification', () => {
    const k = base();
    expect(() => normalizeKeySet([{ ...k, key_ops: ['encrypt'] }])).toThrow(/does not permit signature verification/);
    expect(() => normalizeKeySet([{ ...k, key_ops: [] }])).toThrow(/does not permit signature verification/);
  });

  test('rejects a malformed key_ops', () => {
    const k = base();
    expect(() => normalizeKeySet([{ ...k, key_ops: 'verify' }])).toThrow(/malformed key_ops/);
    expect(() => normalizeKeySet([{ ...k, key_ops: [1] }])).toThrow(/malformed key_ops/);
  });

  test('accepts a key that omits alg', () => {
    const k = base(); delete k.alg;
    expect(normalizeKeySet([k])).toHaveLength(1);
  });

  test('accepts an RS256 key', () => {
    expect(normalizeKeySet([{ ...base(), alg: 'RS256' }])).toHaveLength(1);
  });

  test('rejects duplicate key_ops entries', () => {
    const k = base(); delete k.use;
    expect(() => normalizeKeySet([{ ...k, key_ops: ['verify', 'verify'] }]))
      .toThrow(/duplicate key_ops entries/);
  });

  test('rejects key_ops mixing verification with encryption operations', () => {
    const k = base(); delete k.use;
    for (const op of ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey', 'deriveKey', 'deriveBits']) {
      expect(() => normalizeKeySet([{ ...k, key_ops: ['verify', op] }]))
        .toThrow(/encryption operations/);
    }
    expect(() => normalizeKeySet([{ ...k, use: 'sig', key_ops: ['verify', 'decrypt'] }]))
      .toThrow(/encryption operations/);
  });

  test('rejects contradictory use and key_ops', () => {
    const k = base();
    expect(() => normalizeKeySet([{ ...k, use: 'enc', key_ops: ['verify'] }]))
      .toThrow(/not published for signing/);
    expect(() => normalizeKeySet([{ ...k, use: 'sig', key_ops: ['encrypt'] }]))
      .toThrow(/does not permit signature verification/);
  });

  test('rejects a key whose declared algorithm is not RS256', () => {
    for (const alg of ['RS512', 'HS256', 'ES256', 'none', 'PS256']) {
      expect(() => normalizeKeySet([{ ...base(), alg }])).toThrow(/not an RS256 key/);
    }
  });

  test('rejects an RSA key below 2048 bits', () => {
    const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwkWeak = { ...weak.publicKey.export({ format: 'jwk' }), kid: 'weak', alg: 'RS256', use: 'sig' };
    expect(() => normalizeKeySet([jwkWeak])).toThrow(/modulus below 2048 bits/);
  });

  test('rejects duplicate kids as ambiguous', () => {
    expect(() => normalizeKeySet([base(), base()])).toThrow(/more than one key for kid/);
  });

  test('rejects an empty key set', () => {
    expect(() => normalizeKeySet([])).toThrow(/JWKS_EMPTY|no keys/);
  });

  test('a malformed set fails the resolver closed instead of trusting the good key', () => {
    const resolve = createKeyResolver({
      fetcher: async () => ({ keys: [base(), { ...base(), kid: '', }] }),
      now: nowFn,
    });
    return expect(resolve(KID)).rejects.toMatchObject({ code: 'JWKS_MALFORMED_KEY' });
  });

  test('an ambiguous set fails closed even when the wanted kid is present', async () => {
    const resolve = createKeyResolver({
      fetcher: async () => ({ keys: [base(), base()] }),
      now: nowFn,
    });
    await expect(resolve(KID)).rejects.toMatchObject({ code: 'JWKS_AMBIGUOUS_KEY' });
  });
});

describe('FCM: only the exact FCM error type proves a dead token', () => {
  const TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

  test('bare HTTP 404 is not unregistered', () => {
    expect(classifySendFailure({ status: 404, json: {} }).code).toBe('FCM_NOT_FOUND');
  });

  test('NOT_FOUND with no FCM detail is not unregistered', () => {
    const err = classifySendFailure({ status: 404, json: { error: { status: 'NOT_FOUND', message: 'nope' } } });
    expect(err.code).toBe('FCM_NOT_FOUND');
  });

  test('UNREGISTERED with no @type is not unregistered', () => {
    const err = classifySendFailure({ status: 404, json: { error: { details: [{ errorCode: 'UNREGISTERED' }] } } });
    expect(err.code).toBe('FCM_NOT_FOUND');
    expect(err.fcmErrorCode).toBeNull();
  });

  test('UNREGISTERED with an unrelated @type is not unregistered', () => {
    const err = classifySendFailure({
      status: 404,
      json: { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', errorCode: 'UNREGISTERED' }] } },
    });
    expect(err.code).toBe('FCM_NOT_FOUND');
  });

  test('UNREGISTERED with the exact FCM type is unregistered', () => {
    const err = classifySendFailure({
      status: 404,
      json: { error: { details: [{ '@type': TYPE, errorCode: 'UNREGISTERED' }] } },
    });
    expect(err.code).toBe('FCM_UNREGISTERED');
    expect(err.fcmErrorCode).toBe('UNREGISTERED');
  });

  test('a correctly typed but unrelated FCM code is not unregistered', () => {
    const err = classifySendFailure({
      status: 404,
      json: { error: { details: [{ '@type': TYPE, errorCode: 'SOMETHING_ELSE' }] } },
    });
    expect(err.code).toBe('FCM_NOT_FOUND');
  });
});

describe('FCM: bounded HTTP transport', () => {
  const sa = {
    client_email: 'sender@azaman-app.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: PROJECT,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const stall = () => (_url, { signal }) => new Promise((_res, rej) => {
    signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });

  test('the transport returns a normalized response', async () => {
    const fetchImpl = async () => ({
      status: 200, ok: true,
      headers: { forEach: (cb) => cb('30', 'Retry-After') },
      text: async () => '{"ok":true}',
    });
    const out = await createHttpTransport({ fetchImpl })({ url: 'https://x.invalid' });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    expect(out.headers['retry-after']).toBe('30');
  });

  test('a stalled token exchange aborts within the bound', async () => {
    const client = createFcmClient({ serviceAccount: sa, fetchImpl: stall(), timeoutMs: 25, now: nowFn });
    const started = Date.now();
    await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
      .rejects.toMatchObject({ code: 'FCM_TIMEOUT', retryable: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a stalled send aborts within the bound and does not retry', async () => {
    let calls = 0;
    const fetchImpl = (url, opts) => {
      calls += 1;
      if (String(url).includes('oauth2')) {
        return Promise.resolve({ status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' });
      }
      return stall()(url, opts);
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, timeoutMs: 25, now: nowFn });
    await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
      .rejects.toMatchObject({ code: 'FCM_SEND_OUTCOME_UNKNOWN', deliveryUnknown: true });
    expect(calls).toBe(2); // one exchange, one send attempt, no blind retry
  });

  test('timeout errors carry no request material', async () => {
    const client = createFcmClient({ serviceAccount: sa, fetchImpl: stall(), timeoutMs: 15, now: nowFn });
    const err = await client.send({ token: 'device-secret', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.message).not.toMatch(/device-secret/);
    expect(err.message).not.toMatch(/PRIVATE KEY/);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toMatch(/device-secret/);
  });

  test('concurrent sends share one OAuth token exchange', async () => {
    let exchanges = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes('oauth2')) {
        exchanges += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' };
      }
      return { status: 200, ok: true, headers: { forEach: () => {} }, text: async () => '{"name":"x"}' };
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, now: nowFn });
    await Promise.all([
      client.send({ token: 'a', title: 't', body: 'b' }),
      client.send({ token: 'b', title: 't', body: 'b' }),
      client.send({ token: 'c', title: 't', body: 'b' }),
    ]);
    expect(exchanges).toBe(1);
  });
});


describe('JWKS: Google key-set shape', () => {
  // Two RSA/RS256 keys where the second omits `use` and the first carries
  // key_ops, which is the shape the Secure Token endpoint actually serves.
  // Key material is generated per run, never pinned to a Google key.
  const shape = () => {
    const a = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const b = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      a, b,
      keys: [
        { ...a.publicKey.export({ format: 'jwk' }), kid: 'kid-with-use', alg: 'RS256', use: 'sig' },
        { ...b.publicKey.export({ format: 'jwk' }), kid: 'kid-without-use', alg: 'RS256' },
      ],
    };
  };

  test('accepts a mixed set where one key omits use', () => {
    const { keys } = shape();
    const normalized = normalizeKeySet(keys);
    expect(normalized).toHaveLength(2);
    expect(normalized.map((k) => k.kid)).toEqual(['kid-with-use', 'kid-without-use']);
  });

  test('accepts the same set with key_ops on the key that omits use', () => {
    const { keys } = shape();
    delete keys[0].use;
    keys[0].key_ops = ['verify'];
    expect(normalizeKeySet(keys)).toHaveLength(2);
  });

  test('verifies against the key that omits use', async () => {
    const { b, keys } = shape();
    const resolve = createKeyResolver({ fetcher: async () => ({ keys }), now: nowFn });
    const token = mint({ header: { kid: 'kid-without-use' }, key: b.privateKey });
    const claims = await verifyIdToken(token, { projectId: PROJECT, resolveKey: resolve, now: nowFn });
    expect(claims.sub).toBe('user-123');
  });

  test('the key without use cannot validate the other key signature', async () => {
    const { a, keys } = shape();
    const resolve = createKeyResolver({ fetcher: async () => ({ keys }), now: nowFn });
    const token = mint({ header: { kid: 'kid-without-use' }, key: a.privateKey });
    await expect(verifyIdToken(token, { projectId: PROJECT, resolveKey: resolve, now: nowFn }))
      .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SIGNATURE' });
  });

  test('one contradictory key still fails the whole set', () => {
    const { keys } = shape();
    keys[1].use = 'enc';
    expect(() => normalizeKeySet(keys)).toThrow(/not published for signing/);
  });

  test('one contradictory key_ops still fails the whole set', () => {
    const { keys } = shape();
    keys[1].key_ops = ['encrypt'];
    expect(() => normalizeKeySet(keys)).toThrow(/does not permit signature verification/);
  });

  test('resolver rejects the set rather than trusting the valid half', async () => {
    const { keys } = shape();
    keys[1].use = 'enc';
    const resolve = createKeyResolver({ fetcher: async () => ({ keys }), now: nowFn });
    await expect(resolve('kid-with-use')).rejects.toMatchObject({ code: 'JWKS_MALFORMED_KEY' });
  });
});

describe('FCM: a stalled body read is still a timeout', () => {
  const sa = {
    client_email: 'sender@azaman-app.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: PROJECT,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  // fetch() resolves with headers; only the body read stalls.
  const stallBody = () => (_url, { signal }) => Promise.resolve({
    status: 200,
    ok: true,
    headers: { forEach: () => {} },
    text: () => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    }),
  });

  test('a stalled token body is classified as a timeout, not a transport failure', async () => {
    const client = createFcmClient({ serviceAccount: sa, fetchImpl: stallBody(), timeoutMs: 25, now: nowFn });
    const err = await client.send({ token: 'd', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.code).toBe('FCM_TIMEOUT');
    expect(err.phase).toBe('token');
    expect(err.deliveryUnknown).toBe(false);
    expect(err.retryable).toBe(true);
    expect(err.retryPolicy).toBe('safe');
  });

  test('a stalled send body reports an unknown delivery outcome', async () => {
    let sends = 0;
    const fetchImpl = (url, opts) => {
      if (String(url).includes('oauth2')) {
        return Promise.resolve({ status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' });
      }
      sends += 1;
      return stallBody()(url, opts);
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, timeoutMs: 25, now: nowFn });
    const err = await client.send({ token: 'd', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.code).toBe('FCM_SEND_OUTCOME_UNKNOWN');
    expect(err.phase).toBe('send');
    expect(err.deliveryUnknown).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.retryPolicy).toBe('reconcile-first');
    expect(sends).toBe(1);
  });

  test('a send timeout never produces a second send attempt', async () => {
    let sends = 0;
    const fetchImpl = (url, opts) => {
      if (String(url).includes('oauth2')) {
        return Promise.resolve({ status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' });
      }
      sends += 1;
      return new Promise((_res, rej) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      });
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, timeoutMs: 20, now: nowFn });
    await client.send({ token: 'd', title: 'a', body: 'b' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(sends).toBe(1);
  });

  test('a token exchange timeout stays safely retryable', async () => {
    const client = createFcmClient({ serviceAccount: sa, fetchImpl: stallBody(), timeoutMs: 20, now: nowFn });
    const err = await client.send({ token: 'd', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.deliveryUnknown).toBe(false);
    expect(err.retryPolicy).toBe('safe');
    expect(err.message).not.toMatch(/PRIVATE KEY|device/);
  });
});


describe('JWKS: optional alg never widens the verifier', () => {
  test('the JWT header still has to be RS256 when the key omits alg', async () => {
    const k = { ...jwk }; delete k.alg;
    const resolve = async () => k;
    const header = { alg: 'RS512', kid: KID };
    const token = mint({ header, key: privateKey });
    await expect(verifyIdToken(token, { projectId: PROJECT, resolveKey: resolve, now: nowFn }))
      .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
  });

  test('a key omitting alg still verifies an RS256 token', async () => {
    const k = { ...jwk }; delete k.alg;
    const resolve = async () => k;
    const claims = await verifyIdToken(mint(), { projectId: PROJECT, resolveKey: resolve, now: nowFn });
    expect(claims.sub).toBe('user-123');
  });
});

describe('FCM: a generic body-read failure', () => {
  const sa = {
    client_email: 'sender@azaman-app.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: PROJECT,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const brokenBody = () => () => Promise.resolve({
    status: 200,
    ok: true,
    headers: { forEach: () => {} },
    text: async () => { throw new Error('socket hang up'); },
  });

  test('during token exchange stays a distinct token-phase failure', async () => {
    const client = createFcmClient({ serviceAccount: sa, fetchImpl: brokenBody(), timeoutMs: 50, now: nowFn });
    const err = await client.send({ token: 'd', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.code).toBe('FCM_TRANSPORT_FAILED');
    expect(err.phase).toBe('token');
    expect(err.deliveryUnknown).toBe(false);
    expect(err.retryPolicy).toBe('never');
  });

  test('during a send means the delivery outcome is unknown', async () => {
    let sends = 0;
    const fetchImpl = (url, opts) => {
      if (String(url).includes('oauth2')) {
        return Promise.resolve({ status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' });
      }
      sends += 1;
      return brokenBody()(url, opts);
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, timeoutMs: 50, now: nowFn });
    const err = await client.send({ token: 'd', title: 'a', body: 'b' }).catch((e) => e);
    expect(err.code).toBe('FCM_SEND_OUTCOME_UNKNOWN');
    expect(err.phase).toBe('send');
    expect(err.deliveryUnknown).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.retryPolicy).toBe('reconcile-first');
    expect(sends).toBe(1);
  });

  test('never triggers a second send', async () => {
    let sends = 0;
    const fetchImpl = (url, opts) => {
      if (String(url).includes('oauth2')) {
        return Promise.resolve({ status: 200, ok: true, headers: { forEach: () => {} },
          text: async () => '{"access_token":"t","expires_in":3600}' });
      }
      sends += 1;
      return brokenBody()(url, opts);
    };
    const client = createFcmClient({ serviceAccount: sa, fetchImpl, timeoutMs: 50, now: nowFn });
    await client.send({ token: 'd', title: 'a', body: 'b' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(sends).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Credential resolution: parity with the production Firebase service.
// No real credential exists anywhere in this file; the values below are
// obviously fake and never leave the process.
// ---------------------------------------------------------------------------
describe('credentials — production priority order', () => {
  const fake = { client_email: 'svc@example.test', private_key: 'not-a-real-key', project_id: 'azaman-app' };
  const asJson = JSON.stringify(fake);
  const asB64 = Buffer.from(asJson, 'utf8').toString('base64');

  test('accepts raw JSON from the primary variable', () => {
    const out = resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT: asJson } });
    expect(out.source).toBe('FIREBASE_SERVICE_ACCOUNT');
    expect(out.serviceAccount.project_id).toBe('azaman-app');
  });

  test('accepts base64 from the primary variable', () => {
    const out = resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT: asB64 } });
    expect(out.serviceAccount.client_email).toBe('svc@example.test');
  });

  test('accepts URL-safe base64', () => {
    const urlSafe = asB64.replace(/\+/g, '-').replace(/\//g, '_');
    expect(resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT_BASE64: urlSafe } })
      .serviceAccount.project_id).toBe('azaman-app');
  });

  test('accepts base64 with the padding stripped', () => {
    const unpadded = asB64.replace(/=+$/, '');
    expect(resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT_BASE64: unpadded } })
      .serviceAccount.project_id).toBe('azaman-app');
  });

  test('primary wins over the secondary and the file', () => {
    const other = JSON.stringify({ ...fake, project_id: 'secondary' });
    const out = resolveServiceAccount({
      env: { FIREBASE_SERVICE_ACCOUNT: asJson, FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(other).toString('base64') },
      readFile: () => JSON.stringify({ ...fake, project_id: 'from-file' }),
    });
    expect(out.source).toBe('FIREBASE_SERVICE_ACCOUNT');
    expect(out.serviceAccount.project_id).toBe('azaman-app');
  });

  test('falls back to the secondary variable', () => {
    const out = resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT_BASE64: asB64 } });
    expect(out.source).toBe('FIREBASE_SERVICE_ACCOUNT_BASE64');
  });

  test('falls back to the local file last', () => {
    const out = resolveServiceAccount({ env: {}, readFile: () => asJson });
    expect(out.source).toMatch(/^file:.*service-account\.json$/);
  });

  test('the local credential path is module-relative, not working-directory relative', () => {
    let seen = null;
    resolveServiceAccount({ env: {}, readFile: (p) => { seen = p; return asJson; } });
    // Production resolves utils/../service-account.json, i.e. the repo root.
    // A CWD-relative default would silently read a different file.
    expect(path.isAbsolute(seen)).toBe(true);
    expect(seen.endsWith(path.join('service-account.json'))).toBe(true);
    expect(seen).not.toBe('service-account.json');
  });

  test('an absent local file is treated as no credential, not a crash', () => {
    expect(() => resolveServiceAccount({ env: {} })).toThrow(CREDENTIAL_MISSING);
  });

  test('a missing credential is a distinct error', () => {
    expect(() => resolveServiceAccount({ env: {}, readFile: () => null })).toThrow(CREDENTIAL_MISSING);
  });

  test('a malformed credential never echoes its own content', () => {
    const secretish = 'eyJQUklWQVRFX0tFWSI6ICJzZWNyZXQtbWF0ZXJpYWwi';
    let message = '';
    try { parseServiceAccount(secretish); } catch (err) { message = err.message; }
    expect(message).toBe(CREDENTIAL_PARSE_ERROR);
    expect(message).not.toContain('secret-material');
    expect(message).not.toContain(secretish.slice(0, 12));
  });

  test('a parsed but incomplete credential names only the absent fields', () => {
    expect(() => resolveServiceAccount({ env: { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p' }) } }))
      .toThrow(/FIREBASE_CREDENTIAL_INCOMPLETE: missing client_email, private_key/);
  });
});

describe('credentials — fail-safe start-up', () => {
  test('a missing credential disables messaging without throwing', async () => {
    const warns = [];
    const messaging = createFailSafeMessaging({
      env: {},
      logger: { warn: (...a) => warns.push(a) },
      resolve: () => { throw new Error(CREDENTIAL_MISSING); },
    });
    expect(messaging.configured).toBe(false);
    expect(warns).toHaveLength(1);
    await expect(messaging.sendPush('device-1', 't', 'b')).resolves.toBeNull();
  });

  test('the warning carries no credential material', () => {
    const warns = [];
    createFailSafeMessaging({
      env: {},
      logger: { warn: (...a) => warns.push(a) },
      resolve: () => { throw new Error(CREDENTIAL_MISSING); },
    });
    expect(JSON.stringify(warns)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  test('a resolved credential delegates to the client', async () => {
    const sent = [];
    const messaging = createFailSafeMessaging({
      env: { FIREBASE_SERVICE_ACCOUNT: 'whatever' },
      resolve: () => ({ serviceAccount: { project_id: 'azaman-app' }, source: 'test' }),
      createClient: () => ({ send: async (args) => { sent.push(args); return { ok: true }; } }),
    });
    expect(messaging.configured).toBe(true);
    await expect(messaging.sendPush('device-1', 't', 'b', { a: 1 })).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    await expect(messaging.sendPush('', 't', 'b')).resolves.toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('messaging parity — Flutter click routing and uid alias', () => {
  // Local harness: the FCM suite's stub is scoped to its own describe block.
  const paritySa = {
    client_email: 'sender@azaman-app.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: PROJECT,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const parityHttp = () => jest.fn(async (req) => (
    req.url.includes('oauth2')
      ? { status: 200, json: { access_token: 'stub-token', expires_in: 3600 } }
      : { status: 200, json: { name: 'projects/azaman-app/messages/1' } }
  ));

  test('every push carries the Flutter click action by default', async () => {
    const http = parityHttp();
    const client = createFcmClient({ serviceAccount: paritySa, http, now: nowFn });
    await client.send({ token: 'device-1', title: 'Hi', body: 'There' });
    const payload = JSON.parse(http.mock.calls[1][0].body).message;
    expect(payload.data.click_action).toBe(DEFAULT_CLICK_ACTION);
    expect(payload.data.click_action).toBe('FLUTTER_NOTIFICATION_CLICK');
  });

  test('a caller-supplied click action wins and values stay strings', async () => {
    const http = parityHttp();
    const client = createFcmClient({ serviceAccount: paritySa, http, now: nowFn });
    await client.send({ token: 'd', title: 't', body: 'b', data: { click_action: 'OPEN_TRADE', tradeId: 7, flag: true } });
    const payload = JSON.parse(http.mock.calls[1][0].body).message;
    expect(payload.data.click_action).toBe('OPEN_TRADE');
    expect(payload.data.tradeId).toBe('7');
    expect(payload.data.flag).toBe('true');
  });

  test('verified claims expose uid, which ssoController reads first', async () => {
    const claims = await verify(mint());
    expect(claims.uid).toBe(claims.sub);
    expect(claims.uid).toBe('user-123');
  });
});

// =============================================================================
// Security review additions (2026-11-04). Each of these was a defect found by
// reading the verifier, not by writing a test for behaviour that already worked.
// =============================================================================
describe('verifier hardening — size bounds and error hygiene', () => {
    test('an oversized token is refused before any decoding work', async () => {
        const huge = 'a'.repeat(MAX_TOKEN_LENGTH + 1);
        await expect(verify(huge)).rejects.toMatchObject({ code: 'ID_TOKEN_TOO_LARGE' });
    });

    test('a legal-sized token is still accepted', async () => {
        const out = await verify(mint());
        expect(out.sub).toBe('user-123');
    });

    test('the rejected algorithm is echoed bounded and printable', async () => {
        const hostile = 'X'.repeat(5000) + '\n\r\u0000';
        const token = mint({ header: { alg: hostile } });
        await expect(verify(token)).rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
        await verify(token).catch((err) => {
            expect(err.message.length).toBeLessThan(120);
            expect(err.message).not.toContain('\n');
            expect(err.message).not.toContain('\u0000');
        });
    });
});

describe('resolver — cache lifetime edges', () => {
    test('max-age=0 means every verification refetches', async () => {
        let clock = NOW;
        const fetcher = jest.fn(async () => ({ keys: [jwk], cacheControl: 'max-age=0' }));
        const resolve = createKeyResolver({ fetcher, now: () => clock });
        await resolve(KID);
        clock += 1;
        await resolve(KID);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('a failing refresh leaves the previous keys usable, then fails closed once stale', async () => {
        let clock = NOW;
        let fail = false;
        const fetcher = jest.fn(async () => {
            if (fail) throw new Error('network down');
            return { keys: [jwk], cacheControl: 'max-age=60' };
        });
        const resolve = createKeyResolver({ fetcher, now: () => clock });
        await resolve(KID);
        fail = true;
        clock += 61_000; // stale, refresh will throw
        await expect(resolve(KID)).rejects.toThrow(/network down/);
    });
});
