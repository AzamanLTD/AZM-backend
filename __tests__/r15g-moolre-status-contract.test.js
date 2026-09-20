// __tests__/r15g-moolre-status-contract.test.js
// =============================================================================
// r15 follow-up (audit P0) — Moolre DISBURSEMENT transfer-status CONTRACT.
//
// THE DEFECT: getTransferStatus sent the STALE request shape
// { externalref, accountnumber? } while the CURRENT official Moolre Transfer
// Status API (docs.moolre.com/ai/live/transfer-status.html, verified
// 2026-09-20) requires { type: 1, idtype: 1, id, accountnumber }.
// Moolre ignores unknown fields and answers an application error — so the
// recovery path R15 depends on (resolving a previously-ambiguous payout)
// could never actually resolve anything. The collection adapter
// (moolreCollectionService.getPaymentStatus) already used the current shape;
// the disbursement adapter is brought into line here.
//
// ALSO PINNED: accountnumber is REQUIRED on the current live contracts for
// BOTH initiation and status — a LIVE configuration without it must fail
// CLOSED before any provider I/O (NOT_DISPATCHED), never send an incomplete
// request over the wire.
//
// This suite pins the exact OUTGOING adapter boundary (URL, headers, body)
// plus every status-outcome mapping. No DB required.
// =============================================================================

describe('r15 follow-up P0: Moolre disbursement transfer-status contract (axios boundary)', () => {
    let MoolreDisbursementService, PROVIDER_OUTCOMES;
    let service, noAccountService, axiosSpy, liveAxios;

    const liveEnv = (withAccount = true) => {
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_BASE_URL = 'https://moolre.test.local';
        if (withAccount) process.env.MOOLRE_ACCOUNT_NUMBER = '100000100002';
        else delete process.env.MOOLRE_ACCOUNT_NUMBER;
    };

    const freshService = (withAccount = true) => {
        liveEnv(withAccount);
        jest.resetModules();
        liveAxios = require('axios');
        MoolreDisbursementService = require('../services/moolreDisbursementService');
        PROVIDER_OUTCOMES = MoolreDisbursementService.PROVIDER_OUTCOMES;
        return new MoolreDisbursementService({});
    };

    beforeEach(() => {
        service = freshService(true);
        axiosSpy = jest.spyOn(liveAxios, 'post');
    });

    afterEach(() => {
        axiosSpy.mockRestore();
        ['MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY', 'MOOLRE_BASE_URL', 'MOOLRE_ACCOUNT_NUMBER']
            .forEach(k => delete process.env[k]);
    });

    const STATUS_URL = 'https://moolre.test.local/open/transact/status';

    // ── Exact outgoing request contract ─────────────────────────────────────

    test('status request sends the CURRENT official body: { type: 1, idtype: 1, id, accountnumber } — NOT the stale { externalref } shape', async () => {
        axiosSpy.mockResolvedValueOnce({ data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 1 } } });
        await service.getTransferStatus('R15G-REF-1');

        expect(axiosSpy).toHaveBeenCalledTimes(1);
        const [url, body, config] = axiosSpy.mock.calls[0];
        expect(url).toBe(STATUS_URL);
        expect(body).toEqual({
            type: 1,
            idtype: 1,
            id: 'R15G-REF-1',
            accountnumber: '100000100002',
        });
        // no stale externalref key smuggled in
        expect(body.externalref).toBeUndefined();
        // official headers: X-API-USER + X-API-KEY (status accepts public OR private key)
        expect(config.headers['X-API-USER']).toBe('test-user');
        expect(config.headers['X-API-KEY']).toBe('test-key');
    });

    test('initiation request carries the REQUIRED accountnumber in the body (current official contract)', async () => {
        axiosSpy.mockResolvedValueOnce({ data: { status: 1, code: 'OBGH01', message: 'Pay out Successful', data: { txstatus: 1 } } });
        await service.initiateTransfer({ referenceId: 'R15G-INIT-1', amountGhs: 50, recipientPhone: '0244556677' });

        const [url, body] = axiosSpy.mock.calls[0];
        expect(url).toBe('https://moolre.test.local/open/transact/transfer');
        expect(body.accountnumber).toBe('100000100002');
        expect(body.externalref).toBe('R15G-INIT-1');
        expect(body.type).toBe(1);
    });

    // ── Fail-closed live configuration ──────────────────────────────────────

    test('LIVE mode with NO account number: getTransferStatus fails CLOSED before any provider I/O (NOT_DISPATCHED, nothing sent)', async () => {
        noAccountService = freshService(false);
        expect(noAccountService.providerMode).toBe('LIVE');
        const err = await noAccountService.getTransferStatus('R15G-REF-2').catch(e => e);
        expect(err.providerOutcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
        expect(axiosSpy).not.toHaveBeenCalled();
    });

    test('LIVE mode with NO account number: initiateTransfer fails CLOSED before any provider I/O (NOT_DISPATCHED, nothing sent)', async () => {
        noAccountService = freshService(false);
        const err = await noAccountService
            .initiateTransfer({ referenceId: 'R15G-INIT-2', amountGhs: 50, recipientPhone: '0244556677' })
            .catch(e => e);
        expect(err.providerOutcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
        expect(axiosSpy).not.toHaveBeenCalled();
    });

    test('MOCK mode never requires an account number (local/test ergonomics preserved)', async () => {
        liveEnv(false);
        process.env.MOOLRE_PROVIDER = 'MOCK';
        jest.resetModules();
        const S = require('../services/moolreDisbursementService');
        const mockService = new S({});
        expect(mockService.providerMode).toBe('MOCK');
        const res = await mockService.getTransferStatus('R15G-MOCK-1');
        expect(res.source).toBe('MOCK');
    });

    // ── Status outcome mappings through the CORRECT body ────────────────────

    test('txstatus=1 → SUCCESSFUL with provider externalId + amount', async () => {
        axiosSpy.mockResolvedValueOnce({
            data: {
                status: 1, code: 'SS01', message: 'Transaction Successful',
                data: { txstatus: 1, transactionid: '31830714', externalref: 'R15G-REF-1', amount: '5.00' },
            },
        });
        const res = await service.getTransferStatus('R15G-REF-1');
        expect(res.status).toBe('SUCCESSFUL');
        expect(res.externalId).toBe('R15G-REF-1');
        expect(res.amountGhs).toBe(5);
        expect(res.source).toBe('LIVE');
        expect(axiosSpy.mock.calls[0][1].id).toBe('R15G-REF-1');
    });

    test('txstatus=0 → PENDING (explicit falsy pending — never misread as failure)', async () => {
        axiosSpy.mockResolvedValueOnce({
            data: { status: 1, code: 'SS00', message: 'Pending', data: { txstatus: 0 } },
        });
        const res = await service.getTransferStatus('R15G-REF-P');
        expect(res.status).toBe('PENDING');
    });

    test('txstatus=2 → FAILED — the reconciliation worker can finally TERMINATE an ambiguous payout that failed', async () => {
        axiosSpy.mockResolvedValueOnce({
            data: { status: 1, code: 'SS02', message: 'Transaction Failed', data: { txstatus: 2 } },
        });
        const res = await service.getTransferStatus('R15G-REF-F');
        expect(res.status).toBe('FAILED');
    });

    test('application error envelope (status:0, unknown reference) → stays PENDING with the provider reason — worker retries next tick, never invents a terminal state', async () => {
        axiosSpy.mockResolvedValueOnce({
            data: { status: 0, code: 'RD01', message: 'Reference not found', data: null },
        });
        const res = await service.getTransferStatus('R15G-REF-UNKNOWN');
        expect(res.status).toBe('PENDING');
        expect(res.reason).toContain('Reference not found');
    });

    test('timeout on status lookup → UNKNOWN_OUTCOME thrown (unresolved — payout stays parked, never terminal)', async () => {
        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }));
        const err = await service.getTransferStatus('R15G-REF-T').catch(e => e);
        expect(err.providerOutcome).toBe(PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);
    });

    test('5xx with no envelope on status lookup → UNKNOWN_OUTCOME thrown', async () => {
        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 502'), {
            response: { status: 502, data: 'Bad Gateway' },
        }));
        const err = await service.getTransferStatus('R15G-REF-5').catch(e => e);
        expect(err.providerOutcome).toBe(PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);
    });
});
