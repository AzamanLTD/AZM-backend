// Provider-boundary tests for the Moolre Ghana BANK PAYOUT adapter (channel 2).
//
// FIXTURE TESTS ONLY. HTTP is faked at the adapter boundary; no request leaves
// this process and no sandbox credential is used. Anything about Azaman's
// commercial eligibility for channel 2, real bank coverage, limits, fees, SLA
// or the /initiate-vs-/transfer path conflict is NOT proven here.

const MoolreBankPayoutService = require('../services/moolreBankPayoutService');
const { PROVIDER_OUTCOMES, MoolreBankPayoutError } = MoolreBankPayoutService;

const REF = 'AZM-WD-000123';

const directoryBody = {
    status: 1,
    code: 'SD01',
    message: 'Banks retrieved',
    data: [
        { name: 'ACCESS BANK GHANA LTD', code: '030402' },
        { name: 'ABSA BANK GHANA LTD', code: '030100' },
        { name: 'ADB BANK GHANA LTD', code: '030301' },
        { name: 'ADB BANK GHANA LTD', code: '030301' },
    ],
};

const acceptedTransfer = {
    status: '1',
    code: 'OBGH01',
    message: ['Pay out Successful'],
    data: {
        txstatus: 1,
        receiver: '0123456789012',
        transactionid: '32759150',
        externalref: REF,
        thirdpartyref: '901733241086',
        receivername: 'AKOSUA MENSAH',
        amount: '25.50',
        amountfee: '1.01',
        networkfee: '0.00',
        fee: '0.01',
    },
};

const statusBody = {
    status: 1,
    code: 'SS01',
    message: 'Transaction Successful',
    data: {
        txstatus: 1,
        txtype: 2,
        accountnumber: '100000100002',
        payee: '0123456789012',
        amount: '25.50',
        transactionid: '31830714',
        externalref: REF,
        thirdpartyref: '141704447750',
    },
};

function transportError(code) {
    return Object.assign(new Error('transport ' + code), { code });
}

function fakeHttp(over = {}) {
    const calls = [];
    const http = {
        calls,
        get: async (url, cfg) => {
            calls.push({ method: 'GET', url, cfg });
            if (over.directoryError) throw over.directoryError;
            return over.directory ?? { status: 200, data: directoryBody };
        },
        post: async (url, body, cfg) => {
            calls.push({ method: 'POST', url, body, cfg });
            if (url.endsWith('/validate')) {
                if (over.validateError) throw over.validateError;
                return over.validate ?? { status: 200, data: { status: 1, code: 'AVD01', message: 'Successful', data: 'AKOSUA MENSAH' } };
            }
            if (url.endsWith('/transfer')) {
                if (over.transferError) throw over.transferError;
                return over.transfer ?? { status: 200, data: acceptedTransfer };
            }
            if (url.endsWith('/status')) {
                if (over.statusError) throw over.statusError;
                return over.status ?? { status: 200, data: statusBody };
            }
            throw new Error('unexpected path ' + url);
        },
    };
    http.transfers = () => calls.filter(c => c.url.endsWith('/transfer'));
    http.validations = () => calls.filter(c => c.url.endsWith('/validate'));
    http.statuses = () => calls.filter(c => c.url.endsWith('/status'));
    return http;
}

function service(http, opts = {}) {
    return new MoolreBankPayoutService({
        http,
        providerMode: 'LIVE',
        bankPayoutEnabled: true,
        env: 'sandbox',
        apiUser: 'api-user',
        apiKey: 'private-key',
        accountNumber: '100000100002',
        ...opts,
    });
}

/** Await a rejection and return the typed provider error. */
async function rejectOf(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected the adapter to refuse, but it resolved');
}

const baseInitiation = {
    referenceId: REF,
    amountGhsExact: '25.50',
    recipientAccountNumber: '0123456789012',
    bankCode: '030100',
};

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

// ── A. interface contract ───────────────────────────────────────────────────
describe('A. provider interface', () => {
    test('listBanks returns the agreed shape with string-only bank codes', async () => {
        const http = fakeHttp();
        const out = await service(http).listBanks();
        expect(out).toMatchObject({ source: 'MOOLRE', stale: false });
        expect(typeof out.retrievedAt).toBe('string');
        expect(Number.isInteger(out.cacheAgeMs)).toBe(true);
        out.banks.forEach(b => {
            expect(typeof b.code).toBe('string');
            expect(typeof b.name).toBe('string');
        });
    });

    test('validateBankAccount takes exactly { accountNumber, bankCode }', async () => {
        const http = fakeHttp();
        const out = await service(http).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' });
        expect(out).toEqual({
            valid: true,
            accountName: 'AKOSUA MENSAH',
            bankCode: '030100',
            validatedAt: expect.any(String),
            provider: 'MOOLRE',
        });
    });

    test('initiateBankTransfer accepts the canonical contract', async () => {
        const http = fakeHttp();
        const out = await service(http).initiateBankTransfer({ ...baseInitiation });
        expect(out.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(out.rail).toBe('BANK');
        expect(out.referenceId).toBe(REF);
    });

    test('initiateBankTransfer accepts the settled consumer call shape (aliases)', async () => {
        const http = fakeHttp();
        const out = await service(http).initiateBankTransfer({
            referenceId: REF,
            externalId: REF,
            amountGhs: '25.50',
            bankCode: '030100',
            accountNumber: '0123456789012',
            accountName: 'IGNORED CLIENT NAME',
            narration: 'Azaman payout ' + REF,
        });
        expect(out.status).toBe('SUCCESSFUL');
        const body = http.transfers()[0].body;
        expect(body.amount).toBe('25.50');
        expect(body.receiver).toBe('0123456789012');
        expect(body.reference).toBe('Azaman payout ' + REF);
    });

    test('conflicting canonical and alias values are refused, never resolved', async () => {
        const http = fakeHttp();
        const err = await rejectOf(service(http).initiateBankTransfer({
            ...baseInitiation,
            amountGhs: '99.99',
        }));
        expect(err).toBeInstanceOf(MoolreBankPayoutError);
        expect(err.code).toBe('ARGUMENT_ALIAS_CONFLICT');
        expect(http.transfers()).toHaveLength(0);
    });

    test('getBankTransferStatus takes exactly { referenceId }', async () => {
        const http = fakeHttp();
        const out = await service(http).getBankTransferStatus({ referenceId: REF });
        expect(out).toMatchObject({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId: REF });
    });

    test('describe() is accurate and carries no secret or account number', () => {
        const d = service(fakeHttp()).describe();
        expect(d).toEqual({
            provider: 'MOOLRE',
            capability: 'BANK_PAYOUT',
            mode: 'sandbox',
            baseUrlHost: 'sandbox.moolre.com',
            providerIoEnabled: true,
            bankPayoutEnabled: true,
            credentialsPresent: true,
            sourceAccountConfigured: true,
            channel: 2,
            currency: 'GHS',
        });
        const s = JSON.stringify(d);
        expect(s).not.toContain('private-key');
        expect(s).not.toContain('100000100002');
        expect(s).not.toContain('api-user');
    });

    test('every status object identifies provider and rail, and never generates a reference', async () => {
        const http = fakeHttp({ status: { status: 200, data: { status: 0, code: 'SS00', message: 'unknown' } } });
        const out = await service(http).getBankTransferStatus({ referenceId: REF });
        expect(out.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(out.rail).toBe('BANK');
        expect(out.referenceId).toBe(REF);
        expect(out.status).toBe('UNRESOLVED');
    });

    test('externalId is the echoed Moolre externalref, never a generated one', async () => {
        const out = await service(fakeHttp()).initiateBankTransfer({ ...baseInitiation });
        expect(out.externalId).toBe(REF);
        const st = await service(fakeHttp()).getBankTransferStatus({ referenceId: REF });
        expect(st.externalId).toBe(REF);
    });

    test('amountGhsExact is the provider-reported amount, not the caller amount', async () => {
        const transfer = JSON.parse(JSON.stringify(acceptedTransfer));
        transfer.data.amount = '24.00';
        const out = await service(fakeHttp({ transfer: { status: 200, data: transfer } }))
            .initiateBankTransfer({ ...baseInitiation });
        expect(out.amountGhsExact).toBe('24.00');
    });
});

// ── B. bank directory ───────────────────────────────────────────────────────
describe('B. bank directory', () => {
    test('maps names/codes, preserves leading zeroes, dedupes and sorts deterministically', async () => {
        const out = await service(fakeHttp()).listBanks();
        expect(out.banks.map(b => b.code)).toEqual(['030100', '030301', '030402']);
        expect(out.banks[0].code.startsWith('0')).toBe(true);
        expect(out.banks.filter(b => b.code === '030301')).toHaveLength(1);
    });

    test('normalises display whitespace only', async () => {
        const directory = { status: 200, data: { status: 1, data: [{ name: '  ADB   BANK  ', code: '030301' }] } };
        const out = await service(fakeHttp({ directory })).listBanks();
        expect(out.banks[0].name).toBe('ADB BANK');
    });

    test.each([
        ['empty data', { status: 200, data: { status: 1, data: [] } }, 'DIRECTORY_SHAPE'],
        ['null data', { status: 200, data: { status: 1, data: null } }, 'DIRECTORY_SHAPE'],
        ['envelope failure', { status: 200, data: { status: 0, message: 'nope' } }, 'DIRECTORY_UNAVAILABLE'],
        ['non-object body', { status: 200, data: 'not json' }, 'DIRECTORY_UNAVAILABLE'],
        ['malformed row', { status: 200, data: { status: 1, data: [{ name: '', code: '030301' }] } }, 'DIRECTORY_ROW_MALFORMED'],
    ])('rejects %s instead of inventing banks', async (_label, directory, code) => {
        const err = await rejectOf(service(fakeHttp({ directory })).listBanks());
        expect(err).toBeInstanceOf(MoolreBankPayoutError);
        expect(err.code).toBe(code);
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE);
    });

    test('serves a fresh cache without a second network call', async () => {
        const http = fakeHttp();
        const svc = service(http);
        await svc.listBanks();
        await svc.listBanks();
        expect(http.calls.filter(c => c.method === 'GET')).toHaveLength(1);
    });

    test('forceRefresh bypasses the cache', async () => {
        const http = fakeHttp();
        const svc = service(http);
        await svc.listBanks();
        await svc.listBanks({ forceRefresh: true });
        expect(http.calls.filter(c => c.method === 'GET')).toHaveLength(2);
    });

    test('an outage with a fresh cache is returned explicitly as stale', async () => {
        const http = fakeHttp();
        const svc = service(http);
        await svc.listBanks();
        http.get = async () => { throw transportError('ECONNREFUSED'); };
        const out = await svc.listBanks({ forceRefresh: true });
        expect(out.stale).toBe(true);
        expect(out.banks).toHaveLength(3);
        expect(out.cacheAgeMs).toBeGreaterThanOrEqual(0);
    });

    test('an outage beyond the stale window fails closed', async () => {
        const http = fakeHttp();
        const svc = service(http);
        await svc.listBanks();
        http.get = async () => { throw transportError('ECONNREFUSED'); };
        svc._staleWindowMs = 0;
        const err = await rejectOf(svc.listBanks({ forceRefresh: true }));
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE);
    });

    test('stale directory data is refused for validation and transfer', async () => {
        const http = fakeHttp();
        const svc = service(http, { cacheTtlMs: 0 });
        await svc.listBanks();
        http.get = async () => { throw transportError('ECONNREFUSED'); };
        const vErr = await rejectOf(svc.validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' }));
        expect(vErr.code).toBe('DIRECTORY_STALE');
        expect(http.validations()).toHaveLength(0);
        const tErr = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(tErr.code).toBe('DIRECTORY_STALE');
        expect(http.transfers()).toHaveLength(0);
    });

    test('never puts a credential in the directory URL', async () => {
        const http = fakeHttp();
        await service(http).listBanks();
        const get = http.calls.find(c => c.method === 'GET');
        expect(get.url).toBe('https://sandbox.moolre.com/open/transact/data?country=gha&data=banks');
        expect(get.url).not.toContain('private-key');
        expect(get.url).not.toContain('api-user');
    });
});

// ── C. validation ───────────────────────────────────────────────────────────
describe('C. account validation', () => {
    test('sends the documented fields and the account number exactly', async () => {
        const http = fakeHttp();
        await service(http).validateBankAccount({ accountNumber: '0012345678', bankCode: '030100' });
        const call = http.validations()[0];
        expect(call.url).toBe('https://sandbox.moolre.com/open/transact/validate');
        expect(call.body).toEqual({
            type: 1,
            channel: '2',
            currency: 'GHS',
            receiver: '0012345678',
            sublistid: '030100',
            accountnumber: '100000100002',
        });
        expect(call.cfg.headers['X-API-USER']).toBe('api-user');
        expect(call.cfg.headers['X-API-KEY']).toBe('private-key');
    });

    test('parses the documented string data as the account name', async () => {
        const out = await service(fakeHttp()).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' });
        expect(out.accountName).toBe('AKOSUA MENSAH');
    });

    test('AVD01 is a successful validation, never an initiation refusal', async () => {
        const out = await service(fakeHttp()).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' });
        expect(out.valid).toBe(true);
    });

    test('AVD02 is a documented validation refusal', async () => {
        const http = fakeHttp({ validate: { status: 200, data: { status: 0, code: 'AVD02', message: 'Account not found' } } });
        const err = await rejectOf(service(http).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' }));
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.DEFINITIVE_REJECTION);
        expect(err.code).toBe('ACCOUNT_NOT_FOUND');
        expect(err.dispatchProven).toBe(true);
    });

    test.each([
        ['auth failure', { validate: { status: 401, data: { status: 0, code: 'AUTH', message: 'bad key' } } }],
        ['rate limit', { validate: { status: 429, data: { status: 0, code: 'RATE', message: 'slow down' } } }],
        ['5xx', { validate: { status: 502, data: {} } }],
        ['malformed', { validate: { status: 200, data: 'oops' } }],
        ['transport reset', { validateError: transportError('ECONNRESET') }],
    ])('%s is provider unavailability, not an invalid account', async (_label, over) => {
        const err = await rejectOf(service(fakeHttp(over)).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' }));
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.PROVIDER_UNAVAILABLE);
        expect(err.outcome).not.toBe(PROVIDER_OUTCOMES.DEFINITIVE_REJECTION);
    });

    test('an unknown bank code never reaches the provider', async () => {
        const http = fakeHttp();
        const err = await rejectOf(service(http).validateBankAccount({ accountNumber: '0123456789012', bankCode: '999999' }));
        expect(err.code).toBe('BANK_CODE_UNKNOWN');
        expect(http.validations()).toHaveLength(0);
    });

    test('the account number is neither returned nor logged', async () => {
        const logger = require('../src/config/logger');
        const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const out = await service(fakeHttp()).validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' });
        expect(JSON.stringify(out)).not.toContain('0123456789012');
        const logged = JSON.stringify(info.mock.calls.concat(warn.mock.calls));
        expect(logged).not.toContain('0123456789012');
        info.mockRestore(); warn.mockRestore();
    });

    test('a client-supplied account name is not accepted as evidence', async () => {
        const out = await service(fakeHttp()).validateBankAccount({
            accountNumber: '0123456789012', bankCode: '030100', accountName: 'SOMEONE ELSE',
        });
        expect(out.accountName).toBe('AKOSUA MENSAH');
    });

    test('drops and rejects an account number outside the documented Azaman safety bound', async () => {
        const http = fakeHttp();
        const err = await rejectOf(service(http).validateBankAccount({ accountNumber: 'ABC123', bankCode: '030100' }));
        expect(err.code).toBe('ACCOUNT_NUMBER_INVALID');
        expect(err.message).toContain('Azaman safety bound');
        expect(http.validations()).toHaveLength(0);
    });
});

// ── D. transfer precision, identity and fees ────────────────────────────────
describe('D. transfer initiation', () => {
    test('sends the documented body with the original reference verbatim', async () => {
        const http = fakeHttp();
        await service(http).initiateBankTransfer({ ...baseInitiation, payerMessage: 'Rent' });
        const body = http.transfers()[0].body;
        expect(body).toEqual({
            type: 1,
            channel: '2',
            currency: 'GHS',
            amount: '25.50',
            receiver: '0123456789012',
            sublistid: '030100',
            externalref: REF,
            accountnumber: '100000100002',
            reference: 'Rent',
        });
    });

    test.each([
        ['zero', '0', 'AMOUNT_NOT_POSITIVE'],
        ['zero decimals', '0.00', 'AMOUNT_NOT_POSITIVE'],
        ['negative', '-5.00', 'AMOUNT_MALFORMED'],
        ['exponent', '1e3', 'AMOUNT_MALFORMED'],
        ['whitespace', ' 25.50', 'AMOUNT_MALFORMED'],
        ['overprecision', '25.505', 'AMOUNT_MALFORMED'],
        ['thousands separator', '1,000.00', 'AMOUNT_MALFORMED'],
        ['leading zeroes', '025.50', 'AMOUNT_MALFORMED'],
        ['number type', 25.5, 'AMOUNT_NOT_STRING'],
        ['above safety bound', '1000000.01', 'AMOUNT_ABOVE_SAFETY_BOUND'],
    ])('rejects %s before any wire request', async (_label, amount, code) => {
        const http = fakeHttp();
        const err = await rejectOf(service(http).initiateBankTransfer({ ...baseInitiation, amountGhsExact: amount }));
        expect(err).toBeInstanceOf(MoolreBankPayoutError);
        expect(err.code).toBe(code);
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
        expect(http.transfers()).toHaveLength(0);
    });

    test('accepts an exact whole-cedi amount and canonicalises to two decimals', async () => {
        const http = fakeHttp();
        await service(http).initiateBankTransfer({ ...baseInitiation, amountGhsExact: '25' });
        expect(http.transfers()[0].body.amount).toBe('25.00');
    });

    test('preserves leading zeroes in the recipient account number', async () => {
        const http = fakeHttp();
        await service(http).initiateBankTransfer({ ...baseInitiation, recipientAccountNumber: '0012345678' });
        expect(http.transfers()[0].body.receiver).toBe('0012345678');
    });

    test('an unknown bank code is refused before dispatch', async () => {
        const http = fakeHttp();
        const err = await rejectOf(service(http).initiateBankTransfer({ ...baseInitiation, bankCode: '777777' }));
        expect(err.code).toBe('BANK_CODE_UNKNOWN');
        expect(http.transfers()).toHaveLength(0);
    });

    test('a duplicate response issues exactly one POST and is never retried', async () => {
        const http = fakeHttp({
            transfer: { status: 200, data: { status: 0, code: 'TP13', message: 'Duplicate external reference' } },
        });
        const out = await service(http).initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe('DUPLICATE_REFERENCE');
        expect(http.transfers()).toHaveLength(1);
    });

    test('keeps every provider fee separate and invents no total', async () => {
        const out = await service(fakeHttp()).initiateBankTransfer({ ...baseInitiation });
        expect(out.fees).toEqual({ amountFee: '1.01', networkFee: '0.00', fee: '0.01' });
        expect(Object.keys(out.fees)).toEqual(['amountFee', 'networkFee', 'fee']);
    });

    test('a malformed fee field becomes null without changing the outcome', async () => {
        const transfer = JSON.parse(JSON.stringify(acceptedTransfer));
        transfer.data.amountfee = 'n/a';
        const out = await service(fakeHttp({ transfer: { status: 200, data: transfer } }))
            .initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('SUCCESSFUL');
        expect(out.fees.amountFee).toBeNull();
        expect(out.fees.networkFee).toBe('0.00');
    });

    test('a mismatched echoed reference is an evidence contradiction', async () => {
        const transfer = JSON.parse(JSON.stringify(acceptedTransfer));
        transfer.data.externalref = 'SOMEONE-ELSES-REF';
        const out = await service(fakeHttp({ transfer: { status: 200, data: transfer } }))
            .initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe('EXTERNAL_REFERENCE_MISMATCH');
        expect(out.referenceId).toBe(REF);
    });

    test('an unrecognised nested status is never reported as success', async () => {
        const transfer = JSON.parse(JSON.stringify(acceptedTransfer));
        transfer.data.txstatus = 7;
        const out = await service(fakeHttp({ transfer: { status: 200, data: transfer } }))
            .initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.providerStatusRaw).toBe('7');
    });

    test('an unproven nested status is an unresolved observation that keeps every provider fact', async () => {
        const transfer = JSON.parse(JSON.stringify(acceptedTransfer));
        transfer.data.txstatus = 0;
        const out = await service(fakeHttp({ transfer: { status: 200, data: transfer } }))
            .initiateBankTransfer({ ...baseInitiation });

        // 0 has no published meaning for a transfer response, so it may be
        // reported neither as success nor as failure.
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe('STATUS_SEMANTICS_UNPROVEN');
        expect(out.providerStatusRaw).toBe('0');
        expect(out.externalId).toBe(REF);
        expect(out.providerRef).toBe('32759150');
        expect(out.amountGhsExact).toBe('25.50');
        expect(out.fees).toEqual({ amountFee: '1.01', networkFee: '0.00', fee: '0.01' });
    });
});

// ── E. outcome classification ───────────────────────────────────────────────
describe('E. outcome classification', () => {
    test.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
        '%s is proven pre-dispatch and safe to reverse',
        async (code) => {
            const err = await rejectOf(service(fakeHttp({ transferError: transportError(code) }))
                .initiateBankTransfer({ ...baseInitiation }));
            expect(err.outcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
            expect(err.dispatchProven).toBe(true);
            expect(err.retryable).toBe(false);
        }
    );

    test.each(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ERR_BAD_RESPONSE'])(
        '%s after a possible send is an unknown outcome, not a refusal',
        async (code) => {
            const out = await service(fakeHttp({ transferError: transportError(code) }))
                .initiateBankTransfer({ ...baseInitiation });
            expect(out.status).toBe('UNRESOLVED');
            expect(out.reason).toBe('PROVIDER_OUTCOME_UNKNOWN');
        }
    );

    test.each([
        ['5xx', { transfer: { status: 503, data: { status: 0, message: 'upstream' } } }, 'PROVIDER_NON_2XX'],
        ['unknown 4xx', { transfer: { status: 400, data: { status: 0, code: 'XX01', message: 'bad request' } } }, 'PROVIDER_NON_2XX'],
        ['malformed 200', { transfer: { status: 200, data: 'not json' } }, 'MALFORMED_PROVIDER_RESPONSE'],
        ['envelope refusal without evidence', { transfer: { status: 200, data: { status: 0, code: 'TP99', message: 'insufficient float' } } }, 'PROVIDER_STATUS_NOT_ACCEPTED'],
    ])('%s stays UNRESOLVED rather than being called a refusal', async (_label, over, reason) => {
        const out = await service(fakeHttp(over)).initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe(reason);
    });

    test('an untyped transport error is never classified as a definitive rejection', async () => {
        const out = await service(fakeHttp({ transferError: new Error('socket hang up') }))
            .initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
    });

    test('AVD01 is never used to classify an initiation refusal', async () => {
        const out = await service(fakeHttp({
            transfer: { status: 200, data: { status: 0, code: 'AVD01', message: 'Successful' } },
        })).initiateBankTransfer({ ...baseInitiation });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe('PROVIDER_STATUS_NOT_ACCEPTED');
    });

    test('the error contract carries the shared property names', async () => {
        const err = await rejectOf(service(fakeHttp()).initiateBankTransfer({ ...baseInitiation, bankCode: '999999' }));
        expect(err.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(err.outcome).toBe(err.providerOutcome);
        expect(err.stage).toBe('INITIATE');
        expect(err.referenceId).toBe(REF);
        expect(err.retryable).toBe(false);
        expect(typeof err.code).toBe('string');
    });

    test('no ambiguous error leaks the raw provider body or credentials', async () => {
        const out = await service(fakeHttp({ transfer: { status: 500, data: { secretish: 'x', message: 'boom' } } }))
            .initiateBankTransfer({ ...baseInitiation });
        const s = JSON.stringify(out);
        expect(s).not.toContain('private-key');
        expect(s).not.toContain('100000100002');
        expect(s).not.toContain('0123456789012');
    });
});

// ── F. status ───────────────────────────────────────────────────────────────
describe('F. transfer status', () => {
    test('sends idtype 1 with the original reference and the source account', async () => {
        const http = fakeHttp();
        await service(http).getBankTransferStatus({ referenceId: REF });
        const call = http.statuses()[0];
        expect(call.url).toBe('https://sandbox.moolre.com/open/transact/status');
        expect(call.body).toEqual({ type: 1, idtype: 1, id: REF, accountnumber: '100000100002' });
        expect(call.cfg.headers['X-API-USER']).toBe('api-user');
    });

    test.each([[1, 'SUCCESSFUL'], ['1', 'SUCCESSFUL']])(
        'maps the one documented success value %p to %s',
        async (raw, expected) => {
            const body = JSON.parse(JSON.stringify(statusBody));
            body.data.txstatus = raw;
            const out = await service(fakeHttp({ status: { status: 200, data: body } }))
                .getBankTransferStatus({ referenceId: REF });
            expect(out.status).toBe(expected);
            expect(out.providerStatusRaw).toBe('1');
        },
    );

    // The 0/1/2 triple is a List Transactions FILTER vocabulary. Reusing it as a
    // transfer-status mapping would turn an unproven value into a refund order.
    test.each([[0], ['0'], [2], ['2'], [3], ['9']])(
        'txstatus %p has no published transfer meaning and stays UNRESOLVED',
        async (raw) => {
            const body = JSON.parse(JSON.stringify(statusBody));
            body.data.txstatus = raw;
            const out = await service(fakeHttp({ status: { status: 200, data: body } }))
                .getBankTransferStatus({ referenceId: REF });
            expect(out.status).toBe('UNRESOLVED');
            expect(out.reason).toBe('STATUS_UNRECOGNISED');
            expect(out.providerStatusRaw).toBe(String(raw));
            expect(['PENDING', 'FAILED']).not.toContain(out.status);
        },
    );

    test('no status path can ever produce PENDING or FAILED', async () => {
        for (const raw of [0, '0', 1, '1', 2, '2', 7, 'unexpected', null, undefined, '']) {
            const body = JSON.parse(JSON.stringify(statusBody));
            if (raw === null || raw === undefined || raw === '') {
                delete body.data.txstatus;
            } else {
                body.data.txstatus = raw;
            }
            const out = await service(fakeHttp({ status: { status: 200, data: body } }))
                .getBankTransferStatus({ referenceId: REF });
            expect(['SUCCESSFUL', 'UNRESOLVED']).toContain(out.status);
        }
    });

    test('a numeric provider amount is rejected rather than laundered into evidence', async () => {
        const body = JSON.parse(JSON.stringify(statusBody));
        body.data.amount = 25.5;
        const out = await service(fakeHttp({ status: { status: 200, data: body } }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.status).toBe('SUCCESSFUL');
        expect(out.amountGhsExact).toBeNull();
    });

    test('malformed and overprecision provider amounts are not fabricated', async () => {
        for (const bad of ['25.505', '1e3', '2,5.00', '-1.00', 'abc', true, {}, []]) {
            const body = JSON.parse(JSON.stringify(statusBody));
            body.data.amount = bad;
            const out = await service(fakeHttp({ status: { status: 200, data: body } }))
                .getBankTransferStatus({ referenceId: REF });
            expect(out.amountGhsExact).toBeNull();
        }
    });

    test('surrounding transport whitespace is trimmed, not turned into a different number', async () => {
        const body = JSON.parse(JSON.stringify(statusBody));
        body.data.amount = ' 25.50 ';
        const out = await service(fakeHttp({ status: { status: 200, data: body } }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.amountGhsExact).toBe('25.50');
    });

    test('fees stay separate exact strings and are never summed or filled in', async () => {
        const body = JSON.parse(JSON.stringify(statusBody));
        body.data.amountfee = 1.01;
        body.data.networkfee = null;
        delete body.data.fee;
        const out = await service(fakeHttp({ status: { status: 200, data: body } }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.amountGhsExact).toBe('25.50');
        expect(out).not.toHaveProperty('fees');
    });

    test('retains externalref, transactionid, thirdpartyref and amount evidence', async () => {
        const out = await service(fakeHttp()).getBankTransferStatus({ referenceId: REF });
        expect(out).toMatchObject({
            status: 'SUCCESSFUL',
            referenceId: REF,
            externalId: REF,
            providerRef: '31830714',
            amountGhsExact: '25.50',
            currency: 'GHS',
        });
    });

    test.each([
        ['missing txstatus', { status: 200, data: { status: 1, data: {} } }, 'STATUS_FIELD_MISSING'],
        ['unrecognised txstatus', { status: 200, data: { status: 1, data: { txstatus: 9 } } }, 'STATUS_UNRECOGNISED'],
        ['auth failure', { status: 401, data: { status: 0, code: 'AUTH', message: 'bad key' } }, 'PROVIDER_STATUS_NOT_ACCEPTED'],
        ['rate limit', { status: 429, data: { status: 0, code: 'RATE' } }, 'PROVIDER_STATUS_NOT_ACCEPTED'],
        ['malformed body', { status: 200, data: 'nope' }, 'MALFORMED_PROVIDER_RESPONSE'],
        ['not-found-shaped response with no published code', { status: 200, data: { status: 0, code: 'SS99', message: 'Transaction not found' } }, 'PROVIDER_STATUS_NOT_ACCEPTED'],
    ])('%s becomes UNRESOLVED, never PENDING or NOT_FOUND', async (_label, response, reason) => {
        const out = await service(fakeHttp({ status: response })).getBankTransferStatus({ referenceId: REF });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe(reason);
    });

    test('a transport failure during status is UNRESOLVED, not a failed payout', async () => {
        const out = await service(fakeHttp({ statusError: transportError('ETIMEDOUT') }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.status).toBe('UNRESOLVED');
    });

    test('a status mismatch on the echoed reference is UNRESOLVED', async () => {
        const body = JSON.parse(JSON.stringify(statusBody));
        body.data.externalref = 'OTHER-REF';
        const out = await service(fakeHttp({ status: { status: 200, data: body } }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.reason).toBe('EXTERNAL_REFERENCE_MISMATCH');
    });

    test('status lookups never issue a transfer POST', async () => {
        const http = fakeHttp();
        await service(http).getBankTransferStatus({ referenceId: REF });
        expect(http.transfers()).toHaveLength(0);
    });

    test('NOT_FOUND is only reachable with a published code (none verified today)', async () => {
        const out = await service(fakeHttp({ status: { status: 200, data: { status: 0, code: 'SS99' } } }))
            .getBankTransferStatus({ referenceId: REF });
        expect(out.status).toBe('UNRESOLVED');
        expect(out.status).not.toBe('NOT_FOUND');
    });
});

// ── G. live-mode and production safety ──────────────────────────────────────
describe('G. configuration gate', () => {
    const good = { apiUser: 'u', apiKey: 'k', accountNumber: '100000100002' };

    test('MOOLRE_PROVIDER=MOCK with a production URL and credentials does no provider I/O', async () => {
        const http = fakeHttp();
        const svc = new MoolreBankPayoutService({
            http, providerMode: 'MOCK', bankPayoutEnabled: true, env: 'production',
            baseUrl: 'https://api.moolre.com', ...good,
        });
        const err = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
        expect(err.code).toBe('PROVIDER_IO_DISABLED');
        expect(http.calls).toHaveLength(0);
        expect(svc.describe().mode).toBe('disabled');
    });

    test('a missing MOOLRE_PROVIDER means no provider I/O', async () => {
        const http = fakeHttp();
        const svc = new MoolreBankPayoutService({ http, providerMode: '', bankPayoutEnabled: true, ...good });
        const err = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(err.code).toBe('PROVIDER_IO_DISABLED');
        expect(http.calls).toHaveLength(0);
    });

    test('LIVE with the bank flag off disables bank payouts only', async () => {
        const http = fakeHttp();
        const svc = new MoolreBankPayoutService({ http, providerMode: 'LIVE', bankPayoutEnabled: false, ...good });
        const err = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(err.code).toBe('BANK_PAYOUT_DISABLED');
        expect(err.outcome).toBe(PROVIDER_OUTCOMES.NOT_DISPATCHED);
        expect(http.calls).toHaveLength(0);
        expect(svc.describe()).toMatchObject({ mode: 'disabled', providerIoEnabled: true, bankPayoutEnabled: false });
    });

    test('the flag is read from MOOLRE_BANK_PAYOUT_ENABLED by default and is off unless exactly true', async () => {
        const saved = { p: process.env.MOOLRE_PROVIDER, f: process.env.MOOLRE_BANK_PAYOUT_ENABLED };
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_BANK_PAYOUT_ENABLED = 'yes';
        const svc = new MoolreBankPayoutService({ http: fakeHttp(), ...good });
        expect(svc.describe().bankPayoutEnabled).toBe(false);
        process.env.MOOLRE_BANK_PAYOUT_ENABLED = 'true';
        expect(new MoolreBankPayoutService({ http: fakeHttp(), ...good }).describe().bankPayoutEnabled).toBe(true);
        process.env.MOOLRE_PROVIDER = saved.p;
        process.env.MOOLRE_BANK_PAYOUT_ENABLED = saved.f;
        if (saved.p === undefined) delete process.env.MOOLRE_PROVIDER;
        if (saved.f === undefined) delete process.env.MOOLRE_BANK_PAYOUT_ENABLED;
    });

    test('a non-allowlisted host disables the capability even when everything else is set', async () => {
        const http = fakeHttp();
        const svc = service(http, { baseUrl: 'https://moolre.evil.example' });
        const err = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(err.code).toBe('PROVIDER_HOST_NOT_ALLOWED');
        expect(http.calls).toHaveLength(0);
    });

    test.each([
        ['credentials missing', { apiUser: '', apiKey: '' }, 'PROVIDER_CREDENTIALS_MISSING'],
        ['source account missing', { accountNumber: '' }, 'PROVIDER_SOURCE_ACCOUNT_MISSING'],
    ])('%s fails closed before any I/O', async (_label, override, code) => {
        const http = fakeHttp();
        const svc = service(http, override);
        const err = await rejectOf(svc.initiateBankTransfer({ ...baseInitiation }));
        expect(err.code).toBe(code);
        expect(http.calls).toHaveLength(0);
    });

    test('injecting a fake http client never enables a disabled adapter', async () => {
        const http = fakeHttp();
        const svc = new MoolreBankPayoutService({ http, providerMode: 'MOCK', bankPayoutEnabled: false });
        await rejectOf(svc.listBanks());
        await rejectOf(svc.validateBankAccount({ accountNumber: '0123456789012', bankCode: '030100' }));
        await rejectOf(svc.getBankTransferStatus({ referenceId: REF }));
        expect(http.calls).toHaveLength(0);
    });

    test('every method shares the same gate; describe() reports the resulting mode', async () => {
        const http = fakeHttp();
        const svc = service(http, { env: 'production', baseUrl: 'https://api.moolre.com' });
        expect(svc.describe()).toMatchObject({ mode: 'production', baseUrlHost: 'api.moolre.com' });
        await svc.listBanks();
        expect(http.calls[0].url.startsWith('https://api.moolre.com/')).toBe(true);
    });
});

// ── I. capabilities() preflight contract ────────────────────────────────────
describe('I. capabilities() preflight contract', () => {
    test('exposes the agreed shape and nothing secret', () => {
        const c = service(fakeHttp()).capabilities();
        expect(Object.keys(c).sort()).toEqual([
            'bankPayoutEnabled',
            'canInitiateBankPayout',
            'credentialsPresent',
            'host',
            'hostAllowed',
            'mode',
            'providerIoEnabled',
            'sourceAccountConfigured',
        ]);
        expect(c).toMatchObject({
            providerIoEnabled: true,
            bankPayoutEnabled: true,
            credentialsPresent: true,
            sourceAccountConfigured: true,
            hostAllowed: true,
            canInitiateBankPayout: true,
            mode: 'sandbox',
        });
        const serialised = JSON.stringify(c);
        expect(serialised).not.toContain('api-key');
        expect(serialised).not.toContain('100000100002');
    });

    test('the capability boolean is the only thing a consumer may gate on', async () => {
        for (const override of [
            { providerMode: 'MOCK' },
            { providerMode: '' },
            { bankPayoutEnabled: false },
            { apiKey: '' },
            { accountNumber: '' },
            { baseUrl: 'https://not-moolre.example.com' },
        ]) {
            const http = fakeHttp();
            const svc = service(http, override);
            expect(svc.capabilities().canInitiateBankPayout).toBe(false);
            await expect(svc.initiateBankTransfer({ ...baseInitiation })).rejects.toMatchObject({
                outcome: 'NOT_DISPATCHED',
                dispatchProven: true,
            });
            expect(http.transfers()).toHaveLength(0);
        }
    });
});
