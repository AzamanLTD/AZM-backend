/**
 * Provider fail-closed, log hygiene, secure generation and OTP race safety.
 *
 * Pinned defects:
 *  - twilio / aws_sns / hubtel adapters answered { success: true } without
 *    sending anything, so a configured-but-unbuilt provider reported a
 *    delivery that never happened.
 *  - _sendViaArkesel logged the full recipient and serialised the provider body.
 *  - _generateOTP used Math.random().
 *  - throttle / attempts / consumption were read-decide-write across separate
 *    round trips, so concurrent requests could exceed limits or double-consume.
 */

const crypto = require('crypto');

process.env.OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-only-otp-digest-secret-32chars';
const logger = require('../src/config/logger');

const PHONE = '+233241234567';

function fresh(overrides = {}) {
  const base = {
    NODE_ENV: 'development',
    SMS_PROVIDER: 'mock',
    REDIS_URL: '',
    OTP_HASH_SECRET: 'test-only-otp-digest-secret-32chars',
    MOOLRE_ENV: '',
    MOOLRE_BASE_URL: '',
    MOOLRE_API_USER: '',
    MOOLRE_VAS_KEY: '',
  };
  Object.assign(process.env, base, overrides);
  jest.resetModules();
  const SMSService = require('../services/smsService');
  return new SMSService();
}

afterEach(() => jest.restoreAllMocks());

describe('placeholder providers fail closed', () => {
  for (const provider of ['twilio', 'aws_sns', 'hubtel']) {
    test(`${provider} refuses instead of pretending to send`, async () => {
      const svc = fresh({ SMS_PROVIDER: provider });
      await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
        code: 'SMS_PROVIDER_UNSUPPORTED',
      });
    });
  }

  test('a placeholder still refuses in production', async () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'hubtel', REDIS_URL: 'redis://localhost:6379' });
    await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_UNSUPPORTED',
    });
  });

  test('an unknown provider name is not silently accepted', async () => {
    const svc = fresh({ SMS_PROVIDER: 'carrier-pigeon' });
    await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_UNSUPPORTED',
    });
  });

  test('mock reports mocked, never delivered', async () => {
    const svc = fresh({ SMS_PROVIDER: 'mock' });
    const res = await svc.sendSMS(PHONE, 'hello');
    expect(res.success).toBe(true);
    expect(res.mocked).toBe(true);
    expect(res.status).toBe('mocked');
    expect(res.status).not.toBe('delivered');
  });
});

describe('moolre production configuration', () => {
  test('refuses when MOOLRE_ENV is not production', async () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre', REDIS_URL: 'redis://x:6379' });
    await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_MISCONFIGURED',
    });
  });

  test('refuses a sandbox base URL in production', async () => {
    const svc = fresh({
      NODE_ENV: 'production', SMS_PROVIDER: 'moolre', REDIS_URL: 'redis://x:6379',
      MOOLRE_ENV: 'production', MOOLRE_BASE_URL: 'https://sandbox.moolre.com',
      MOOLRE_API_USER: 'u', MOOLRE_VAS_KEY: 'k',
    });
    await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_MISCONFIGURED',
    });
  });

  test('refuses when credentials are missing', async () => {
    const svc = fresh({
      NODE_ENV: 'production', SMS_PROVIDER: 'moolre', REDIS_URL: 'redis://x:6379',
      MOOLRE_ENV: 'production', MOOLRE_BASE_URL: 'https://api.moolre.com',
    });
    await expect(svc.sendSMS(PHONE, 'hello')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_MISCONFIGURED',
    });
  });
});

describe('provider log hygiene', () => {
  test('arkesel failure logs neither the recipient nor the payload', async () => {
    const svc = fresh({ SMS_PROVIDER: 'arkesel' });
    const errorSpy = jest.spyOn(require('../src/config/logger'), 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ status: 'error', message: `could not reach ${PHONE} with code 123456` }),
    });

    const res = await svc._sendViaArkesel(PHONE, 'Your Azaman verification code is: 123456', 'AZAMAN');
    expect(res.success).toBe(false);

    const dump = JSON.stringify(errorSpy.mock.calls);
    expect(dump).not.toContain('+233241234567');
    expect(dump).not.toContain('123456');
    expect(dump).not.toContain('status:');
    delete global.fetch;
  });

  test('arkesel success logs a masked number only', async () => {
    const svc = fresh({ SMS_PROVIDER: 'arkesel' });
    const infoSpy = jest.spyOn(require('../src/config/logger'), 'info').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: [{ id: 'm1', cost: 1 }] }),
    });

    await svc._sendViaArkesel(PHONE, 'Your Azaman verification code is: 123456', 'AZAMAN');
    const dump = JSON.stringify(infoSpy.mock.calls);
    expect(dump).not.toContain('+233241234567');
    expect(dump).not.toContain('123456');
    expect(dump).toMatch(/\*\*\*\*/);
    delete global.fetch;
  });
});

describe('secure code generation', () => {
  test('every code is the requested length and digit-only', () => {
    const svc = fresh();
    for (let i = 0; i < 200; i += 1) {
      expect(svc._generateOTP(6)).toMatch(/^\d{6}$/);
    }
    expect(svc._generateOTP(6)).toHaveLength(6);
  });

  test('leading zeros survive', () => {
    const svc = fresh();
    const spy = jest.spyOn(crypto, 'randomInt').mockReturnValue(0);
    expect(svc._generateOTP(6)).toBe('000000');
    spy.mockRestore();
  });

  test('the generator uses crypto, never Math.random', () => {
    const src = require('fs').readFileSync(require.resolve('../services/smsService'), 'utf8');
    const match = src.match(/_generateOTP\(length\)\s*\{([\s\S]*?)\n    \}/);
    expect(match).not.toBeNull();
    // Strip comments: the docblock deliberately NAMES Math.random to explain why
    // it is not used, and that mention must not be read as a call.
    const body = match[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body).toMatch(/crypto\.randomInt/);
    expect(body).not.toMatch(/Math\.random/);
  });
});

describe('race safety', () => {
  test('simultaneous resends reserve exactly one slot', async () => {
    const svc = fresh();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => svc.sendOTP(PHONE))
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && ['OTP_RESEND_TOO_SOON', 'OTP_SEND_LIMIT_EXCEEDED'].includes(r.reason.code)
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(9);
  });

  test('simultaneous wrong codes cannot exceed the attempt budget', async () => {
    const svc = fresh();
    await svc.sendOTP(PHONE);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => svc.verifyOTP(PHONE, '000000'))
    );
    const counted = results.filter((r) => r.attemptsLeft !== undefined);
    expect(counted.length).toBeLessThanOrEqual(2); // 3rd wrong attempt locks
    expect(svc.otpStore.has(PHONE)).toBe(false);
    expect(results.every((r) => r.success === false)).toBe(true);
  });

  test('the same correct code can be consumed only once', async () => {
    const svc = fresh({ OTP_MAX_ATTEMPTS: '3' });
    const sent = await svc.sendOTP(PHONE);
    const code = sent.otp;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.verifyOTP(PHONE, code))
    );
    expect(results.filter((r) => r.success === true)).toHaveLength(1);
    expect(results.filter((r) => r.success === false)).toHaveLength(7);
  });
});

describe('codes are stored as a keyed digest', () => {
  test('the plaintext code never reaches the store', async () => {
    const svc = fresh();
    const sent = await svc.sendOTP(PHONE);
    const rec = svc.otpStore.get(PHONE);
    expect(rec.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rec)).not.toContain(sent.otp);
    await expect(svc.verifyOTP(PHONE, sent.otp)).resolves.toMatchObject({ success: true });
  });

  test('production without a digest secret fails closed', () => {
    const svc = fresh({ NODE_ENV: 'production', OTP_HASH_SECRET: '', REDIS_URL: 'redis://x:6379' });
    expect(() => svc._hashCode(PHONE, '123456')).toThrow(/OTP_HASH_SECRET/);
  });
});
