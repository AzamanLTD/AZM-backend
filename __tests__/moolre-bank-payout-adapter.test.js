// Provider-boundary tests for the Moolre Ghana BANK PAYOUT adapter (channel 2).
//
// These are FIXTURE tests: HTTP is faked at the adapter boundary, so they prove
// parsing, validation and outcome classification — not that Moolre's sandbox
// agrees. Sandbox verification is explicitly outstanding (see the contract doc).
//
// The money-safety invariants asserted here:
//   • the caller's referenceId is used verbatim and never regenerated;
//   • an unknown outcome never becomes a second transfer POST;
//   • a duplicate reference is its own outcome, not a retry;
//   • NOT_FOUND, UNRESOLVED and UNKNOWN_OUTCOME are never reported as success.

const MoolreBankPayoutService = require('../services/moolreBankPayoutService');
const { PROVIDER_OUTCOMES, MoolreBankPayoutError } = MoolreBankPayoutService;
const logger = require('../src/config/logger');

const BANK_DIRECTORY = {
    status: 1,
    code: 'SD01',
    message: 'Banks Found',
    data: [
        { name: 'ADB BANK GHANA LTD', code: '030301' },
        { name: '  ABSA   BANK GHANA LTD ', code: '030100' },
        { name: 'ADB BANK GHANA LTD', code: '030301' },   // duplicate code
        { name: '', code: '030999' },                     // malformed: no name
        { name: 'NO CODE BANK' },                         // malformed: no code
        { name: 'ACCESS BANK GHANA LTD', code: '030402' },
    ],
};

const TRANSFER_OK = {
    status: '1',
    code: 'OBGH01',
    message: ['Pay out Successful', 'Click close to view transactions.'],
    data: {
        txstatus: 1,
        receiver: '0246798993',
        transactionid: '32759150',
        externalref: 'wd-42',
        thirdpartyref: '901733241086',
        receivername: 'YUSIF YA-ADZAGEY',
        amount: '25.50',
        amountfee: '1.01',
        networkfee: '0.00',
        fee: '0.01',
    },
};

const ACCOUNT = '0012345678901';

function fakeHttp(overrides = {}) {
    const calls = [];
    const http = {
        calls,
        get: async (url, cfg) => {
            calls.push({ method: 'GET', url, cfg });
            if (overrides.directoryError) throw overrides.directoryError;
            return overrides.directory || { status: 200, data: BANK_DIRECTORY };
        },
        post: async (url, body, cfg) => {
            calls.push({ method: 'POST', url, body, cfg });
            if (url.endsWith('/validate')) {
                if (overrides.validateError) throw overrides.validateError;
                return overrides.validate || { status: 200, data: { status: 1, code: 'AVD01', message: 'Successful', data: '  BRIGHT   BUAME ' } };
            }
            if (url.endsWith('/transfer')) {
                if (overrides.transferError) throw overrides.transferError;
                return overrides.transfer || { status: 200, data: TRANSFER_OK };
            }
            if (url.endsWith('/status')) {
                if (overrides.statusError) throw overrides.statusError;
                return overrides.status || { status: 200, data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 1, transactionid: '31830714', externalref: 'wd-42' } } };
            }
            return { status: 404, data: {} };
        },
    };
    return http;
}

const service = (http, opts = {}) => new MoolreBankPayoutService({
    http,
    apiUser: 'api-user',
    apiKey: 'private-key',
    accountNumber: '100000100002',
    baseUrl: 'https://sandbox.moolre.com',
    ...opts,
});

const transferCalls = (http) => http.calls.filter((c) => c.url.endsWith('/transfer'));
const statusCalls = (http) => http.calls.filter((c) => c.url.endsWith('/status'));

async function expectOutcome(promise, outcome, code) {
    await expect(promise).rejects.toBeInstanceOf(MoolreBankPayoutError);
    try {
        await promise;
    } catch (err) {
        expect(err.outcome).toBe(outcome);
        if (code) expect(err.code).toBe(code);
        return err;
    }
    return null;
}

describe('Moolre bank payout adapter — bank directory', () => {
    test('maps provider name/code, preserves leading zeroes, dedupes and sorts', async () => {
        const http = fakeHttp();
        const result = await service(http).listBanks();

        expect(result.source).toBe('MOOLRE');
        expect(result.stale).toBe(false);
        expect(result.banks.map((b) => b.code)).toEqual(['030100', '030301', '030402']);
        expect(result.banks[0].code).toBe('030100');            // leading zero kept
        expect(result.banks[0].name).toBe('ABSA BANK GHANA LTD'); // whitespace normalised
        expect(result.banks).toHaveLength(3);                    // duplicate code collapsed
        expect(typeof result.retrievedAt).toBe('string');
    });

    test('rejects a malformed or empty directory instead of inventing banks', async () => {
        await expectOutcome(service(fakeHttp({ directory: { status: 200, data: { status: 0, code: 'SD00', data: [] } } })).listBanks(), PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, 'DIRECTORY_STATUS');
        await expectOutcome(service(fakeHttp({ directory: { status: 200, data: { status: 1, data: 'banks' } } })).listBanks(), PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, 'DIRECTORY_SHAPE');
        await expectOutcome(service(fakeHttp({ directory: { status: 200, data: { status: 1, data: [{ name: '' }, { code: '' }] } } })).listBanks(), PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, 'DIRECTORY_EMPTY');
    });

    test('caches within the TTL and forceRefresh bypasses it', async () => {
        const http = fakeHttp();
        const svc = service(http);
        await svc.listBanks();
        await svc.listBanks();
        expect(http.calls.filter((c) => c.method === 'GET')).toHaveLength(1);

        await svc.listBanks({ forceRefresh: true });
        expect(http.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    });

    test('serves stale metadata during an outage, then fails closed beyond the window', async () => {
        const http = fakeHttp();
        const svc = service(http, { cacheTtlMs: 0, staleWindowMs: 60000 });
        await svc.listBanks();

        http.get = async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
        const stale = await svc.listBanks();
        expect(stale.stale).toBe(true);
        expect(stale.banks).toHaveLength(3);

        // Beyond the documented freshness window the same cache must fail closed.
        svc.staleWindowMs = 0;
        await expectOutcome(svc.listBanks(), PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE, 'DIRECTORY_UNAVAILABLE');
    });
});

describe('Moolre bank payout adapter — account validation', () => {
    test('sends the documented channel, bank code and source account, and returns the provider name', async () => {
        const http = fakeHttp();
        const result = await service(http).validateBankAccount({ accountNumber: ACCOUNT, bankCode: '030100' });

        const call = http.calls.find((c) => c.url.endsWith('/validate'));
        expect(call.body).toEqual({
            type: 1,
            channel: '2',
            currency: 'GHS',
            receiver: ACCOUNT,
            sublistid: '030100',
            accountnumber: '100000100002',
        });
        expect(call.cfg.headers['X-API-USER']).toBe('api-user');
        expect(call.cfg.headers['X-API-KEY']).toBe('private-key');

        expect(result.valid).toBe(true);
        expect(result.accountName).toBe('BRIGHT BUAME');
        expect(result.bankCode).toBe('030100');
        expect(result.provider).toBe('MOOLRE');
        expect(typeof result.validatedAt).toBe('string');
    });

    test('a refused account is a definitive validation refusal, not a valid beneficiary', async () => {
        const http = fakeHttp({ validate: { status: 400, data: { status: 0, code: 'AVD02', message: 'Account not found', data: 'Account not found' } } });
        const err = await expectOutcome(service(http).validateBankAccount({ accountNumber: ACCOUNT, bankCode: '030100' }), PROVIDER_OUTCOMES.DEFINITIVE_REJECTION, 'ACCOUNT_NOT_VALID');
        expect(err.providerCode).toBe('AVD02');
    });

    test('an unknown bank code is refused before any provider write', async () => {
        const http = fakeHttp();
        await expectOutcome(service(http).validateBankAccount({ accountNumber: ACCOUNT, bankCode: '999999' }), PROVIDER_OUTCOMES.NOT_DISPATCHED, 'BANK_CODE_UNKNOWN');
        expect(http.calls.filter((c) => c.url.endsWith('/validate'))).toHaveLength(0);
    });

    test('validation never leaks the account number into results or logs', async () => {
        const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        const http = fakeHttp();
        const result = await service(http).validateBankAccount({ accountNumber: ACCOUNT, bankCode: '030100' });

        expect(JSON.stringify(result)).not.toContain(ACCOUNT);
        const logged = JSON.stringify(infoSpy.mock.calls);
        expect(logged).not.toContain(ACCOUNT);
        expect(logged).not.toContain('private-key');
        infoSpy.mockRestore();
    });
});

describe('Moolre bank payout adapter — transfer initiation', () => {
    test('sends the exact original reference, amount and bank routing fields', async () => {
        const http = fakeHttp();
        const result = await service(http).initiateBankTransfer({
            referenceId: 'wd-42',
            amountGhsExact: '25.50',
            recipientAccountNumber: ACCOUNT,
            bankCode: '030402',
            payeeNote: 'Withdrawal',
        });

        const call = transferCalls(http)[0];
        expect(call.body).toEqual({
            type: 1,
            channel: '2',
            currency: 'GHS',
            amount: '25.50',
            receiver: ACCOUNT,
            sublistid: '030402',
            externalref: 'wd-42',
            accountnumber: '100000100002',
            reference: 'Withdrawal',
        });
        expect(call.cfg.timeout).toBeGreaterThan(0);

        expect(result.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(result.referenceId).toBe('wd-42');
        expect(result.providerRef).toBe('32759150');
        expect(result.status).toBe('SUCCESSFUL');
        expect(result.currency).toBe('GHS');
        expect(result.amountGhsExact).toBe('25.50');
    });

    test('rejects malformed amounts without any wire request', async () => {
        const bad = ['0', '0.00', '-1', '1e3', '10.999', ' 1.00', '1,000', '1.2.3', '', '10000000000'];
        for (const amount of bad) {
            const http = fakeHttp();
            await expectOutcome(service(http).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: amount, recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.NOT_DISPATCHED);
            expect(transferCalls(http)).toHaveLength(0);
        }
        const http = fakeHttp();
        await expectOutcome(service(http).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: 25.5, recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.NOT_DISPATCHED, 'AMOUNT_NOT_STRING');
    });

    test('preserves provider fee fields exactly and never invents a fee total', async () => {
        const result = await service(fakeHttp()).initiateBankTransfer({
            referenceId: 'wd-42', amountGhsExact: '25.50', recipientAccountNumber: ACCOUNT, bankCode: '030402',
        });
        expect(result.fees).toEqual({ amountFee: '1.01', networkFee: '0.00', fee: '0.01' });
        expect(result.fees).not.toHaveProperty('total');
        expect(JSON.stringify(result)).not.toContain('1.02');
    });

    test('parses pending and string status envelopes from documented fields only', async () => {
        const pending = { status: 1, code: 'OBGH01', data: { txstatus: 0, externalref: 'wd-42', transactionid: '1' } };
        const result = await service(fakeHttp({ transfer: { status: 200, data: pending } })).initiateBankTransfer({
            referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402',
        });
        expect(result.status).toBe('PENDING');
    });

    test('a malformed success body is uncertainty, never a proven failure', async () => {
        const http = fakeHttp({ transfer: { status: 200, data: { status: 1, code: 'OBGH01', message: ['ok'] } } });
        await expectOutcome(service(http).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.UNKNOWN_OUTCOME, 'INITIATE_MALFORMED');
        expect(transferCalls(http)).toHaveLength(1);
    });

    test('a duplicate reference is its own outcome and issues no second transfer', async () => {
        const http = fakeHttp({ transfer: { status: 400, data: { status: 0, code: 'TP14', message: 'External reference already used' } } });
        await expectOutcome(service(http).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.DUPLICATE_REFERENCE, 'DUPLICATE_REFERENCE');
        expect(transferCalls(http)).toHaveLength(1);
    });

    test('classifies transport failures by whether bytes could have been sent', async () => {
        const refused = fakeHttp({ transferError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
        await expectOutcome(service(refused).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.NOT_DISPATCHED, 'TRANSPORT_PRE_DISPATCH');

        for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
            const http = fakeHttp({ transferError: Object.assign(new Error('timeout'), { code }) });
            await expectOutcome(service(http).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.UNKNOWN_OUTCOME, 'TRANSPORT_UNCERTAIN');
            expect(transferCalls(http)).toHaveLength(1);   // exactly one attempt
        }
    });

    test('5xx and unknown 4xx are uncertain; a documented refusal code is definitive', async () => {
        const server = fakeHttp({ transfer: { status: 502, data: {} } });
        await expectOutcome(service(server).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.UNKNOWN_OUTCOME, 'INITIATE_UNCERTAIN');

        const unknown4xx = fakeHttp({ transfer: { status: 418, data: { status: 0, code: 'ZZ99', message: 'teapot' } } });
        await expectOutcome(service(unknown4xx).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);

        const refused = fakeHttp({ transfer: { status: 400, data: { status: 0, code: 'TP01', message: 'Invalid amount' } } });
        await expectOutcome(service(refused).initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.DEFINITIVE_REJECTION, 'PROVIDER_REFUSED');
    });
});

describe('Moolre bank payout adapter — status lookup', () => {
    test('asks with the original external reference and idtype 1', async () => {
        const http = fakeHttp();
        const result = await service(http).getBankTransferStatus({ referenceId: 'wd-42' });

        const call = statusCalls(http)[0];
        expect(call.body).toEqual({ type: 1, idtype: 1, id: 'wd-42', accountnumber: '100000100002' });
        expect(result).toEqual({ status: 'SUCCESSFUL', referenceId: 'wd-42', providerRef: '31830714', providerStatusRaw: '1' });
    });

    test('maps numeric and string txstatus forms', async () => {
        for (const [raw, expected] of [[0, 'PENDING'], ['1', 'SUCCESSFUL'], [2, 'FAILED'], ['2', 'FAILED']]) {
            const http = fakeHttp({ status: { status: 200, data: { status: 1, code: 'SS01', data: { txstatus: raw, externalref: 'wd-42' } } } });
            const result = await service(http).getBankTransferStatus({ referenceId: 'wd-42' });
            expect(result.status).toBe(expected);
        }
    });

    test('an authoritative not-found stays NOT_FOUND', async () => {
        const http = fakeHttp({ status: { status: 400, data: { status: 0, code: 'SS02', message: 'Transaction not found', data: null } } });
        expect((await service(http).getBankTransferStatus({ referenceId: 'wd-42' })).status).toBe('NOT_FOUND');
    });

    test('auth failure, rate limit, malformed and 5xx answers are UNRESOLVED, never PENDING', async () => {
        const variants = [
            { status: 401, data: { status: 0, code: 'AU01', message: 'Invalid credentials' } },
            { status: 429, data: { status: 0, code: 'RL01', message: 'Rate limit' } },
            { status: 200, data: { status: 1, data: { unexpected: true } } },
            { status: 503, data: {} },
        ];
        for (const status of variants) {
            const http = fakeHttp({ status });
            const result = await service(http).getBankTransferStatus({ referenceId: 'wd-42' });
            expect(result.status).toBe('UNRESOLVED');
            expect(result.status).not.toBe('PENDING');
        }

        const timeout = fakeHttp({ statusError: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
        expect((await service(timeout).getBankTransferStatus({ referenceId: 'wd-42' })).status).toBe('UNRESOLVED');
    });

    test('a status lookup never issues a transfer', async () => {
        const http = fakeHttp();
        await service(http).getBankTransferStatus({ referenceId: 'wd-42' });
        expect(transferCalls(http)).toHaveLength(0);
    });
});

describe('Moolre bank payout adapter — configuration safety', () => {
    test('an unconfigured provider fails closed before any provider I/O', async () => {
        const http = fakeHttp();
        const svc = new MoolreBankPayoutService({ http, baseUrl: 'https://sandbox.moolre.com' });
        await expectOutcome(svc.initiateBankTransfer({ referenceId: 'wd-42', amountGhsExact: '1.00', recipientAccountNumber: ACCOUNT, bankCode: '030402' }), PROVIDER_OUTCOMES.NOT_DISPATCHED, 'PROVIDER_NOT_CONFIGURED');
        expect(http.calls).toHaveLength(0);
    });

    test('describe() exposes no credential or account number', () => {
        const svc = service(fakeHttp());
        const described = JSON.stringify(svc.describe());
        expect(described).not.toContain('private-key');
        expect(described).not.toContain('100000100002');
        expect(JSON.parse(described)).toMatchObject({ provider: 'MOOLRE', capability: 'BANK_PAYOUT', channel: 2, currency: 'GHS' });
    });

    test('the default base URL is sandbox unless production is explicitly configured', () => {
        const previous = process.env.MOOLRE_ENV;
        delete process.env.MOOLRE_ENV;
        expect(service(fakeHttp()).baseUrl).toBe('https://sandbox.moolre.com');
        process.env.MOOLRE_ENV = 'production';
        expect(service(fakeHttp(), { baseUrl: undefined }).baseUrl).toBe('https://api.moolre.com');
        if (previous === undefined) delete process.env.MOOLRE_ENV; else process.env.MOOLRE_ENV = previous;
    });
});
