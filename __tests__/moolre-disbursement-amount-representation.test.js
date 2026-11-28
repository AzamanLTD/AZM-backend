// __tests__/moolre-disbursement-amount-representation.test.js
// =============================================================================
// §r42.5 — what the Moolre disbursement adapter RETURNS and what it SENDS.
//
// The outbound provider payload has carried a 2-dp decimal string since the
// §r42.2 correction, but the same service also returned `Number(amountGhs)` on
// its mock and live success paths, and `Number(data.amount)` for a
// provider-echoed status. Every one of those is consumed as payout evidence
// (dispatch records, reconciliation, polls), so a JS number there would make a
// double the authoritative financial record.
//
// Contract pinned here:
//   • the provider body carries the exact 2-dp decimal string;
//   • the returned `amountGhs` is that same exact string, on mock AND live;
//   • `amountGhsValue` is the explicitly-named numeric projection;
//   • a provider-echoed status amount is normalised to 2dp exactly;
//   • an amount whose decimal expansion exceeds 2dp is rounded HALF_UP once,
//     not by a binary round-trip.
// =============================================================================

const { Prisma } = require('@prisma/client');


const loadService = () => {
    jest.resetModules();
    // eslint-disable-next-line global-require
    return require('../services/moolreDisbursementService');
};

// NOTE: the service is loaded through jest.resetModules(), so it holds its OWN
// axios module instance. The spy must be taken from the CURRENT registry —
// i.e. after the service is required — or it would patch an unrelated copy.
const liveServiceWithPost = (impl) => {
    const svc = liveService();
    // eslint-disable-next-line global-require
    jest.spyOn(require('axios'), 'post').mockImplementation(impl);
    return svc;
};

const liveService = () => {
    process.env.MOOLRE_PROVIDER = 'LIVE';
    process.env.MOOLRE_API_USER = 'u';
    process.env.MOOLRE_API_KEY = 'k';
    process.env.MOOLRE_ACCOUNT_NUMBER = '0240000000';
    return new (loadService())();
};

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MOOLRE_PROVIDER;
    delete process.env.MOOLRE_API_USER;
    delete process.env.MOOLRE_API_KEY;
    delete process.env.MOOLRE_ACCOUNT_NUMBER;
});

describe('moolreDisbursementService — exact amount representation', () => {
    test('the MOCK path returns the exact 2-dp string and an explicit numeric projection', async () => {
        delete process.env.MOOLRE_PROVIDER;
        const svc = new (loadService())();
        const res = await svc.initiateTransfer({
            referenceId: 'rep-mock-1', amountGhs: '650', recipientPhone: '0241234567', network: 'MTN',
        });
        expect(res.amountGhs).toBe('650.00');
        expect(typeof res.amountGhs).toBe('string');
        // A replay echoes the stored representation unchanged.
        const replay = await svc.initiateTransfer({
            referenceId: 'rep-mock-1', amountGhs: '650', recipientPhone: '0241234567', network: 'MTN',
        });
        expect(replay.amountGhs).toBe('650.00');
    });

    test('the value is rounded HALF_UP to 2dp exactly once', async () => {
        delete process.env.MOOLRE_PROVIDER;
        const svc = new (loadService())();
        const res = await svc.initiateTransfer({
            referenceId: 'rep-round-1', amountGhs: '4.305', recipientPhone: '0241234567', network: 'MTN',
        });
        expect(res.amountGhs).toBe('4.31');
    });

    test('the LIVE path sends and returns the same exact string', async () => {
        const calls = [];
        const svc = liveServiceWithPost(async (url, body) => {
            calls.push({ url, body });
            return { data: { status: 1, message: 'ok', data: { transactionid: 'TX-1', txstatus: 1 } } };
        });
        const res = await svc.initiateTransfer({
            referenceId: 'rep-live-1', amountGhs: '268.40', recipientPhone: '0241234567', network: 'MTN',
        });
        expect(calls[0].body.amount).toBe('268.40');
        expect(typeof calls[0].body.amount).toBe('string');
        expect(res.amountGhs).toBe('268.40');
        expect(res.amountGhsValue).toBe(268.4);
    });

    test('a provider-echoed status amount is normalised exactly, never a double', async () => {
        const svc = liveServiceWithPost(async () => ({
            data: {
                status: 1, message: 'ok',
                data: { transactionid: 'TX-2', amount: '268.4', txstatus: 1 },
            },
        }));
        const res = await svc.getTransferStatus({ referenceId: 'rep-live-2' });
        expect(res.amountGhs).toBe('268.40');
        expect(typeof res.amountGhs).toBe('string');
        expect(new Prisma.Decimal(res.amountGhs).equals('268.4')).toBe(true);
    });
});
