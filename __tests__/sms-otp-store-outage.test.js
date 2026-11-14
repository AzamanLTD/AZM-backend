'use strict';

/**
 * OTP store OUTAGE contract — the store exists but cannot be reached.
 *
 * The defect this pins: a Redis connection dropping mid-flight returned a raw
 * ioredis error, so the edge saw a generic 500 and could not distinguish "wrong
 * code" from "store down", while nothing recorded that the store had failed.
 * Worse, a naive fix (falling back to the in-process Map) would let a code
 * issued on one box verify on another.
 *
 * Contract: every store call fails closed with OTP_STORE_UNAVAILABLE, the Map is
 * never written or read, and a NON-transport error still propagates untouched
 * so real bugs stay visible.
 */

const ENV_KEYS = ['NODE_ENV', 'SMS_PROVIDER', 'REDIS_URL', 'SMS_FORCE_LIVE', 'SMS_API_KEY', 'OTP_HASH_SECRET'];
// Production requires a dedicated digest secret; without it every case here
// would fail on OTP_HASH_SECRET_MISSING before reaching the store at all.
const HASH_SECRET = 'test-only-otp-digest-secret-32chars';

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
    Object.assign(process.env, { OTP_HASH_SECRET: HASH_SECRET, ...env });
    let SMSService;
    jest.isolateModules(() => {
        SMSService = require('../services/smsService');
    });
    return new SMSService();
}

/** A production service with a client that is configured but unreachable. */
function withUnreachableStore(behaviour) {
    // No REDIS_URL: the constructor cannot reach the network, so no real client
    // is created. The unreachable client is injected afterwards, which is
    // exactly the production shape: configured, then the network goes away.
    const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre' });
    svc._redisClient = behaviour;
    return svc;
}

const transportError = (code = 'MaxRetriesPerRequestError', message = 'Reached the max retries per request limit') =>
    Object.assign(new Error(message), { code });

describe('a store outage is a typed refusal, never a silent fallback', () => {
    beforeEach(() => { loggerCalls.length = 0; });

    test('sendOTP refuses with OTP_STORE_UNAVAILABLE and issues no code', async () => {
        const svc = withUnreachableStore({
            eval: jest.fn().mockRejectedValue(transportError()),
            set: jest.fn().mockRejectedValue(transportError()),
        });

        await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
        expect(svc.otpStore.size).toBe(0);        // never written to process memory
        expect(svc._redisClient.set).not.toHaveBeenCalled(); // throttle refused first
    });

    test('verifyOTP refuses with OTP_STORE_UNAVAILABLE instead of a generic error', async () => {
        const svc = withUnreachableStore({
            eval: jest.fn().mockRejectedValue(transportError('NR_CLOSED', 'Connection is closed.')),
        });

        await expect(svc.verifyOTP(PHONE, '123456')).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
        expect(svc.otpStore.size).toBe(0);        // the Map is never consulted
    });

    test('a write that fails after the throttle succeeded still refuses, and says so in the log', async () => {
        const svc = withUnreachableStore({
            eval: jest.fn().mockResolvedValue([1, 'OK', 0]),
            set: jest.fn().mockRejectedValue(transportError('ECONNRESET', 'socket closed')),
        });

        await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
        expect(svc.otpStore.size).toBe(0);
        const outageLogged = loggerCalls.some(([level, args]) =>
            level === 'error' && JSON.stringify(args).includes('transport failure'));
        expect(outageLogged).toBe(true);
    });

    test('the unlock challenge path refuses the same way', async () => {
        const svc = withUnreachableStore({
            eval: jest.fn().mockResolvedValue([1, 'OK', 0]),
            set: jest.fn().mockRejectedValue(transportError()),
        });

        await expect(svc.issueUnlockChallenge({
            userId: 'user-outage',
            phoneNumber: PHONE,
            purpose: 'APP_UNLOCK',
        })).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
    });

    test('an error that is NOT a transport failure propagates unchanged', async () => {
        // Guards against swallowing real bugs behind the outage contract.
        const bug = Object.assign(new Error('unexpected script arity'), { code: 'ERR_SCRIPT_BUG' });
        const svc = withUnreachableStore({ eval: jest.fn().mockRejectedValue(bug) });

        await expect(svc.verifyOTP(PHONE, '123456')).rejects.toMatchObject({ code: 'ERR_SCRIPT_BUG' });
    });

    test('a dropped connection detected only by message text is still mapped', async () => {
        const svc = withUnreachableStore({
            eval: jest.fn().mockRejectedValue(new Error('Stream isn\'t writeable and enableOfflineQueue options is false')),
        });

        await expect(svc.verifyOTP(PHONE, '123456')).rejects.toMatchObject({ code: 'OTP_STORE_UNAVAILABLE' });
    });
});

describe('cleanup cannot mask the failure that caused it', () => {
    test('a failed delete does not replace the provider error the caller needs', async () => {
        const svc = fresh({ NODE_ENV: 'production', SMS_PROVIDER: 'moolre' });
        svc._redisClient = {
            eval: jest.fn().mockResolvedValue([1, 'OK', 0]),
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn().mockRejectedValue(transportError()),
        };
        // Force the SMS step to fail after the code was stored.
        svc.sendSMS = jest.fn().mockRejectedValue(
            Object.assign(new Error('provider said no'), { code: 'SMS_SEND_FAILED' })
        );

        await expect(svc.sendOTP(PHONE)).rejects.toMatchObject({ code: 'SMS_SEND_FAILED' });
        expect(svc._redisClient.del).toHaveBeenCalled();
    });
});
