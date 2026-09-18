// §P.5-A multi-asset identity — real PostgreSQL proofs. Cross-asset numeric
// coincidence fails closed; only explicit ASSET_CONVERSION (DB-enforced
// identity, exact rate provenance, per-asset balanced legs) is legitimate.
const describeOrSkip = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const { Prisma, PrismaClient } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const { seedUser } = require('./helpers/factories');

describeOrSkip('§P.5-A multi-asset accounting identity (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "RestrictedObligation", "LedgerTransaction", "LedgerAccount", "JournalEntry", ' +
        '"CustodyEvidence", "CustodyMovement", "CustodyAccount", "CustodyExecution", "OnchainSweep", ' +
        '"TransactionHistory", "WalletAddress", "User", "SystemHotWallet", "SystemMasterCrypto", ' +
        '"SystemFiatPool", "SystemProfitFees", "GlobalSettings", "AdminProfitLog", ' +
        '"ProofOfReservesSnapshot" RESTART IDENTITY CASCADE'
    );
    beforeEach(async () => { await TRUNCATE_ALL(); }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    const post = (tx, params) => ledger.post(tx, params);
    const conversionLegs = () => [
        { account: 'fiat:momo:ghs', debit: '1200' },
        { account: 'equity:treasury:ghs', credit: '1200' },
        { account: 'equity:treasury', debit: '100' },
        { account: 'custody:deposit:usdc', credit: '100' },
    ];

    // A + B. Existing P4 USDC posting surface is unchanged
    describe('A/B. USDC postings remain valid (P4 compatibility)', () => {
        it('a normal P4-style USDC posting succeeds exactly as before', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const r = await prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:usdc:normal',
                entryType: 'DEPOSIT',
                description: 'P4-style USDC credit',
                userId: user.id,
                lines: [
                    { account: 'custody:deposit:usdc', debit: '100' },
                    { account: `user:${user.id}:liability`, credit: '100' },
                ],
            }));
            expect(r.replayed).toBe(false);
            expect(r.transaction.metadata).toBeNull(); // no conversion pollution
            expect((await ledger.accountBalance(prisma, `user:${user.id}:liability`)).balance.toFixed(8))
                .toBe('100.00000000');
        });
    });
    // C. Cross-asset numeric coincidence fails closed
    describe('C. cross-asset numeric coincidence is rejected, fail closed', () => {
        it('debit GHS / credit USDC is NOT an accounting equality — deterministic, nothing committed', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            let err;
            await prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:coincidence:ghs-usdc',
                entryType: 'DEPOSIT',
                description: 'illegal GHS→USDC numeric balance',
                lines: [
                    { account: 'fiat:momo:ghs', debit: '1200' },
                    { account: `user:${user.id}:liability`, credit: '100' },
                    { account: 'equity:treasury', debit: '100' },
                    { account: 'equity:treasury:ghs', credit: '1200' },
                ],
            })).catch((e) => { err = e; });
            // Even a NUMERICALLY balanced posting is rejected on IDENTITY
            // grounds: the assets differ, so equality is meaningless.
            expect(err).toBeInstanceOf(ledger.LedgerError);
            expect(err.code).toBe('LEDGER_CROSS_ASSET_BALANCE');
            expect(err.details.assets.sort()).toEqual(['GHS', 'USDC']);
            expect(err.details.perAsset.GHS).toEqual({ debit: '1200.00000000', credit: '1200.00000000' });
            expect(err.details.perAsset.USDC).toEqual({ debit: '100.00000000', credit: '100.00000000' });
            expect(await prisma.ledgerTransaction.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);
            expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(0);
        });
    });
    // D. Explicit conversion/exchange identity
    describe('D. explicit ASSET_CONVERSION — legitimate cross-asset exchange', () => {
        it('commits two asset-balanced legs with a durable identity + exact rate provenance', async () => {
            const r = await prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:conversion:legit',
                entryType: 'ASSET_CONVERSION',
                description: 'explicit GHS↔USDC exchange (mechanism proof, no Model B settlement)',
                conversion: { identity: 'conv:test:0001', rate: '12', quoteReference: 'quote-abc' },
                lines: conversionLegs(),
            }));
            expect(r.replayed).toBe(false);
            expect(r.transaction.metadata.conversion).toEqual({
                identity: 'conv:test:0001', rate: '12.00000000',
                quoteReference: 'quote-abc', assets: ['GHS', 'USDC'],
            });
            // Each leg moved its own asset exactly; line metadata unpolluted.
            expect((await ledger.accountBalance(prisma, 'fiat:momo:ghs')).balance.toFixed(2)).toBe('1200.00');
            expect((await ledger.accountBalance(prisma, 'equity:treasury:ghs')).balance.toFixed(2)).toBe('1200.00');
            expect((await ledger.accountBalance(prisma, 'custody:deposit:usdc')).balance.toFixed(2)).toBe('-100.00');
            expect((await ledger.accountBalance(prisma, 'equity:treasury')).balance.toFixed(2)).toBe('-100.00');
            expect(r.entries[0].metadata).toBeNull();
        });
        it('exact replay returns the committed conversion; a different identity on the same key is a hard conflict', async () => {
            const params = (identity) => ({
                idempotencyKey: 'p5a:conversion:replay',
                entryType: 'ASSET_CONVERSION',
                description: 'explicit GHS↔USDC exchange',
                conversion: { identity, rate: '12' },
                lines: conversionLegs(),
            });
            const r1 = await prisma.$transaction((tx) => post(tx, params('conv:test:replay-1')));
            expect(r1.replayed).toBe(false);
            const r2 = await prisma.$transaction((tx) => post(tx, params('conv:test:replay-1')));
            expect(r2.replayed).toBe(true);
            expect(r2.transaction.id).toBe(r1.transaction.id);
            await expect(prisma.$transaction((tx) => post(tx, params('conv:test:replay-OTHER'))))
                .rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENCY_CONFLICT' });
            expect(await prisma.ledgerTransaction.count()).toBe(1);
        });
        it('a conversion identity is exactly-once across DIFFERENT postings — never reused', async () => {
            await prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:conversion:first',
                entryType: 'ASSET_CONVERSION',
                description: 'first exchange with identity X',
                conversion: { identity: 'conv:test:shared', rate: '12' },
                lines: conversionLegs(),
            }));
            await expect(prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:conversion:second',
                entryType: 'ASSET_CONVERSION',
                description: 'second exchange attempting the SAME identity',
                conversion: { identity: 'conv:test:shared', rate: '12' },
                lines: conversionLegs(),
            }))).rejects.toMatchObject({ code: 'LEDGER_CONVERSION_IDENTITY_CONFLICT' });
            expect(await prisma.ledgerTransaction.count()).toBe(1);
        });
        it.each([
            ['conversion context missing on ASSET_CONVERSION',
                { code: 'LEDGER_CONVERSION_CONTEXT_REQUIRED', conversion: undefined, entryType: 'ASSET_CONVERSION' }],
            ['conversion context smuggled into a normal entry type',
                { code: 'LEDGER_CONVERSION_ENTRY_TYPE_REQUIRED', conversion: { identity: 'c1', rate: '12' }, entryType: 'TRANSFER' }],
            ['conversion with only one asset',
                { code: 'LEDGER_CONVERSION_SINGLE_ASSET', conversion: { identity: 'c2', rate: '12' }, entryType: 'ASSET_CONVERSION',
                    lines: [{ account: 'custody:hot:usdc', debit: '50' }, { account: 'custody:deposit:usdc', credit: '50' }] }],
            ['conversion leg that does not balance within its own asset (GHS ≠ USDC numerically)',
                { code: 'LEDGER_CONVERSION_LEG_UNBALANCED', conversion: { identity: 'c3', rate: '12' }, entryType: 'ASSET_CONVERSION',
                    lines: [
                        { account: 'fiat:momo:ghs', debit: '1200' },
                        { account: 'equity:treasury:ghs', credit: '1100' }, // GHS leg unbalanced
                        { account: 'equity:treasury', debit: '100' },
                        { account: 'custody:deposit:usdc', credit: '100' },
                    ] }],
            ['zero conversion rate', { code: 'LEDGER_CONVERSION_INVALID', conversion: { identity: 'c4', rate: '0' } }],
            ['missing conversion identity', { code: 'LEDGER_CONVERSION_INVALID', conversion: { rate: '12' } }],
            ['over-precision conversion rate', { code: 'LEDGER_CONVERSION_INVALID', conversion: { identity: 'c5', rate: '0.123456789' } }],
        ])('rejects: %s', async (_label, { code, conversion, entryType = 'ASSET_CONVERSION', lines }) => {
            await expect(prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: `p5a:conversion:invalid:${code}`,
                entryType,
                description: 'invalid conversion attempt',
                conversion,
                lines: lines ?? conversionLegs(),
            }))).rejects.toMatchObject({ code });
            expect(await prisma.ledgerTransaction.count()).toBe(0);
        });
    });
    it('CONCURRENT same conversion identity under DIFFERENT idempotency keys: exactly one commits (DB unique boundary)', async () => {
        const postConversion = (key, identity) => prisma.$transaction(async (tx) => post(tx, {
            idempotencyKey: key,
            entryType: 'ASSET_CONVERSION',
            description: 'concurrent conversion on identity X',
            conversion: { identity, rate: '12' },
            lines: conversionLegs(),
        }));
        // Pre-seed the conversion accounts via one committed exchange so the race
        // exercises the CONVERSION boundary, not first-use account creation.
        await postConversion('p5a:race:seed', 'conv:test:seed');
        const results = await Promise.allSettled([
            postConversion('p5a:race:tx-a', 'conv:test:race'),
            postConversion('p5a:race:tx-b', 'conv:test:race'),
        ]);
        const committed = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(committed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(committed[0].value.replayed).toBe(false);
        expect(rejected[0].reason).toBeInstanceOf(ledger.LedgerError);
        expect(rejected[0].reason.code).toBe('LEDGER_CONVERSION_IDENTITY_CONFLICT');
        // exactly ONE durable row for the raced identity (plus the seed)
        expect(await prisma.ledgerTransaction.count()).toBe(2);
        expect(await prisma.ledgerTransaction.count({ where: { conversionIdentity: 'conv:test:race' } })).toBe(1);
    });
    it.each([
        ['a changed rate', { identity: 'conv:test:prov', rate: '12' }, { identity: 'conv:test:prov', rate: '11.5' }],
        ['a changed quoteReference', { identity: 'conv:test:prov', rate: '12', quoteReference: 'quote-1' }, { identity: 'conv:test:prov', rate: '12', quoteReference: 'quote-OTHER' }],
    ])('same idempotency key + same lines + %s fails closed, never replays', async (_l, first, second) => {
        const attempt = (conv) => prisma.$transaction(async (tx) => post(tx, {
            idempotencyKey: 'p5a:provenance:replay',
            entryType: 'ASSET_CONVERSION',
            description: 'provenance replay attempt',
            conversion: conv,
            lines: conversionLegs(),
        }));
        const r1 = await attempt(first);
        expect(r1.replayed).toBe(false);
        await expect(attempt(second)).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENCY_CONFLICT' });
        expect(await prisma.ledgerTransaction.count()).toBe(1);
    });
    // E. Rollback of the enclosing financial transaction
    it('E. a cross-asset failure rolls back the ENTIRE enclosing transaction — NO partial mutation', async () => {
            const user = await seedUser(prisma, { availableBalance: 50 });
            const accountsBefore = await prisma.ledgerAccount.count();
            const historyBaseline = await prisma.transactionHistory.count(); // seedUser backs the balance with 1 row
            await expect(prisma.$transaction(async (tx) => {
                // Legitimate projection mutations first...
                await tx.user.update({ where: { id: user.id }, data: { availableBalance: { increment: 25 } } });
                await tx.transactionHistory.create({
                    data: { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: 25, feeUsdc: 0, status: 'COMPLETED' },
                });
                // ...then the illegal cross-asset posting throws — everything rolls back.
                await post(tx, {
                    idempotencyKey: 'p5a:rollback:mixed',
                    entryType: 'DEPOSIT',
                    description: 'mixed-asset posting inside a financial mutation',
                    lines: [
                        { account: 'fiat:momo:ghs', debit: '25' },
                        { account: `user:${user.id}:liability`, credit: '25' },
                    ],
                });
            })).rejects.toMatchObject({ code: 'LEDGER_CROSS_ASSET_BALANCE' });
            expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(50);
            expect(await prisma.transactionHistory.count()).toBe(historyBaseline); // the in-tx row rolled back
            expect(await prisma.ledgerTransaction.count()).toBe(0);
            expect(await prisma.journalEntry.count()).toBe(0);
            expect(await prisma.ledgerAccount.count()).toBe(accountsBefore); // no stray catalog mutation
    });
    // F. Inconsistent persisted account metadata fails closed
    describe('F. persisted account identity must agree with the authoritative chart', () => {
        it.each([
            ['tampered asset (row says USDC, chart says GHS)', { asset: 'USDC' }, 'fiat:momo:ghs'],
            ['tampered normalSide (row says DEBIT, chart says CREDIT)', { normalSide: 'DEBIT' }, 'equity:treasury:ghs'],
        ])('%s fails closed', async (_label, tamper, code) => {
            // Seed the catalog rows, then tamper OUTSIDE the ledger's control.
            await prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:identity:seed',
                entryType: 'TRANSFER',
                description: 'seed the catalog rows',
                lines: [
                    { account: 'fiat:momo:ghs', debit: '10' },
                    { account: 'equity:treasury:ghs', credit: '10' },
                ],
            }));
            await prisma.ledgerAccount.update({ where: { code }, data: tamper });
            await expect(prisma.$transaction(async (tx) => post(tx, {
                idempotencyKey: 'p5a:identity:post-tamper',
                entryType: 'TRANSFER',
                description: 'posting against a misclassified account',
                lines: [
                    { account: 'fiat:momo:ghs', debit: '10' },
                    { account: 'equity:treasury:ghs', credit: '10' },
                ],
            }))).rejects.toMatchObject({ code: 'LEDGER_ACCOUNT_IDENTITY_CONFLICT' });
        });
    });
});