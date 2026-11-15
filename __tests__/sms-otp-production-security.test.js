/**
 * SMS / OTP production security contract.
 *
 * The defects pinned here: a mock provider reporting success in production, OTP
 * codes and full phone numbers in the logs, and an in-process Map silently
 * standing in for a durable store. Every refusal must be a refusal — never a
 * "delivered" the provider never made.
 */

const ENV_KEYS = ['NODE_ENV', 'SMS_PROVIDER', 'REDIS_URL', 'SMS_FORCE_LIVE', 'SMS_API_KEY'];

const loggerCalls = [];
jest.mock('../src/config/logger', () => ({
  info: (...a) => loggerCalls.push(['info', a]),
  warn: (...a) => loggerCalls.push(['warn', a]),
  error: (...a) => loggerCalls.push(['error', a]),
  debug: () => {},
}));

jest.mock('axios', () => ({ post: jest.fn() }));

const PHONE = '+233241234567';

function fresh(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let SMSService;
  jest.isolateModules(() => {
    SMSService = require('../services/smsService');
  });
  return new SMSService();
}

describe('provider configuration fails closed in production', () => {
  test('unset SMS_PROVIDER in production refuses to send (no mock success)', async () => {
    const svc = fresh({ NODE_ENV: 'production' });
    await expect(svc.sendSMS(PHONE, 'Your Azaman verification code is: 123456. Valid 5 minutes.'))
      .rejects.toMatchObject({ code: 'SMS_PROVIDER_MISCONFIGURED' });
  });

  test('explicit SMS_PROVIDER=mock in production also refuses', async () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'mock' });
    await expect(svc.sendSMS(PHONE, 'code 123456')).rejects.toMatchObject({ code: 'SMS_PROVIDER_MISCONFIGURED' });
  });

  test('development mock still works, is identified as mocked, and never claims delivery', async () => {
    const svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    const res = await svc.sendSMS(PHONE, 'Your Azaman verification code is: 123456.');
    expect(res.success).toBe(true);
    expect(res.provider).toBe('mock');
    expect(res.mocked).toBe(true);
    expect(res.status).toBe('mocked');
    expect(res.status).not.toBe('delivered');
  });
});

describe('production OTP storage never degrades to process memory', () => {
  test('sendOTP refuses when no durable store is configured', async () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre' });
    await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
  });

  test('verifyOTP refuses the same way (no Map read)', async () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre' });
    await expect(svc.verifyOTP(PHONE, '123456')).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
  });

  test('nothing was written to the in-process map', () => {
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre' });
    expect(svc.otpStore.size).toBe(0);
  });
});

describe('provider failure never becomes a verifiable code', () => {
  test('a throwing provider leaves no OTP behind', async () => {
    const svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    svc.sendSMS = jest.fn().mockRejectedValue(Object.assign(new Error('provider down'), { code: 'SMS_SEND_FAILED' }));
    await expect(svc.sendOTP(PHONE)).rejects.toThrow(/provider down/);
    const verify = await svc.verifyOTP(PHONE, '000000');
    expect(verify.success).toBe(false);
    expect(verify.message).toMatch(/No OTP found/);
  });

  test('a provider that reports success:false throws and clears the code', async () => {
    const svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    svc.sendSMS = jest.fn().mockResolvedValue({ success: false, message: 'rejected' });
    await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'SMS_SEND_FAILED' });
    expect(svc.otpStore.size).toBe(0);
  });
});

describe('verification ladder', () => {
  let svc;
  let code;

  beforeEach(async () => {
    svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    const sent = await svc.sendOTP(PHONE, 6, 5);
    code = sent.otp;
  });

  test('the right code verifies once and cannot be replayed', async () => {
    expect(code).toMatch(/^\d{6}$/);
    await expect(svc.verifyOTP(PHONE, code)).resolves.toMatchObject({ success: true });
    const replay = await svc.verifyOTP(PHONE, code);
    expect(replay.success).toBe(false);
    expect(replay.message).toMatch(/No OTP found/);
  });

  test('a wrong code consumes an attempt and reports what is left', async () => {
    const bad = await svc.verifyOTP(PHONE, '000000');
    expect(bad.success).toBe(false);
    expect(bad.attemptsLeft).toBe(2);
  });

  test('three wrong codes lock the code out', async () => {
    await svc.verifyOTP(PHONE, '000000');
    await svc.verifyOTP(PHONE, '111111');
    const third = await svc.verifyOTP(PHONE, '222222');
    expect(third.success).toBe(false);
    const after = await svc.verifyOTP(PHONE, code);
    expect(after.success).toBe(false);
    expect(after.message).toMatch(/No OTP found|Maximum verification attempts/);
  });

  test('an expired code is refused and removed', async () => {
    const expired = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    // Deterministic: plant an already-expired entry rather than racing the clock.
    expired.otpStore.set(PHONE, {
      code: '123456',
      expiresAt: new Date(Date.now() - 1000),
      attempts: 0,
      maxAttempts: 3,
    });
    const res = await expired.verifyOTP(PHONE, '123456');
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/expired/);
    expect(expired.otpStore.size).toBe(0);
  });
});

describe('resend abuse is bounded', () => {
  test('a second immediate request is throttled', async () => {
    const svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    await svc.sendOTP(PHONE);
    await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'OTP_RESEND_TOO_SOON' });
  });
});

describe('logs leak neither codes nor full numbers', () => {
  test('no OTP value or complete phone number appears in any log line', async () => {
    loggerCalls.length = 0;
    const svc = fresh({ NODE_ENV: 'development', SMS_PROVIDER: 'mock' });
    const sent = await svc.sendOTP(PHONE);
    const flat = JSON.stringify(loggerCalls);
    expect(flat).not.toContain(sent.otp);
    expect(flat).not.toContain(PHONE);
    expect(flat).not.toContain(PHONE.replace('+', ''));
  });
});
