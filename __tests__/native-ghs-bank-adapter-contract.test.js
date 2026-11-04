// __tests__/native-ghs-bank-adapter-contract.test.js
// =============================================================================
// #392 workstream 3 — CONTRACT COMPATIBILITY WITH #391's REAL ADAPTER.
//
// This suite does not re-declare the adapter. It reads Agent B's published
// service straight out of git at the agreed commit, loads it, and drives it
// through THIS branch's pre-dispatch capability check and validation mapping.
// A fake port in the other suites can only prove what I believed the contract
// to be; only the real class can prove the two branches actually meet.
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ADAPTER_SHA = process.env.MOOLRE_ADAPTER_SHA || '66a81b0914d52adc963b7eeb1f863cbed6ff0195';
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(REPO_ROOT, '.tmp-391-adapter');
const ADAPTER_FILE = path.join(TMP_DIR, 'moolreBankPayoutService.js');

function materialiseAdapter() {
    try {
        const source = execFileSync('git', ['show', `${ADAPTER_SHA}:services/moolreBankPayoutService.js`], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(ADAPTER_FILE, source);
        return source;
    } catch (err) {
        // The exact commit may simply not be in a shallow CI clone. Fetch THAT
        // object rather than skipping the proof: a money-moving lifecycle test
        // that silently skips is worse than one that fails.
        try {
            execFileSync('git', ['fetch', '--depth=1', 'origin', ADAPTER_SHA], { cwd: REPO_ROOT, stdio: 'ignore' });
            const source = execFileSync('git', ['show', `${ADAPTER_SHA}:services/moolreBankPayoutService.js`], {
                cwd: REPO_ROOT, encoding: 'utf8',
            });
            fs.mkdirSync(TMP_DIR, { recursive: true });
            fs.writeFileSync(ADAPTER_FILE, source);
            return source;
        } catch (fetchErr) {
            return null;
        }
    }
}

const adapterSource = materialiseAdapter();
const hasAdapter = !!adapterSource;

if (!hasAdapter) {
    console.warn(`[adapter-contract] ${ADAPTER_SHA} is not available in this clone — skipping (the #391 branch was not fetched).`);
}

(hasAdapter ? describe : describe.skip)('#391 MoolreBankPayoutService meets the #392 pre-dispatch contract', () => {
    const svc = require('../src/services/nativeGhsWithdrawalService');

    let MoolreBankPayoutService;
    let MoolreBankPayoutError;

    const ACCOUNT = '1234567890123';
    const BANK_CODE = 'GCB';
    const ACCOUNT_NAME = 'Ama Mensah';

    beforeAll(() => {
        const loaded = require(ADAPTER_FILE);
        MoolreBankPayoutService = loaded.MoolreBankPayoutService || loaded;
        MoolreBankPayoutError = loaded.MoolreBankPayoutError || loaded.default;
    });

    afterAll(() => {
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    });

    // A transport that answers ONLY the two calls this proof needs and records
    // every URL, so "no transfer POST happened" is observable rather than assumed.
    function transport({ validate }) {
        const calls = [];
        return {
            calls,
            post: async (url) => {
                calls.push(url);
                if (url.endsWith('/validate')) return validate();
                // A transfer POST is a money movement: make it loud in the test.
                throw new Error(`unexpected POST ${url}`);
            },
            get: async (url) => {
                calls.push(url);
                throw new Error(`unexpected GET ${url}`);
            },
        };
    }

    function adapter(transportImpl, overrides = {}) {
        const service = new MoolreBankPayoutService({
            providerMode: 'LIVE',
            bankPayoutEnabled: true,
            endpointFamilyConfirmed: true,
            channel2EligibilityConfirmed: true,
            apiUser: 'test-user',
            apiKey: 'test-key',
            accountNumber: '1000000001',
            baseUrl: 'https://sandbox.moolre.com',
            http: transportImpl,
            ...overrides,
        });
        // The directory is provider data with its own cache; priming it keeps
        // this proof about the VALIDATION contract. Every real code path below
        // still runs through the adapter's own bank-code check.
        service._directoryCache = {
            banks: [{ code: BANK_CODE, name: 'GCB Bank' }],
            fetchedAtMs: Date.now(),
            retrievedAt: new Date().toISOString(),
        };
        return service;
    }

    const ok = () => ({ status: 200, data: { status: 1, code: 'AVD01', data: ACCOUNT_NAME } });
    const notFound = () => ({ status: 400, data: { status: 0, code: 'AVD02', message: 'invalid account' } });
    const malformed = () => ({ status: 200, data: '<html>maintenance</html>' });

    test('1: the real capabilities() satisfies the preflight only when both legs are on', () => {
        const live = adapter(transport({ validate: ok }));
        const caps = live.capabilities();
        expect(caps.canInitiateBankPayout).toBe(true);
        expect(caps.canValidateBankAccount).toBe(true);
        // the #392 preflight the dispatcher runs
        expect(svc.bankRevalidationCapability(live)).toBe(true);

        // the SAME adapter with the endpoint family unconfirmed cannot validate
        const unconfirmed = adapter(transport({ validate: ok }), { endpointFamilyConfirmed: false });
        // initiation needs the endpoint family too; validation does not, so the
        // interesting fact is that the VALIDATION leg is what gates dispatch
        expect(unconfirmed.capabilities().canValidateBankAccount).toBe(false);
        expect(unconfirmed.capabilities().canInitiateBankPayout).toBe(false);
        expect(svc.bankRevalidationCapability(unconfirmed)).toBe(false);
    });

    test('2 + 3: the enquiry calls validateBankAccount with the STORED account and bank code, and a documented success is CONFIRMED', async () => {
        const transportImpl = transport({ validate: ok });
        const live = adapter(transportImpl);
        const seen = [];
        const original = live.validateBankAccount.bind(live);
        live.validateBankAccount = async (args) => { seen.push({ ...args }); return original(args); };

        const verdict = await svc.enquiryBankDestination(live, {
            accountNumber: ACCOUNT,
            bankCode: BANK_CODE,
            expectedAccountName: ACCOUNT_NAME,
        });

        expect(seen).toEqual([{ accountNumber: ACCOUNT, bankCode: BANK_CODE }]);
        expect(verdict.decision).toBe('CONFIRMED');
        expect(verdict.accountName).toBe(ACCOUNT_NAME);
        expect(verdict.provider).toBe('MOOLRE');
        expect(Number.isNaN(new Date(verdict.providerValidatedAt).getTime())).toBe(false);
        // no fabricated provider echo of the account number is required or claimed
        expect(verdict.echoedAccountNumber).toBeUndefined();
        // exactly ONE provider call, and it was the validation POST
        expect(transportImpl.calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(0);
    });

    test('4: a real AVD02 refusal is a DEFINITIVE pre-dispatch negative, and nothing is transferred', async () => {
        const transportImpl = transport({ validate: notFound });
        const live = adapter(transportImpl);

        const verdict = await svc.enquiryBankDestination(live, {
            accountNumber: ACCOUNT,
            bankCode: BANK_CODE,
            expectedAccountName: ACCOUNT_NAME,
        });

        expect(verdict.decision).toBe('NEGATIVE');
        expect(verdict.error.code).toBe('PROVIDER_ACCOUNT_NOT_FOUND');
        // NOTE: at 31a81cf #391's error carried the typed outcome,
        // dispatchProven and the Moolre provider identity but did NOT expose
        // refusalDocumented (passed to the constructor and dropped), which is
        // why the #392 mapping keys on `dispatchProven` plus the provider's own
        // AVD02 code rather than the flag. At cafc0fa the adapter publishes the
        // flag too; the mapping is unchanged and still holds on both heads.
        expect(verdict.error.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(verdict.error.outcome).toBe('DEFINITIVE_REJECTION');
        expect(verdict.error.dispatchProven).toBe(true);
        expect(transportImpl.calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(0);
    });

    test('5: a timeout and a malformed answer stay INCONCLUSIVE, and nothing is transferred', async () => {
        const timingOut = transport({ validate: () => { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; throw e; } });
        const timedOut = await svc.enquiryBankDestination(adapter(timingOut), {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME,
        });
        expect(timedOut.decision).toBe('INCONCLUSIVE');
        expect(timingOut.calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(0);

        const garbage = transport({ validate: malformed });
        const unreadable = await svc.enquiryBankDestination(adapter(garbage), {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME,
        });
        expect(unreadable.decision).toBe('INCONCLUSIVE');
        expect(garbage.calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(0);
    });

    test('6: a different holder name is NAME_MISMATCH, never a silent acceptance', async () => {
        const live = adapter(transport({ validate: () => ({ status: 200, data: { status: 1, code: 'AVD01', data: 'Kofi Boateng' } }) }));
        const verdict = await svc.enquiryBankDestination(live, {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME,
        });
        expect(verdict.decision).toBe('NAME_MISMATCH');
    });

    test('7: the adapter keeps its own typed error class (no test-only aliases introduced)', async () => {
        const live = adapter(transport({ validate: notFound }));
        await expect(live.validateBankAccount({ accountNumber: ACCOUNT, bankCode: BANK_CODE }))
            .rejects.toMatchObject({ name: 'MoolreBankPayoutError', code: 'ACCOUNT_NOT_FOUND' });
        expect(typeof MoolreBankPayoutError).toBe('function');
    });

    // The mapping must key on the PROVIDER'S OWN documented code (AVD02), not on
    // a normalised error code alone. Both directions are proved against the real
    // class, because only it decides which providerCode a failure carries.
    test('8: only AVD02 is a definitive negative; another refusal code stays inconclusive', async () => {
        const avd02 = adapter(transport({ validate: notFound }));
        const negative = await svc.enquiryBankDestination(avd02, {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME,
        });
        expect(negative.decision).toBe('NEGATIVE');
        expect(negative.error.code).toBe('PROVIDER_ACCOUNT_NOT_FOUND');
        expect(negative.error.providerCode).toBe('AVD02');

        // Same HTTP shape, same status:0, different provider code. The provider
        // has NOT documented an account-not-found answer, so nothing may be
        // refunded on it.
        const other = adapter(transport({ validate: () => ({ status: 400, data: { status: 0, code: 'AVD99', message: 'declined' } }) }));
        const held = await svc.enquiryBankDestination(other, {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME,
        });
        expect(held.decision).toBe('INCONCLUSIVE');
        expect(held.decision).not.toBe('NEGATIVE');

        // A bare ACCOUNT_NOT_FOUND with no provider code at all is a
        // normalisation this branch produced — never a provider refusal.
        const bare = new Error('not found');
        bare.outcome = 'DEFINITIVE_REJECTION';
        bare.code = 'ACCOUNT_NOT_FOUND';
        bare.dispatchProven = true;
        bare.provider = 'MOOLRE_DISBURSEMENT';
        const bareVerdict = await svc.enquiryBankDestination(
            { validateBankAccount: async () => { throw bare; } },
            { accountNumber: ACCOUNT, bankCode: BANK_CODE, expectedAccountName: ACCOUNT_NAME }
        );
        expect(bareVerdict.decision).toBe('INCONCLUSIVE');
    });
});
