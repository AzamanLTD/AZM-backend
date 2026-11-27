// __tests__/provider-mock-refused-in-production.test.js
// =============================================================================
// MOCK providers never answer in production.
//
// Each adapter below falls back to an in-process MOCK when its LIVE config is
// incomplete. A mock answers success: deposits "settle", payouts are "sent",
// KYC "verifies", deposit addresses are fakes. With NODE_ENV=production every
// mock branch must refuse with the adapter's own typed outcome, and outside
// production the mock must behave exactly as before.
// =============================================================================
'use strict';

const ENV_KEYS = [
    'NODE_ENV', 'MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY',
    'TATUM_PROVIDER', 'TATUM_API_KEY', 'TATUM_XPUB', 'KYC_PROVIDER', 'DOJAH_WEBHOOK_SECRET',
];
const saved = {};

function setEnv(overrides) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
}

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const MoolreCollectionService = require('../services/moolreCollectionService');
const MoolreDisbursementService = require('../services/moolreDisbursementService');
const TatumService = require('../services/tatumService');
const KYCService = require('../services/kycService');
const { MOCK_REFUSED_CODE } = require('../src/config/providerModeGuard');

const collectionClass = MoolreCollectionService.MoolreCollectionService || MoolreCollectionService;
const disbursementClass = MoolreDisbursementService.MoolreDisbursementService || MoolreDisbursementService;
const tatumClass = TatumService.TatumService || TatumService;
const kycClass = KYCService.KYCService || KYCService;

function fakePrisma() {
    return {
        user: {
            findUnique: jest.fn().mockResolvedValue({ kycStatus: 'UNVERIFIED' }),
            update: jest.fn().mockResolvedValue({}),
        },
    };
}

describe('Moolre collection', () => {
    test('production: initiate is NOT_DISPATCHED and opens nothing', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new collectionClass();
        expect(svc.providerMode).toBe('MOCK');
        await expect(svc.initiatePayment({ externalRef: 'ref-1', amountGhs: '10.00', payerPhone: '0240000000' }))
            .rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED', code: MOCK_REFUSED_CODE });
        expect(svc._mockLedger.size).toBe(0);
    });

    test('production: status is UNKNOWN, never settled', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new collectionClass();
        svc._mockLedger.set('ref-2', { status: 'PENDING', amount: '10.00' });
        await expect(svc.getPaymentStatus({ externalRef: 'ref-2' }))
            .rejects.toMatchObject({ providerOutcome: 'UNKNOWN_OUTCOME', code: MOCK_REFUSED_CODE });
    });

    test('production: name lookup and payment id are refused', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new collectionClass();
        await expect(svc.validateName({ payerPhone: '0240000000' })).rejects.toMatchObject({ code: MOCK_REFUSED_CODE });
        await expect(svc.createPaymentId({ phone: '0240000000', name: 'X' })).rejects.toMatchObject({ code: MOCK_REFUSED_CODE });
    });

    test('outside production the mock behaves as before', async () => {
        setEnv({ NODE_ENV: 'test' });
        const svc = new collectionClass();
        const r = await svc.initiatePayment({ externalRef: 'ref-3', amountGhs: '10.00', payerPhone: '0240000000' });
        expect(r.providerRef).toMatch(/^mock-prov-/);
        await expect(svc.getPaymentStatus({ externalRef: 'ref-3' })).resolves.toMatchObject({ txstatus: 1 });
        await expect(svc.validateName({ payerPhone: '0240000000' })).resolves.toBe('MOCK ACCOUNT HOLDER');
    });
});

describe('Moolre disbursement', () => {
    const transfer = { referenceId: 'wd-1', amountGhs: '25.00', recipientPhone: '0240000000', network: 'MTN' };

    test('production: payout is NOT_DISPATCHED, never reported sent', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new disbursementClass();
        expect(svc.providerMode).toBe('MOCK');
        await expect(svc.initiateTransfer(transfer))
            .rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED', code: MOCK_REFUSED_CODE });
        expect(svc._mockTransfers.size).toBe(0);
    });

    test('production: payout status is UNKNOWN', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new disbursementClass();
        await expect(svc.getTransferStatus('wd-1'))
            .rejects.toMatchObject({ providerOutcome: 'UNKNOWN_OUTCOME', code: MOCK_REFUSED_CODE });
    });

    test('outside production the mock still answers', async () => {
        setEnv({ NODE_ENV: 'test' });
        const svc = new disbursementClass();
        await expect(svc.initiateTransfer(transfer)).resolves.toBeTruthy();
    });
});

describe('Tatum', () => {
    test('production: no fake deposit address is handed out', async () => {
        setEnv({ NODE_ENV: 'production' });
        const svc = new tatumClass();
        expect(svc.providerMode).toBe('MOCK');
        await expect(svc.deriveDepositAddress(7)).rejects.toMatchObject({ code: MOCK_REFUSED_CODE, statusCode: 503 });
        await expect(svc.subscribeAddress('0xabc')).rejects.toMatchObject({ code: MOCK_REFUSED_CODE });
    });

    test('outside production the mock address is still derived', async () => {
        setEnv({ NODE_ENV: 'test' });
        const svc = new tatumClass();
        const r = await svc.deriveDepositAddress(7);
        expect(r.source).toBe('MOCK');
        expect(r.address).toMatch(/^0x[0-9a-f]{40}$/i);
    });
});

describe('KYC mock adapter', () => {
    const payload = { reference_id: 'KYC-1', verification_status: 'Completed', overall_confidence: 99 };

    test('production: session refused, nothing written', async () => {
        setEnv({ NODE_ENV: 'production', KYC_PROVIDER: 'mock' });
        const prisma = fakePrisma();
        const svc = new kycClass(prisma, null);
        const r = await svc.initializeSession({ userId: 1, email: 'a@b.c' });
        expect(r).toMatchObject({ success: false, code: 'KYC_PROVIDER_NOT_CONFIGURED' });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('production: the fixed mock signature and the placeholder secret verify nothing', async () => {
        setEnv({ NODE_ENV: 'production', KYC_PROVIDER: 'mock' });
        const svc = new kycClass(fakePrisma(), null);
        expect(svc.dojahWebhookSecret).toBe('');
        expect(svc._verifyWebhookSignature(payload, 'mock_signature', '{}')).toBe(false);
        expect(svc._verifyWebhookSignature(payload, 'mock_webhook_secret', '{}')).toBe(false);
        const crypto = require('crypto');
        const raw = JSON.stringify(payload);
        const forged = crypto.createHmac('sha256', 'mock_webhook_secret').update(raw).digest('hex');
        expect(svc._verifyWebhookSignature(payload, forged, raw)).toBe(false);
        await expect(svc.processWebhook(payload, 'mock_signature', raw)).resolves.toMatchObject({ success: false });
    });

    test('production with a non-mock name but no secret still verifies nothing', () => {
        setEnv({ NODE_ENV: 'production', KYC_PROVIDER: 'other' });
        const svc = new kycClass(fakePrisma(), null);
        const crypto = require('crypto');
        const raw = JSON.stringify(payload);
        const forged = crypto.createHmac('sha256', '').update(raw).digest('hex');
        expect(svc._verifyWebhookSignature(payload, forged, raw)).toBe(false);
    });

    test('outside production the mock harness still accepts its test signature', () => {
        setEnv({ NODE_ENV: 'test', KYC_PROVIDER: 'mock' });
        const svc = new kycClass(fakePrisma(), null);
        expect(svc._verifyWebhookSignature(payload, 'mock_signature', '{}')).toBe(true);
    });
});
