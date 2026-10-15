// __tests__/firebaseService.v14.test.js
// =============================================================================
// Firebase Admin SDK v14 MODULAR API — migration contract tests.
//
// Proves utils/firebaseService.js and controllers/ssoController.js run on
// firebase-admin v14, where the legacy namespaced API is REMOVED:
//   - `admin.apps`, `admin.messaging`, `admin.credential` are undefined on
//     the default export (the exact crash on the live Render deploy was
//     `admin.apps.length` → "Cannot read properties of undefined").
//   - The supported surface is the modular subpaths: firebase-admin/app
//     (initializeApp, getApps, cert), firebase-admin/messaging
//     (getMessaging), firebase-admin/auth (getAuth).
//
// Init-contract tests run against the REAL installed SDK with a FAKE but
// structurally valid service account — a throwaway RSA key generated in
// this file (cert() in v14 parses the PEM; initializeApp does no network
// I/O). Sends go through the MOCKED messaging module, and the logger is
// mocked so no test requires production credentials, delivers a real
// notification, or emits log noise.
// =============================================================================

jest.mock('firebase-admin/messaging', () => ({
    getMessaging: jest.fn(),
}));

// The service (and everything it requires inside jest.isolateModules) gets
// this mocked logger — the SAME instance this file asserts on. A fresh
// module registry under isolateModules would otherwise hand the service a
// different pino instance and spies would see nothing.
jest.mock('../src/config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() })),
}));

const fs = require('fs');
const path = require('path');
const { generateKeyPairSync } = require('crypto');
const { getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('../src/config/logger');

// Throwaway RSA key — generated here, never a real credential. firebase-admin
// v14's cert() parses the PEM structurally; no network I/O happens at init.
const FAKE_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

const FAKE_SERVICE_ACCOUNT = {
    type: 'service_account',
    project_id: 'azaman-test-project',
    private_key_id: 'fake-key-id-000',
    private_key: FAKE_PRIVATE_KEY,
    client_email: 'firebase-adminsdk-test@azaman-test-project.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
};

const ENCODING_MARKER = 'ZZ-NEVER-LOG-ME-SECRET-MARKER-ZZ';

// Fresh service module under a controlled env (module-load initialization).
function loadService(env) {
    const saved = {};
    const set = (k, v) => {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    set('FIREBASE_SERVICE_ACCOUNT', env.FIREBASE_SERVICE_ACCOUNT);
    set('FIREBASE_SERVICE_ACCOUNT_BASE64', env.FIREBASE_SERVICE_ACCOUNT_BASE64);
    let service;
    let appModule;
    jest.isolateModules(() => {
        // Capture the registry the service will actually use — isolateModules
        // hands it a fresh firebase-admin/app module instance, whose app
        // registry is invisible to this file's own top-level getApps().
        appModule = require('firebase-admin/app');
        service = require('../utils/firebaseService');
    });
    // restore immediately AFTER the module-load init ran with our env
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    scopes.push(appModule);
    return { service, getApps: appModule.getApps };
}

let mockSend;
const scopes = [];

beforeEach(() => {
    jest.clearAllMocks();
    mockSend = jest.fn().mockResolvedValue('projects/azaman-test-project/messages/fake-msg-1');
    getMessaging.mockImplementation(() => ({ send: mockSend }));
});

afterEach(async () => {
    // Delete every app created during a test (in any isolated registry) so
    // suites stay isolated.
    for (const scope of scopes) {
        await Promise.all(scope.getApps().map((a) => a.delete()));
    }
    scopes.length = 0;
});

describe('SDK v14 contract — the installed firebase-admin really is v14', () => {
    test('the installed SDK is v14.x with the modular API surface', () => {
        const version = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'firebase-admin', 'package.json'), 'utf8')
        ).version;
        expect(version).toMatch(/^14\./);

        // Modular entry points exist…
        const { initializeApp, getApps, cert } = require('firebase-admin/app');
        expect(typeof initializeApp).toBe('function');
        expect(typeof getApps).toBe('function');
        expect(typeof cert).toBe('function');
        expect(typeof getMessaging).toBe('function');
    });

    test('the legacy namespaced API is REMOVED in v14 (the live crash)', () => {
        const admin = require('firebase-admin');
        expect(typeof admin.initializeApp).toBe('function');
        // v14 removed the namespaced surface — these are the exact
        // properties the old code dereferenced.
        expect(admin.apps).toBeUndefined();
        expect(admin.messaging).toBeUndefined();
        expect(admin.credential).toBeUndefined();
        // …which is exactly why the old `apps.length` guard crashed on the
        // live service: reading `.length` of undefined.
        expect(() => admin.apps.length).toThrow(/Cannot read propert.*undefined/);
    });
});

describe('firebaseService v14 modular initialization', () => {
    test('initializes from the base64-encoded FIREBASE_SERVICE_ACCOUNT (preferred deployment credential)', () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(FAKE_SERVICE_ACCOUNT), 'utf8').toString('base64'),
        });
        expect(service.initializeFirebase()).toBe(true);
        expect(getApps()).toHaveLength(1);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('accepts a raw-JSON FIREBASE_SERVICE_ACCOUNT value (tolerant encoding)', () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SERVICE_ACCOUNT),
        });
        expect(service.initializeFirebase()).toBe(true);
        expect(getApps()).toHaveLength(1);
    });

    test('still supports the legacy FIREBASE_SERVICE_ACCOUNT_BASE64 env name', () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(JSON.stringify(FAKE_SERVICE_ACCOUNT), 'utf8').toString('base64'),
        });
        expect(service.initializeFirebase()).toBe(true);
        expect(getApps()).toHaveLength(1);
    });

    test('FIREBASE_SERVICE_ACCOUNT takes priority when both env names are set', () => {
        // If the preferred name were NOT first, the malformed BASE64 value
        // would make initialization fail.
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(FAKE_SERVICE_ACCOUNT), 'utf8').toString('base64'),
            FIREBASE_SERVICE_ACCOUNT_BASE64: 'this-is-not-valid-base64-json!!!',
        });
        expect(service.initializeFirebase()).toBe(true);
        expect(getApps()).toHaveLength(1);
    });

    test('initialization is idempotent — re-running never stacks apps', () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SERVICE_ACCOUNT),
        });
        expect(service.initializeFirebase()).toBe(true);
        expect(service.initializeFirebase()).toBe(true);
        expect(getApps()).toHaveLength(1);
    });

    test('malformed credentials fail SAFE: no throw, no app, warn logged without the credential value', () => {
        const malformed = ENCODING_MARKER + '!!!not-json-nor-valid-base64-payload***';

        const { service, getApps } = loadService({ FIREBASE_SERVICE_ACCOUNT: malformed });

        expect(service.initializeFirebase()).toBe(false);
        expect(getApps()).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalled();
        // SECURITY: the logged error must NEVER contain the credential
        // input (v14's JSON.parse errors echo input snippets — the service
        // wraps them in a generic message).
        const logged = JSON.stringify(logger.warn.mock.calls);
        expect(logged).not.toContain(ENCODING_MARKER);
    });

    test('missing credentials (no env vars, no local file) fail SAFE at module load', () => {
        // CI/dev checkout: service-account.json is gitignored and absent, so
        // the file fallback throws MODULE_NOT_FOUND — must be swallowed.
        const { service, getApps } = loadService({});
        expect(service.initializeFirebase()).toBe(false);
        expect(getApps()).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalled();
    });

    test('_parseServiceAccount handles base64, URL-safe base64 and raw JSON, and rejects garbage without echoing it', () => {
        const { service, getApps } = loadService({});
        const json = JSON.stringify(FAKE_SERVICE_ACCOUNT);
        // standard base64
        expect(service._parseServiceAccount(Buffer.from(json).toString('base64'))).toEqual(FAKE_SERVICE_ACCOUNT);
        // URL-safe alphabet (- _ instead of + /)
        expect(service._parseServiceAccount(Buffer.from(json).toString('base64url'))).toEqual(FAKE_SERVICE_ACCOUNT);
        // raw JSON
        expect(service._parseServiceAccount(json)).toEqual(FAKE_SERVICE_ACCOUNT);
        // garbage → generic error, never an input-echoing parse message
        expect(() => service._parseServiceAccount('!!!not base64 or json!!!')).toThrow(
            /FIREBASE_CREDENTIAL_PARSE_ERROR/
        );
    });
});

describe('sendPushNotification through the modular messaging API', () => {
    test('sends via getMessaging().send() and stringifies every data field', async () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SERVICE_ACCOUNT),
        });
        const response = await service.sendPushNotification(
            'device-token-abc', 'New Order', 'Buyer wants to trade $50', { tradeId: 123, amount: 45.5 }
        );

        expect(response).toBe('projects/azaman-test-project/messages/fake-msg-1');
        expect(mockSend).toHaveBeenCalledTimes(1);
        const message = mockSend.mock.calls[0][0];
        expect(message.token).toBe('device-token-abc');
        expect(message.notification).toEqual({ title: 'New Order', body: 'Buyer wants to trade $50' });
        // Payload contract preserved: all data values are STRINGS…
        expect(message.data.tradeId).toBe('123');
        expect(message.data.amount).toBe('45.5');
        // …and the Flutter click_action default is preserved.
        expect(message.data.click_action).toBe('FLUTTER_NOTIFICATION_CLICK');
    });

    test('missing token: warns and never touches messaging', async () => {
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SERVICE_ACCOUNT),
        });
        const result = await service.sendPushNotification(null, 't', 'b');
        expect(result).toBeUndefined();
        expect(getMessaging).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    test('Firebase not initialized (getApps().length === 0): warns and never sends', async () => {
        const { service, getApps } = loadService({}); // no credentials anywhere
        const result = await service.sendPushNotification('device-token-abc', 't', 'b');
        expect(result).toBeUndefined();
        expect(getMessaging).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('a failed send is swallowed and logged, never thrown', async () => {
        mockSend.mockRejectedValueOnce(new Error('messaging/registration-token-not-registered'));
        const { service, getApps } = loadService({
            FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SERVICE_ACCOUNT),
        });
        const result = await service.sendPushNotification('stale-token', 't', 'b');
        expect(result).toBeUndefined(); // did not throw
        expect(logger.error).toHaveBeenCalled();
    });
});

describe('ssoController uses the v14 modular auth API', () => {
    test('the controller no longer references the legacy namespaced API', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'ssoController.js'), 'utf8');
        // No legacy namespaced dereferences remain…
        expect(src).not.toMatch(/admin\.apps/);
        expect(src).not.toMatch(/admin\.auth\(\)/);
        expect(src).not.toMatch(/require\('firebase-admin'\);/);
        // …and the modular entry points are used instead.
        expect(src).toMatch(/require\('firebase-admin\/app'\)/);
        expect(src).toMatch(/require\('firebase-admin\/auth'\)/);
        expect(src).toMatch(/getApps\(\)\.length === 0/);
        expect(src).toMatch(/getAuth\(\)\.verifyIdToken/);
    });
});
