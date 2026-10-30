// __tests__/app-unlock-contract.test.js
// =============================================================================
// Member app unlock — server-managed factors.
//
// The failure modes this pins down are the ones that would make a privacy lock
// decorative or dangerous:
//   * a correct PIN must not mint a session;
//   * parallel wrong PINs must not exceed the attempt budget;
//   * unlocking must never rewrite TOTP enrolment or phone identity;
//   * a phone-verification OTP must be useless as an unlock code, and vice versa;
//   * one member must not consume another member's challenge;
//   * a provider failure must not leave a verifiable code behind;
//   * capabilities must never advertise a mocked provider as usable.
// =============================================================================

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const { AppUnlockService } = require('../services/appUnlockService');

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../src/config/logger');

const PHONE = '+233241234567';
const OTHER_PHONE = '+233209999999';

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    phoneNumber: PHONE,
    phoneVerified: true,
    pinHash: null,
    isTwoFactorEnabled: false,
    twoFactorSecret: null,
    ...overrides,
  };
}

function makePrisma(user) {
  return {
    user: {
      findUnique: jest.fn(async () => user),
      update: jest.fn(async ({ data }) => ({ ...user, ...data })),
    },
  };
}

/** A real SMS service in development/mock mode: delivery is simulated. */
function freshSms(env = {}) {
  jest.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'development', SMS_PROVIDER: 'mock' }, env);
  const SMSService = require('../services/smsService');
  const svc = new SMSService();
  process.env = saved;
  return svc;
}

function build(userOverrides = {}, sms) {
  const user = makeUser(userOverrides);
  const prisma = makePrisma(user);
  const smsService = sms || freshSms();
  const service = new AppUnlockService({ prisma, smsService });
  return { user, prisma, smsService, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  AppUnlockService._resetMemoryState();
});

// ---------------------------------------------------------------------- PIN
describe('PIN unlock', () => {
  test('the correct PIN is accepted', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user, prisma } = build({ pinHash });
    const verdict = await service.verifyPin(user, '4321');
    expect(verdict).toMatchObject({ ok: true, code: 'PIN_OK', status: 200 });
    // A correct unlock writes nothing: no session, no token, no DB mutation.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('a wrong PIN is refused and reports what is left', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user } = build({ pinHash });
    const verdict = await service.verifyPin(user, '0000');
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('PIN_INVALID');
    expect(verdict.attemptsLeft).toBe(4);
  });

  test('a missing PIN in the request is refused', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user } = build({ pinHash });
    await expect(service.verifyPin(user, undefined)).resolves.toMatchObject({ ok: false, code: 'PIN_REQUIRED' });
    await expect(service.verifyPin(user, '')).resolves.toMatchObject({ ok: false, code: 'PIN_REQUIRED' });
  });

  test('an account with no PIN configured is refused', async () => {
    const { service, user } = build({ pinHash: null });
    await expect(service.verifyPin(user, '4321')).resolves.toMatchObject({ ok: false, code: 'PIN_NOT_CONFIGURED' });
  });

  test('the attempt budget locks the account', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user } = build({ pinHash });
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await service.verifyPin(user, '9999'));
    expect(results[4].code).toBe('PIN_LOCKED');
    expect(results[5].code).toBe('PIN_LOCKED');
    // Even the correct PIN is refused while the budget is exhausted.
    await expect(service.verifyPin(user, '4321')).resolves.toMatchObject({ ok: false, code: 'PIN_LOCKED' });
  });

  test('parallel wrong PINs cannot exceed the budget', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user } = build({ pinHash });
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => service.verifyPin(user, '9999')),
    );
    const counted = attempts.filter((a) => a.code === 'PIN_INVALID').length;
    expect(counted).toBeLessThanOrEqual(5);
    expect(attempts.every((a) => a.ok === false)).toBe(true);
  });

  test('changing an existing PIN requires the current PIN', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user, prisma } = build({ pinHash });
    const refused = await service.setPin(user, { newPin: '87654321' });
    expect(refused.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();

    const accepted = await service.setPin(user, { newPin: '8765', currentPin: '4321' });
    expect(accepted.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  test('setting a first PIN needs no proof', async () => {
    const { service, user, prisma } = build({ pinHash: null });
    const res = await service.setPin(user, { newPin: '1234' });
    expect(res.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pinHash: expect.any(String) }) }),
    );
  });

  test('removal requires fresh proof and clears only that user', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const { service, user, prisma } = build({ pinHash });

    await expect(service.removePin(user, {})).resolves.toMatchObject({ ok: false, code: 'PROOF_REQUIRED' });
    expect(prisma.user.update).not.toHaveBeenCalled();

    const wrong = await service.removePin(user, { currentPin: '0000' });
    expect(wrong.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();

    const ok = await service.removePin(user, { currentPin: '4321' });
    expect(ok.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { pinHash: null } });
  });

  test('removal of a non-existent PIN is refused rather than reported as success', async () => {
    const { service, user } = build({ pinHash: null });
    await expect(service.removePin(user, { currentPin: '4321' }))
      .resolves.toMatchObject({ ok: false, code: 'PIN_NOT_CONFIGURED' });
  });
});

// --------------------------------------------------------------------- TOTP
describe('authenticator unlock', () => {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const validCode = () => speakeasy.totp({ secret, encoding: 'base32' });

  test('an enrolled authenticator unlocks with a valid code', async () => {
    const { service, user, prisma } = build({ isTwoFactorEnabled: true, twoFactorSecret: secret });
    const verdict = await service.verifyTotp(user, validCode());
    expect(verdict).toMatchObject({ ok: true, code: 'TOTP_OK' });
    // Unlocking must never touch enrolment state.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('a disabled authenticator is refused', async () => {
    const { service, user } = build({ isTwoFactorEnabled: false, twoFactorSecret: secret });
    await expect(service.verifyTotp(user, validCode())).resolves.toMatchObject({ ok: false, code: 'TOTP_NOT_CONFIGURED' });
  });

  test('a secret without enrolment is refused', async () => {
    const { service, user } = build({ isTwoFactorEnabled: true, twoFactorSecret: null });
    await expect(service.verifyTotp(user, validCode())).resolves.toMatchObject({ ok: false, code: 'TOTP_NOT_CONFIGURED' });
  });

  test('an invalid code is refused', async () => {
    const { service, user } = build({ isTwoFactorEnabled: true, twoFactorSecret: secret });
    await expect(service.verifyTotp(user, '000000')).resolves.toMatchObject({ ok: false, code: 'TOTP_INVALID' });
  });

  test('a replayed code is refused', async () => {
    const { service, user } = build({ isTwoFactorEnabled: true, twoFactorSecret: secret });
    const code = validCode();
    await expect(service.verifyTotp(user, code)).resolves.toMatchObject({ ok: true });
    await expect(service.verifyTotp(user, code)).resolves.toMatchObject({ ok: false, code: 'TOTP_REPLAYED' });
  });
});

// ---------------------------------------------------------------------- SMS
describe('SMS unlock challenge', () => {
  test('sends only to the persisted verified phone', async () => {
    const { service, user, smsService } = build();
    const spy = jest.spyOn(smsService, 'sendSMS').mockResolvedValue({ success: true, mocked: true });
    const res = await service.sendSmsChallenge(user);
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(PHONE, expect.stringContaining('unlock code'));
    // The actual code is never returned to the caller. A digit-run heuristic
    // would trip on the ISO timestamp, so compare against the real value.
    const sentCode = (String(spy.mock.calls[0][1]).match(/\b(\d{6})\b/) || [])[1];
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res)).not.toContain(sentCode);
    expect(res.data.maskedPhone).not.toBe(PHONE);
  });

  test('an unverified phone refuses to send', async () => {
    const { service, user } = build({ phoneVerified: false });
    await expect(service.sendSmsChallenge(user)).resolves.toMatchObject({ ok: false, code: 'PHONE_UNVERIFIED' });
  });

  test('a provider failure leaves no verifiable challenge', async () => {
    const { service, user, smsService } = build();
    jest.spyOn(smsService, 'sendSMS').mockRejectedValue(new Error('provider down'));
    await expect(service.sendSmsChallenge(user)).rejects.toThrow(/provider down/);
    // Nothing survives in the store for this user.
    const leftovers = [...smsService.otpStore.keys()].filter((k) => String(k).includes('APP_UNLOCK'));
    expect(leftovers).toEqual([]);
  });

  test('the correct code unlocks exactly once and cannot be replayed', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];

    await expect(service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code }))
      .resolves.toMatchObject({ ok: true, code: 'UNLOCK_OK' });
    await expect(service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code }))
      .resolves.toMatchObject({ ok: false, code: 'CHALLENGE_INVALID' });
  });

  test('a second member cannot consume the challenge', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    const attacker = makeUser({ id: 'user-2' });
    await expect(service.verifySmsChallenge(attacker, { challengeId: issued.data.challengeId, code }))
      .resolves.toMatchObject({ ok: false, code: 'CHALLENGE_INVALID' });
  });

  test('a phone-verification OTP cannot be used for app unlock', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    // Real phone-verification OTP lives at otp:<phone>.
    await smsService.sendOTP(PHONE, 6, 5);
    const phoneOtp = String(captured).match(/\b(\d{6})\b/)[1];
    await expect(service.verifySmsChallenge(user, { challengeId: phoneOtp, code: phoneOtp }))
      .resolves.toMatchObject({ ok: false, code: 'CHALLENGE_INVALID' });
  });

  test('an unlock code cannot change phone identity', async () => {
    const { service, user, smsService, prisma } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    await service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('the attempt budget locks the challenge', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    const wrong = code === '000000' ? '111111' : '000000';
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(await service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code: wrong }));
    }
    expect(outcomes[2].code).toBe('CHALLENGE_LOCKED');
    // The real code is dead once the budget is spent.
    await expect(service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code }))
      .resolves.toMatchObject({ ok: false, code: 'CHALLENGE_INVALID' });
  });

  test('an expired challenge is refused', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    const key = `otp:APP_UNLOCK:${user.id}:${issued.data.challengeId}`;
    const rec = smsService.otpStore.get(key);
    smsService.otpStore.set(key, { ...rec, expiresAtMs: Date.now() - 1000 });
    await expect(service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code }))
      .resolves.toMatchObject({ ok: false, code: 'CHALLENGE_EXPIRED' });
  });

  test('concurrent verification of one correct code yields a single success', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code })
    )));
    expect(results.filter((r) => r.ok).length).toBe(1);
  });

  test('concurrent sends are throttled to one reservation', async () => {
    const { service, user, smsService } = build();
    jest.spyOn(smsService, 'sendSMS').mockResolvedValue({ success: true, mocked: true });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.sendSmsChallenge(user)),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
    expect(accepted).toBe(1);
  });

  test('the OTP never reaches a log line and no full phone is logged', async () => {
    const { service, user, smsService } = build();
    let captured = null;
    jest.spyOn(smsService, 'sendSMS').mockImplementation(async (phone, body) => {
      captured = body;
      return { success: true, mocked: true };
    });
    const issued = await service.sendSmsChallenge(user);
    const code = String(captured).match(/\b(\d{6})\b/)[1];
    await service.verifySmsChallenge(user, { challengeId: issued.data.challengeId, code });
    const dump = JSON.stringify([
      ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls,
    ]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(PHONE);
    expect(dump).not.toContain(OTHER_PHONE);
  });
});

// ------------------------------------------------------------- capabilities
describe('capabilities', () => {
  test('reflects persisted state without exposing secrets', async () => {
    const pinHash = await bcrypt.hash('4321', 10);
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const { service, user, prisma } = build({ pinHash, isTwoFactorEnabled: true, twoFactorSecret: secret });
    const caps = await service.capabilities(user);

    expect(caps).toMatchObject({
      pinConfigured: true,
      authenticatorConfigured: true,
      phoneVerified: true,
    });
    const dump = JSON.stringify(caps);
    expect(dump).not.toContain(pinHash);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(PHONE);
    // Read-only: no writes.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('a secret without verified enrolment is not "configured"', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const { service, user } = build({ isTwoFactorEnabled: false, twoFactorSecret: secret });
    const caps = await service.capabilities(user);
    expect(caps.authenticatorConfigured).toBe(false);
  });

  test('a mocked provider is never advertised as usable SMS', async () => {
    const { service, user } = build();
    const caps = await service.capabilities(user);
    expect(caps.smsUnlockAvailable).toBe(false);
    expect(caps.smsUnavailableReason).toBe('MOCK_PROVIDER');
  });

  test('an unverified phone makes SMS unavailable', async () => {
    const { service, user } = build({ phoneVerified: false });
    const caps = await service.capabilities(user);
    expect(caps.smsUnlockAvailable).toBe(false);
    expect(caps.phoneVerified).toBe(false);
  });
});
