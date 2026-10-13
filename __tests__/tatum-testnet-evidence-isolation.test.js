// __tests__/tatum-testnet-evidence-isolation.test.js
// =============================================================================
// §TATUM-TESTNET — evidence-domain isolation proofs.
//
// Verified live on 2026-10-13 against api.tatum.io with a TESTNET API key:
//   • v4 wallet-portfolio: chain `polygon-amoy`, tokenTypes=fungible →
//     { result: [ { chain, address, balance, denominatedBalance, decimals,
//       tokenAddress, type } ], prevPage, nextPage }. `balance` is the
//     denominated DECIMAL string, `denominatedBalance` is the exact base-unit
//     integer string — the reverse of the v3 naming. 6-decimals Amoy USDC
//     confirmed (0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582, Circle official).
//   • A testnet API key can read MAINNET portfolio data — Tatum does NOT
//     enforce network isolation per key. The adapter layer MUST.
//   • The v3 token-balance endpoint has no testnet chain value at all.
//
// These tests prove, offline (deterministic fake HTTP injected through the
// REAL adapter, matching the custody-accounting suite conventions):
//   1. The testnet v4 provider parses the exact live response shapes and
//      fails closed on every malformed/rejected/absent variant.
//   2. The testnet provider structurally cannot serve a mainnet network.
//   3. Mainnet observations are branded networkScope MAINNET.
//   4. observeAccountBalance rejects a TESTNET-scope observation for a
//      production (mainnet) custody account — recorded for audit, never
//      accepted — while mainnet observations still flow (REAL POSTGRESQL).
//   5. Testnet evidence can therefore never enter accepted mainnet
//      custody-account evidence or a Proof-of-Reserves numerator.
//   6. Review hardening (r1–r3): paginated responses never yield false zeros;
//      entry identity is validated BEFORE absence is concluded; only the
//      canonical Amoy USDC contract with a fungible type is ever labeled USDC.
//   7. Final hardening (r1/r2): pagination metadata must be PRESENT and
//      well-shaped (null or '' completes a page; any other shape fails
//      closed); every entry must be fungible per the requested filter.
// =============================================================================

const { Prisma, PrismaClient } = require('@prisma/client');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[tatum-testnet-isolation] TEST_DATABASE_URL not set — skipping DB proofs.');

const {
    CustodyEvidenceError,
    EVIDENCE_ERRORS,
    SOURCE_BALANCE,
    SOURCE_BALANCE_TESTNET,
    TATUM_V4_CHAIN_TESTNET,
    createTatumTokenBalanceProvider,
    createTatumV4TestnetBalanceProvider,
    normalizeAddress,
} = require('../services/custodyEvidenceProvider');

const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582'; // Circle official — Polygon PoS Amoy USDC
const HOLDER = '0xd9380c0f2819c86c43C4D116B267729099aD6971'; // live Amoy holder (20,000,000,008.929275 USDC, 6 dp)

/** Deterministic fake axios, mirroring the custody-accounting conventions. */
function fakeHttp(handler) {
    return {
        async get(path, config) {
            const result = handler(path, config);
            if (result && result.__httpError) {
                const err = new Error(result.message);
                if (result.status) {
                    err.response = { status: result.status, data: result.body || null };
                }
                throw err;
            }
            return result;
        },
    };
}

/** The EXACT live v4 wallet-portfolio shape observed on 2026-10-13. */
function livePortfolioEntry({ balance = '20000000008.929275', denominatedBalance = '20000000008929275', decimals = 6 } = {}) {
    return {
        chain: 'polygon-amoy',
        address: HOLDER,
        balance,
        denominatedBalance,
        decimals,
        tokenAddress: USDC_AMOY,
        type: 'fungible',
    };
}

function makeTestnetProvider(http, apiKey = 'testnet-key') {
    return createTatumV4TestnetBalanceProvider({ http, apiKey });
}

// ── 1. Testnet v4 provider: exact live shapes, fail-closed variants ─────────
describe('§TATUM-TESTNET v4 wallet-portfolio provider (offline, live shapes)', () => {
    const get = async (http, opts = {}) => {
        const p = makeTestnetProvider(http);
        return p.getBalance({
            network: 'POLYGON_TESTNET',
            contractAddress: USDC_AMOY,
            address: HOLDER,
            decimals: 6,
            ...opts,
        });
    };

    it('parses the exact live Amoy USDC response into exact base units', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry()], prevPage: '', nextPage: '' } }));
        const obs = await get(http);
        expect(obs.source).toBe(SOURCE_BALANCE_TESTNET);
        expect(obs.networkScope).toBe('TESTNET');
        expect(obs.network).toBe('POLYGON_TESTNET');
        expect(obs.contractAddress).toBe(normalizeAddress(USDC_AMOY));
        expect(obs.address).toBe(normalizeAddress(HOLDER));
        expect(obs.balanceBaseUnits).toBe(20000000008929275n); // 20,000,000,008.929275 USDC at 6 dp
        expect(obs.blockReference).toBe(null); // documented: no block reference
    });

    it('a wallet with no entry for the token observes ZERO (a legal balance), flagged absent', async () => {
        // §REVIEW-R2 (final): the unrelated entry is a FUNGIBLE token —
        // a native/NFT/unknown entry would violate tokenTypes=fungible and
        // must be rejected (see the review hardening suite).
        const http = fakeHttp(() => ({ data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '12.345678', denominatedBalance: '12345678', decimals: 6, tokenAddress: '0x0000000000000000000000000000000000000999', type: 'fungible' }], prevPage: '', nextPage: '' } }));
        const obs = await get(http);
        expect(obs.balanceBaseUnits).toBe(0n);
        expect(obs.raw.absent).toBe(true);
    });

    it('rejects a negative base-unit balance (fail closed, never signed-evidence)', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry({ balance: '-1', denominatedBalance: '-1' })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects balance/denominatedBalance disagreement (neither form is trusted)', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry({ balance: '1.000000', denominatedBalance: '1000001' })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects non-integer base-unit strings and non-string garbage', async () => {
        const a = fakeHttp(() => ({ data: { result: [livePortfolioEntry({ balance: '20.5', denominatedBalance: '20.5' })], prevPage: '', nextPage: '' } }));
        await expect(get(a)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
        const b = fakeHttp(() => ({ data: { result: [livePortfolioEntry({ balance: null, denominatedBalance: null })], prevPage: '', nextPage: '' } }));
        await expect(get(b)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects a decimals mismatch against the canonical identity', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry({ balance: '1.5', denominatedBalance: '1500000000000000000', decimals: 18 })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects a chain echo other than the requested testnet chain', async () => {
        const http = fakeHttp(() => ({ data: { result: [Object.assign(livePortfolioEntry(), { chain: 'polygon-mainnet' })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects an address echo other than the requested wallet', async () => {
        const http = fakeHttp(() => ({ data: { result: [Object.assign(livePortfolioEntry(), { address: '0x0000000000000000000000000000000000000001' })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('rejects a non-object payload (provider shape drift)', async () => {
        const http = fakeHttp(() => ({ data: 'garbage' }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
        const http2 = fakeHttp(() => ({ data: { result: 'not-an-array' } }));
        await expect(get(http2)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('classifies 401/403 as PROVIDER_REJECTED and 429/404/timeouts as PROVIDER_UNAVAILABLE', async () => {
        for (const status of [401, 403]) {
            const http = fakeHttp(() => ({ __httpError: true, status, body: { statusCode: status, errorCode: 'subscription.invalid' } }));
            await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.PROVIDER_REJECTED });
        }
        for (const status of [404, 429]) {
            const http = fakeHttp(() => ({ __httpError: true, status }));
            await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.PROVIDER_UNAVAILABLE });
        }
        const timeoutHttp = fakeHttp(() => ({ __httpError: true, message: 'timeout of 15000ms exceeded' }));
        await expect(get(timeoutHttp)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.PROVIDER_UNAVAILABLE });
    });

    it('structurally refuses to serve ANY mainnet network (testnet can never mint mainnet evidence)', async () => {
        const http = fakeHttp(() => ({ data: { result: [], prevPage: '', nextPage: '' } }));
        const p = makeTestnetProvider(http);
        await expect(p.getBalance({ network: 'POLYGON', contractAddress: USDC_AMOY, address: HOLDER, decimals: 6 }))
            .rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
        await expect(p.getBalance({ network: 'POLYGON_MAINNET', contractAddress: USDC_AMOY, address: HOLDER, decimals: 6 }))
            .rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
    });

    it('fails closed when no testnet credential is configured', async () => {
        const hadEnv = process.env.TATUM_TESTNET_API_KEY;
        delete process.env.TATUM_TESTNET_API_KEY; // a stray env key must not rescue an unconfigured adapter
        const p = createTatumV4TestnetBalanceProvider({ http: fakeHttp(() => ({ data: {} })), apiKey: null });
        try {
            await expect(p.getBalance({ network: 'POLYGON_TESTNET', contractAddress: USDC_AMOY, address: HOLDER, decimals: 6 }))
                .rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
        } finally {
            if (hadEnv) process.env.TATUM_TESTNET_API_KEY = hadEnv;
        }
    });

    it('requires an exact integer decimals value (canonical identity check)', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry()], prevPage: '', nextPage: '' } }));
        const p = makeTestnetProvider(http);
        await expect(p.getBalance({ network: 'POLYGON_TESTNET', contractAddress: USDC_AMOY, address: HOLDER, decimals: '6' }))
            .rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
        await expect(p.getBalance({ network: 'POLYGON_TESTNET', contractAddress: USDC_AMOY, address: HOLDER, decimals: undefined }))
            .rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
    });

    it('the testnet chain map is disjoint from every mainnet map value', () => {
        expect(Object.values(TATUM_V4_CHAIN_TESTNET)).toEqual(['polygon-amoy']);
        expect(TATUM_V4_CHAIN_TESTNET.POLYGON).toBeUndefined();
        expect(TATUM_V4_CHAIN_TESTNET.POLYGON_MAINNET).toBeUndefined();
    });
});

// ── 1b. §REVIEW r1–r3 hardening: pagination, identity-before-absence, USDC identity ──
describe('§TATUM-TESTNET review hardening — pagination, absence identity, USDC identity', () => {
    const get = async (http, opts = {}) => {
        const p = makeTestnetProvider(http);
        return p.getBalance({
            network: 'POLYGON_TESTNET',
            contractAddress: USDC_AMOY,
            address: HOLDER,
            decimals: 6,
            ...opts,
        });
    };
    /** A complete live-shape page WITHOUT the USDC entry (an unrelated FUNGIBLE token — native/NFT/unknown entries violate the filter and are rejected). */
    const pageWithoutUsdc = (nextPage) => ({
        data: {
            result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '12.345678', denominatedBalance: '12345678', decimals: 6, tokenAddress: '0x0000000000000000000000000000000000000999', type: 'fungible' }],
            prevPage: '',
            ...(nextPage === undefined ? {} : { nextPage }),
        },
    });

    // ── r1: pagination and false-zero prevention ──
    it('r1: NEVER returns zero when the token is absent from the page but nextPage indicates more results (later-page USDC)', async () => {
        // The target USDC entry lives on a LATER page; page 1 has only an
        // unrelated token and a non-empty nextPage cursor. A zero here would
        // be a fabricated false zero — the provider must fail closed.
        const http = fakeHttp(() => pageWithoutUsdc('b2xYcGVyc2VhbF9jdXJzb3I='));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r1: an EMPTY first page with a nextPage cursor also fails closed (no zero)', async () => {
        const http = fakeHttp(() => ({ data: { result: [], prevPage: '', nextPage: 'b2xY' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r1: a token FOUND on the first page still returns its balance even when nextPage indicates more pages', async () => {
        // Presence on the fetched page is valid evidence; later pages can
        // only hold OTHER tokens — absence is not being concluded here.
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry()], prevPage: '', nextPage: 'b2xY' } }));
        const obs = await get(http);
        expect(obs.balanceBaseUnits).toBe(20000000008929275n);
        expect(obs.raw.absent).toBeUndefined();
    });

    it('r1: absence on a COMPLETE page (nextPage null OR empty string) still observes a legal zero', async () => {
        // Verified live 2026-10-13: no-more-pages is signalled by nextPage
        // being null OR the empty string.
        const a = fakeHttp(() => pageWithoutUsdc(null));
        expect((await get(a)).balanceBaseUnits).toBe(0n);
        const b = fakeHttp(() => pageWithoutUsdc(''));
        expect((await get(b)).balanceBaseUnits).toBe(0n);
    });

    // ── r2: response identity BEFORE absence handling ──
    it('r2: token absent but a returned entry is for the WRONG CHAIN — fails closed, never zero', async () => {
        const http = fakeHttp(() => ({
            data: { result: [{ chain: 'polygon-mainnet', address: HOLDER, balance: '5.0', denominatedBalance: '5000000', decimals: 6, tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', type: 'fungible' }], prevPage: '', nextPage: '' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r2: token absent but a returned entry is for the WRONG ADDRESS — fails closed, never zero', async () => {
        const http = fakeHttp(() => ({
            data: { result: [{ chain: 'polygon-amoy', address: '0x0000000000000000000000000000000000000001', balance: '5.0', denominatedBalance: '5000000', decimals: 6, tokenAddress: USDC_AMOY, type: 'fungible' }], prevPage: '', nextPage: '' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r2: identity validation fires even when a nextPage cursor is present (fail closed either way)', async () => {
        const http = fakeHttp(() => ({
            data: { result: [{ chain: 'polygon-mainnet', address: HOLDER, balance: '5.0', denominatedBalance: '5000000', decimals: 6, tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', type: 'fungible' }], prevPage: '', nextPage: 'b2xY' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    // ── r3: USDC contract identity and fungible token type ──
    it('r3: refuses to observe ANY contract other than the canonical Polygon Amoy USDC — no HTTP call is made', async () => {
        let calls = 0;
        const http = fakeHttp(() => { calls += 1; return { data: { result: [livePortfolioEntry()], prevPage: '', nextPage: '' } }; });
        const arbitrary = '0x1111111111111111111111111111111111111111';
        await expect(get(http, { contractAddress: arbitrary })).rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
        // even a one-character drift of the canonical contract is refused:
        await expect(get(http, { contractAddress: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7583' })).rejects.toMatchObject({ code: EVIDENCE_ERRORS.CONFIGURATION_ERROR });
        expect(calls).toBe(0); // the gate fires BEFORE any provider request
    });

    it('r3: a matched entry whose type is not fungible is rejected (nft / native / unknown types)', async () => {
        for (const type of ['nft', 'native', 'multitoken', null, undefined]) {
            const http = fakeHttp(() => ({ data: { result: [Object.assign(livePortfolioEntry(), { type })], prevPage: '', nextPage: '' } }));
            await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
        }
    });

    it('r3: duplicate entries for the requested token contract are ambiguous and fail closed', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry(), livePortfolioEntry({ balance: '1.000000', denominatedBalance: '1000000' })], prevPage: '', nextPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r3: the canonical contract gate is case-insensitive (EIP-55 checksums normalize to the same identity)', async () => {
        const http = fakeHttp(() => ({ data: { result: [livePortfolioEntry()], prevPage: '', nextPage: '' } }));
        const obs = await get(http, { contractAddress: USDC_AMOY.toUpperCase() });
        expect(obs.balanceBaseUnits).toBe(20000000008929275n);
    });
    // ── r1 (final): pagination metadata must be PRESENT and well-shaped ──
    it('r1: token absent and the response LACKS nextPage entirely — fails closed, never zero', async () => {
        const http = fakeHttp(() => ({ data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '12.345678', denominatedBalance: '12345678', decimals: 6, tokenAddress: '0x0000000000000000000000000000000000000999', type: 'fungible' }], prevPage: '' } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r1: token absent with an explicitly undefined nextPage — fails closed, never zero', async () => {
        const http = fakeHttp(() => ({ data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '12.345678', denominatedBalance: '12345678', decimals: 6, tokenAddress: '0x0000000000000000000000000000000000000999', type: 'fungible' }], prevPage: '', nextPage: undefined } }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r1: token absent with a NON-STRING nextPage (number / object / boolean) — fails closed on shape drift', async () => {
        for (const nextPage of [0, 1, { page: 2 }, true]) {
            const http = fakeHttp(() => pageWithoutUsdc(nextPage));
            await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
        }
    });

    it('r1: valid completion values null AND empty string remain the ONLY shapes that observe a legal zero', async () => {
        const a = fakeHttp(() => pageWithoutUsdc(null));
        expect((await get(a)).balanceBaseUnits).toBe(0n);
        const b = fakeHttp(() => pageWithoutUsdc(''));
        expect((await get(b)).balanceBaseUnits).toBe(0n);
    });

    // ── r2 (final): unexpected entry types can never produce a zero ──
    it('r2: a NATIVE entry in the response (tokenTypes=fungible violated) can never produce a zero observation', async () => {
        const http = fakeHttp(() => ({
            data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '2.394863274000720944', denominatedBalance: '2394863274000720944', decimals: 18, type: 'native' }], prevPage: '', nextPage: '' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r2: an NFT entry in the response can never produce a zero observation', async () => {
        const http = fakeHttp(() => ({
            data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '1', denominatedBalance: '1', decimals: 0, tokenAddress: '0x0000000000000000000000000000000000000777', type: 'nft' }], prevPage: '', nextPage: '' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });

    it('r2: entries with UNKNOWN types (null / undefined / unrecognized strings) can never produce a zero observation', async () => {
        for (const type of [null, undefined, 'weird', '']) {
            const http = fakeHttp(() => ({
                data: { result: [{ chain: 'polygon-amoy', address: HOLDER, balance: '12.345678', denominatedBalance: '12345678', decimals: 6, tokenAddress: '0x0000000000000000000000000000000000000999', type }], prevPage: '', nextPage: '' },
            }));
            await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
        }
    });

    it('r2: a NON-FUNGIBLE entry is rejected even when the USDC entry is ALSO present (filter violation is independent of matching)', async () => {
        const http = fakeHttp(() => ({
            data: { result: [livePortfolioEntry(), { chain: 'polygon-amoy', address: HOLDER, balance: '2.394863274000720944', denominatedBalance: '2394863274000720944', decimals: 18, type: 'native' }], prevPage: '', nextPage: '' },
        }));
        await expect(get(http)).rejects.toMatchObject({ code: EVIDENCE_ERRORS.MALFORMED_RESPONSE });
    });
});

// ── 2. Mainnet branding: the mainnet adapters state their domain ────────────
describe('§TATUM-TESTNET mainnet observations are explicitly MAINNET-scoped', () => {
    it('the v3 balance provider brands every observation networkScope MAINNET', async () => {
        const http = fakeHttp(() => ({ data: { balance: '100123456' } }));
        const p = createTatumTokenBalanceProvider({ http, apiKey: 'k' });
        const obs = await p.getBalance({ network: 'POLYGON', contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', address: '0xabc', decimals: 6 });
        expect(obs.networkScope).toBe('MAINNET');
        expect(obs.source).toBe(SOURCE_BALANCE);
    });
});

// ── 3. DB proofs: the accounting domain wall ────────────────────────────────
describeOrSkip('§TATUM-TESTNET custody-accounting domain wall (REAL POSTGRESQL)', () => {
    const prisma = new PrismaClient();
    const accounting = require('../services/custodyAccountingService');
    const { seedUser } = require('./helpers/factories');
    const CUST = '0xd9380c0f2819c86c43C4D116B267729099aD6971';
    const NATIVE = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'; // canonical mainnet native USDC

    let addrSeq = 0;
    const runNonce = BigInt(Date.now()) % 1000000000n; // unique address space per test run
    /** A custodyAccount serving a MAINNET network, exactly as production builds them. */
    async function seedMainnetAccount() {
        // walletAddress is UNIQUE on (address, network) — each test uses a
        // distinct deposit address, mirroring real distinct customer wallets.
        addrSeq += 1;
        const address = (BigInt(0xd9380c0f2819c86c) + runNonce * 1000n + BigInt(addrSeq)).toString(16).padStart(40, '0');
        const user = await seedUser(prisma, { availableBalance: 0 });
        const registry = await prisma.walletAddress.create({
            data: {
                userId: user.id,
                network: 'POLYGON',
                asset: 'USDC',
                contractAddress: NATIVE,
                address,
                status: 'ACTIVE',
            },
        });
        return prisma.$transaction((tx) => accounting.ensureDepositAccount(tx, { walletAddress: registry }));
    }

    function stubObservation({ scope, network = 'POLYGON', source = SOURCE_BALANCE, balance = '150000000' } = {}) {
        const observedAt = new Date();
        return {
            source,
            async getBalance({ contractAddress, address }) {
                return {
                    source, scope: 'ACCOUNT_BALANCE',
                    network, networkScope: scope,
                    asset: 'USDC',
                    contractAddress: normalizeAddress(contractAddress),
                    address: normalizeAddress(address),
                    balanceBaseUnits: BigInt(balance),
                    observedAt, blockReference: null, raw: { balance },
                };
            },
        };
    }

    afterAll(async () => { await prisma.$disconnect(); });

    it('a TESTNET-scope observation is rejected, audited, and NEVER accepted for a mainnet account', async () => {
        const account = await seedMainnetAccount();
        const res = await accounting.observeAccountBalance(prisma, {
            account,
            provider: stubObservation({ scope: 'TESTNET', network: 'POLYGON' }),
        });
        expect(res.recorded).toBe(false);
        expect(res.reason).toBe('NETWORK_SCOPE_MISMATCH');
        expect(res.retryable).toBe(false);

        const rejected = await prisma.custodyEvidence.findFirst({
            where: { custodyAccountId: account.id, status: 'REJECTED', rejectionReason: 'NETWORK_SCOPE_MISMATCH' },
        });
        expect(rejected).not.toBeNull(); // audited
        expect(rejected.network).toBe('POLYGON'); // the MAINNET network is what the account demanded
        expect(rejected.balanceBaseUnits).toBe(150000000n);

        // No ACTIVE evidence can ever come from the testnet observation.
        expect(await prisma.custodyEvidence.findFirst({ where: { custodyAccountId: account.id, status: 'ACTIVE' } })).toBeNull();
        const fresh = await accounting.getFreshAcceptedEvidence(prisma, { custodyAccountId: account.id, maxAgeMs: 60_000 });
        expect(fresh).toBeNull();
    });

    it('a MAINNET-scope observation on the same account still flows (no regression from the wall)', async () => {
        const account = await seedMainnetAccount();
        const res = await accounting.observeAccountBalance(prisma, {
            account,
            provider: stubObservation({ scope: 'MAINNET' }),
        });
        expect(res.recorded).toBe(true);
        expect(res.evidence.status).toBe('ACTIVE');
        expect(res.evidence.balanceBaseUnits).toBe(150000000n);
        const fresh = await accounting.getFreshAcceptedEvidence(prisma, { custodyAccountId: account.id, maxAgeMs: 60_000 });
        expect(fresh).not.toBeNull();
        expect(fresh.balanceBaseUnits).toBe(150000000n);
    });

    it('a legacy observation without a scope field is treated as MAINNET (backwards compatible)', async () => {
        const account = await seedMainnetAccount();
        const provider = stubObservation({ scope: 'MAINNET' });
        delete provider.getBalance; // rebuild without the scope field
        provider.getBalance = async ({ contractAddress, address }) => ({
            source: SOURCE_BALANCE, scope: 'ACCOUNT_BALANCE',
            network: 'POLYGON', // no networkScope field at all (legacy adapter)
            asset: 'USDC',
            contractAddress: normalizeAddress(contractAddress),
            address: normalizeAddress(address),
            balanceBaseUnits: 777n,
            observedAt: new Date(), blockReference: null, raw: { balance: '777' },
        });
        const res = await accounting.observeAccountBalance(prisma, { account, provider });
        expect(res.recorded).toBe(true);
        expect(res.evidence.balanceBaseUnits).toBe(777n);
    });

    it('the testnet provider SOURCE is rejected outright by observeAccountBalance (only mainnet source accepted)', async () => {
        const account = await seedMainnetAccount();
        const provider = stubObservation({ scope: 'TESTNET', network: 'POLYGON', source: SOURCE_BALANCE_TESTNET });
        await expect(accounting.observeAccountBalance(prisma, { account, provider }))
            .rejects.toThrow(/TATUM_V3_TOKEN_BALANCE provider is required/);
        expect(await prisma.custodyEvidence.findFirst({ where: { custodyAccountId: account.id } })).toBeNull();
    });

    it('a testnet network on the observation is still rejected by the request binding (first line of defense)', async () => {
        const account = await seedMainnetAccount();
        const res = await accounting.observeAccountBalance(prisma, {
            account,
            provider: stubObservation({ scope: 'TESTNET', network: 'POLYGON_TESTNET' }),
        });
        expect(res.recorded).toBe(false);
        expect(res.reason).toBe(EVIDENCE_ERRORS.MALFORMED_RESPONSE);
    });
});
