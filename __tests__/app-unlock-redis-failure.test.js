/**
 * Fail-closed proof for an unreachable durable store, isolated in its own file:
 * this case re-registers modules, which would otherwise leak into sibling tests.
 */
const previousUrl = process.env.REDIS_URL;

test('a broken Redis URL refuses the challenge instead of using memory', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6390'; // nothing listening
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    const SMSService = require('../services/smsService');
    const { AppUnlockService } = require('../services/appUnlockService');
    const svc = new AppUnlockService({
        smsService: new SMSService(),
        prisma: { user: {} },
    });
    const result = await svc.sendSmsChallenge({
        id: 908, phoneNumber: '+233241234567', phoneVerified: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('OTP_STORE_UNAVAILABLE');
    process.env.REDIS_URL = previousUrl;
    process.env.NODE_ENV = 'test';
}, 20000);
