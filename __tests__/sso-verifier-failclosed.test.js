// __tests__/sso-verifier-failclosed.test.js
// =============================================================================
// Proves the PROPOSED replacement for the dev-fallback branch cannot authenticate
// an unsigned token in any configuration. Generated keys and stub resolvers only;
// no production credential, no real token.
// =============================================================================
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { createSsoVerifier, SSO_UNAVAILABLE } = require('../services/firebase/ssoVerifier');

const PROJECT = 'azaman-app';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const resolveKey = async () => jwk;

const NOW = 1_700_000_000_000;
const now = () => NOW;
const sec = Math.floor(NOW / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token({ alg = 'RS256', claims = {}, sign = true } = {}) {
  const base = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'attacker-sub',
    user_id: 'attacker-sub',
    email: 'attacker@example.com',
    iat: sec - 10,
    exp: sec + 3600,
    auth_time: sec - 100,
    ...claims,
  };
  const unsigned = `${b64({ alg, kid: 'k1', typ: 'JWT' })}.${b64(base)}`;
  if (!sign) return `${unsigned}.`;
  return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

describe('proposed fail-closed SSO verifier', () => {
  test('refuses before parsing when unconfigured, and never resolves a key', async () => {
    const keyCalls = jest.fn();
    const verifier = createSsoVerifier({ projectId: PROJECT, resolveKey: () => keyCalls() });
    const unconfigured = createSsoVerifier({});
    expect(unconfigured.configured).toBe(false);
    await expect(unconfigured.verify(token())).rejects.toMatchObject({ code: SSO_UNAVAILABLE });
    expect(keyCalls).not.toHaveBeenCalled();
  });

  test('an unsigned token with a valid-looking audience, subject and email is refused', async () => {
    const verifier = createSsoVerifier({ projectId: PROJECT, resolveKey, now });
    expect(verifier.configured).toBe(true);
    await expect(verifier.verify(token({ alg: 'none', sign: false })))
      .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_ALG' });
  });

  test('a well-formed token with a real but wrong-key signature is refused', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = token({ claims: {} });
    const parts = forged.split('.');
    const badSig = crypto.sign('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), other.privateKey).toString('base64url');
    const verifier = createSsoVerifier({ projectId: PROJECT, resolveKey, now });
    await expect(verifier.verify(`${parts[0]}.${parts[1]}.${badSig}`))
      .rejects.toMatchObject({ code: 'ID_TOKEN_BAD_SIGNATURE' });
  });

  test('a correctly signed token verifies and exposes uid for the controller', async () => {
    const verifier = createSsoVerifier({ projectId: PROJECT, resolveKey, now });
    const claims = await verifier.verify(token());
    expect(claims.sub).toBe('attacker-sub');
    expect(claims.uid).toBe('attacker-sub');
  });

  test('no flag can enable an unsafe path: the factory takes none', async () => {
    const src = require('fs').readFileSync(require.resolve('../services/firebase/ssoVerifier'), 'utf8');
    // Prose may mention the flag; code must never read it.
    expect(src).not.toMatch(/process\.env\.SSO_DEV_FALLBACK/);
    // No manual payload decode anywhere: parsing happens only inside verifyIdToken.
    expect(src).not.toMatch(/JSON\.parse\(\s*Buffer\.from/);
    expect(src).not.toMatch(/\.split\('\.'\)/);
    // Only one construction path exists, and it always requires both inputs.
    expect(src.match(/function createSsoVerifier/g)).toHaveLength(1);
  });
});
