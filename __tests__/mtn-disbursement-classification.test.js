// __tests__/mtn-disbursement-classification.test.js
// =============================================================================
// P0 payout unknown-outcome — MTN adapter error classification.
//
// The payoutBatchWorker must never guess outcome from error message strings.
// This suite proves the adapter's LIVE path attaches an explicit
// providerOutcome to every thrown initiateTransfer error using HTTP
// semantics:
//   - validation / OAuth failure        → NOT_DISPATCHED (provider never invoked)
//   - provider response, status < 500   → DEFINITIVE_REJECTION (explicit refusal)
//   - provider response, status >= 500  → UNKNOWN_OUTCOME (ambiguous gateway)
//   - no response (timeout/reset/DNS)   → UNKNOWN_OUTCOME (may have reached MTN)
// =============================================================================
jest.mock('axios', () => ({
    post: jest.fn()
}));

const axios = require('axios');
const MtnDisbursementService = require('../services/mtnDisbursementService');

const VALID_PAYLOAD = {
    referenceId: 'ref-classification-1',
    amountGhs: 25,
    recipientPhone: '0240000000',
    externalId: 'ext-1'
};

const makeLiveService = () => {
    const svc = new MtnDisbursementService();
    svc.providerMode = 'LIVE';
    return svc;
};

const tokenOk = { data: { access_token: 'tok', expires_in: 3600 } };

const dispatch = () => makeLiveService().initiateTransfer(VALID_PAYLOAD);

beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockReset();
});

describe('MtnDisbursementService providerOutcome classification (LIVE path)', () => {
    test('validation failures are NOT_DISPATCHED — provider provably never invoked', async () => {
        const svc = makeLiveService();
        await expect(svc.initiateTransfer({})).rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED' });
        await expect(svc.initiateTransfer({ referenceId: 'r', amountGhs: 0, recipientPhone: '024' }))
            .rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED' });
        await expect(svc.initiateTransfer({ referenceId: 'r', amountGhs: 5 }))
            .rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('OAuth token fetch failure is NOT_DISPATCHED — transfer request never sent', async () => {
        axios.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED')); // token fetch fails
        await expect(dispatch()).rejects.toMatchObject({ providerOutcome: 'NOT_DISPATCHED' });
        expect(axios.post).toHaveBeenCalledTimes(1); // only the token call, never the transfer
    });

    test('provider 4xx response is DEFINITIVE_REJECTION', async () => {
        axios.post
            .mockResolvedValueOnce(tokenOk) // token
            .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
                response: { status: 400, data: { message: 'INVALID_MSISDN' } }
            }));
        await expect(dispatch()).rejects.toMatchObject({ providerOutcome: 'DEFINITIVE_REJECTION' });
    });

    test('provider 5xx response is UNKNOWN_OUTCOME — gateway ambiguity', async () => {
        axios.post
            .mockResolvedValueOnce(tokenOk)
            .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 504'), {
                response: { status: 504, data: {} }
            }));
        await expect(dispatch()).rejects.toMatchObject({ providerOutcome: 'UNKNOWN_OUTCOME' });
    });

    test('transport error without a response (client timeout / connection reset) is UNKNOWN_OUTCOME', async () => {
        axios.post
            .mockResolvedValueOnce(tokenOk)
            .mockRejectedValueOnce(Object.assign(new Error('timeout of 15000ms exceeded'), {
                code: 'ETIMEDOUT'
            }));
        await expect(dispatch()).rejects.toMatchObject({ providerOutcome: 'UNKNOWN_OUTCOME' });
    });

    test('successful dispatch returns the async PENDING result unchanged', async () => {
        axios.post
            .mockResolvedValueOnce(tokenOk)
            .mockResolvedValueOnce({ status: 202, data: '' });
        const result = await dispatch();
        expect(result.status).toBe('PENDING');
        expect(result.referenceId).toBe(VALID_PAYLOAD.referenceId);
    });
});
