// __tests__/firebase-replacement.test.js
// Proves the two capabilities firebase-admin provides today, without it.
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { verifyIdToken, createKeyResolver } = require('../services/firebase/idTokenVerifier');
const { createFcmClient, buildAssertion } = require('../services/firebase/fcmClient');

const PROJECT = 'azaman-app';
const KID = 'test-kid-1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const NOW = 1_700_000_000_000;
const nowFn = () => NOW;

function mint({ claims = {}, header = {}, key = privateKey } = {}) {
    const h = { alg: 'RS256', kid: KID, typ: 'JWT', ...header };
    const base = {
        iss: `https://securetoken.google.com/${PROJECT}`,
        aud: PROJECT,
        sub: 'user-123',
        user_id: 'user-123',
        iat: Math.floor(NOW / 1000) - 10,
        exp: Math.floor(NOW / 1000) + 3600,
        auth_time: Math.floor(NOW / 1000) - 10,
        ...claims,
    };
    const unsigned = `${b64(h)}.${b64(base)}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    return `${unsigned}.${sig}`;
}

const resolveKey = async () => jwk;
const verify = (token, opts = {}) => verifyIdToken(token, { projectId: PROJECT, resolveKey, now: nowFn, ...opts });

describe('Firebase ID token verification (replacement)', () => {
    test('accepts a correctly signed token for azaman-app', async () => {
        const claims = await verify(mint());
        expect(claims.sub).toBe('user-123');
        expect(claims.aud).toBe(PROJECT);
    });

    test('refuses alg none', async () => {
        const unsigned = `${b64({ alg: 'none', kid: KID })}.${b64({ aud: PROJECT })}.`;
        await expect(verify(unsigned)).rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
    });

    test('refuses an HS256 token signed with the public key as a secret', async () => {
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

    test('refuses a valid token minted for another Firebase project (audience)', async () => {
        await expect(verify(mint({ claims: { aud: 'someone-else' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_AUDIENCE' });
    });

    test('refuses a token with the wrong issuer', async () => {
        await expect(verify(mint({ claims: { iss: 'https://securetoken.google.com/attacker' } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ISSUER' });
    });

    test('refuses an expired token and honours the clock skew', async () => {
        const past = Math.floor(NOW / 1000) - 61;
        await expect(verify(mint({ claims: { exp: past } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_EXPIRED' });
        // 30s inside the skew window is still accepted.
        const inside = Math.floor(NOW / 1000) - 30;
        await expect(verify(mint({ claims: { exp: inside } }))).resolves.toBeTruthy();
    });

    test('refuses a token issued in the future', async () => {
        await expect(verify(mint({ claims: { iat: Math.floor(NOW / 1000) + 600 } })))
            .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ISSUED_AT' });
    });

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

    test('refuses malformed and unsigned tokens', async () => {
        await expect(verify('not-a-jwt')).rejects.toMatchObject({ code: 'ID_TOKEN_MALFORMED' });
        await expect(verify(`${b64({ alg: 'RS256', kid: KID })}.garbage.sig`))
            .rejects.toMatchObject({ code: 'ID_TOKEN_MALFORMED' });
    });

    test('requires an explicit project id and a key resolver', async () => {
        await expect(verifyIdToken(mint(), { resolveKey }))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_PROJECT' });
        await expect(verifyIdToken(mint(), { projectId: PROJECT }))
            .rejects.toMatchObject({ code: 'ID_TOKEN_NO_KEYS' });
    });
});

describe('JWKS resolution and key rotation', () => {
    test('fetches once and caches across verifications', async () => {
        const fetcher = jest.fn(async () => ({ keys: [jwk] }));
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await resolve(KID);
        await resolve(KID);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('an unknown kid triggers exactly one refetch, then fails closed', async () => {
        const fetcher = jest.fn(async () => ({ keys: [jwk] }));
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        await expect(resolve('rotated-kid')).rejects.toMatchObject({ code: 'ID_TOKEN_UNKNOWN_KEY' });
        expect(fetcher).toHaveBeenCalledTimes(2); // initial + one rotation refetch
    });

    test('a rotated key set is picked up and the new token verifies', async () => {
        const fetcher = jest.fn(async () => ({ keys: [jwk] }))
            .mockResolvedValueOnce({ keys: [jwk] })
            .mockResolvedValue({ keys: [{ ...jwk, kid: 'k2' }] });
        const resolve = createKeyResolver({ fetcher, now: nowFn });
        const newKey = { ...jwk, kid: 'k2' };
        const token = (() => {
            const h = { alg: 'RS256', kid: 'k2', typ: 'JWT' };
            const p = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'u', iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 60 };
            const u = `${b64(h)}.${b64(p)}`;
            return `${u}.${crypto.sign('RSA-SHA256', Buffer.from(u), privateKey).toString('base64url')}`;
        })();
        await expect(verifyIdToken(token, { projectId: PROJECT, resolveKey: resolve, now: nowFn }))
            .resolves.toMatchObject({ sub: 'u' });
        expect(newKey.kid).toBe('k2');
    });

    test('a non-JWKS response fails closed', async () => {
        const resolve = createKeyResolver({ fetcher: async () => ({ nope: true }), now: nowFn });
        await expect(resolve(KID)).rejects.toMatchObject({ code: 'JWKS_UNAVAILABLE' });
    });
});

describe('FCM HTTP v1 (replacement)', () => {
    const sa = {
        client_email: 'sender@azaman-app.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        project_id: PROJECT,
        token_uri: 'https://oauth2.googleapis.com/token',
    };

    function httpStub({ tokenStatus = 200, sendStatus = 200, sendJson = { name: 'projects/azaman-app/messages/1' } } = {}) {
        return jest.fn(async (req) => {
            if (req.url.includes('oauth2')) {
                return tokenStatus === 200
                    ? { status: 200, json: { access_token: 'ya29.stub', expires_in: 3600 } }
                    : { status: tokenStatus, json: {} };
            }
            return { status: sendStatus, json: sendJson };
        });
    }

    test('signs a correct assertion for the service account', () => {
        const { assertion, claims } = buildAssertion(sa, { now: nowFn });
        expect(claims.iss).toBe(sa.client_email);
        expect(claims.aud).toBe(sa.token_uri);
        expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
        const [h, p, s] = assertion.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString()).alg).toBe('RS256');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
        expect(ok).toBe(true);
    });

    test('sends to the project-scoped endpoint with a bearer token', async () => {
        const http = httpStub();
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        const out = await client.send({ token: 'device-1', title: 'Hi', body: 'There', data: { orderId: 42 } });
        expect(out.ok).toBe(true);
        const sendCall = http.mock.calls[1][0];
        expect(sendCall.url).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`);
        expect(sendCall.headers.Authorization).toBe('Bearer ya29.stub');
        const payload = JSON.parse(sendCall.body);
        expect(payload.message.token).toBe('device-1');
        expect(payload.message.data.orderId).toBe('42'); // data is always stringified
    });

    test('reuses the access token across sends', async () => {
        const http = httpStub();
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await client.send({ token: 'd1', title: 'a', body: 'b' });
        await client.send({ token: 'd2', title: 'a', body: 'b' });
        const tokenCalls = http.mock.calls.filter(([r]) => r.url.includes('oauth2'));
        expect(tokenCalls).toHaveLength(1);
    });

    test('classifies dead tokens, auth failures and throttling', async () => {
        const dead = createFcmClient({ serviceAccount: sa, http: httpStub({ sendStatus: 404, sendJson: { error: { status: 'NOT_FOUND' } } }), now: nowFn });
        await expect(dead.send({ token: 'd', title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'FCM_UNREGISTERED' });

        const denied = createFcmClient({ serviceAccount: sa, http: httpStub({ sendStatus: 403, sendJson: {} }), now: nowFn });
        await expect(denied.send({ token: 'd', title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'FCM_UNAUTHORIZED' });

        const throttled = createFcmClient({ serviceAccount: sa, http: httpStub({ sendStatus: 429, sendJson: {} }), now: nowFn });
        await expect(throttled.send({ token: 'd', title: 'a', body: 'b' })).rejects.toMatchObject({ code: 'FCM_RETRYABLE' });
    });

    test('a failed token exchange refuses instead of sending', async () => {
        const http = httpStub({ tokenStatus: 400 });
        const client = createFcmClient({ serviceAccount: sa, http, now: nowFn });
        await expect(client.send({ token: 'd', title: 'a', body: 'b' }))
            .rejects.toMatchObject({ code: 'FCM_TOKEN_FAILED' });
        expect(http.mock.calls).toHaveLength(1); // never reached the send endpoint
    });

    test('refuses an incomplete credential without echoing its values', async () => {
        expect(() => createFcmClient({ serviceAccount: { client_email: 'x' }, http: httpStub(), now: nowFn }))
            .toThrow(/missing: private_key, project_id/);
        try {
            createFcmClient({ serviceAccount: { client_email: 'x' }, http: httpStub(), now: nowFn });
        } catch (err) {
            expect(JSON.stringify(err.message)).not.toContain('BEGIN PRIVATE KEY');
        }
    });
});
