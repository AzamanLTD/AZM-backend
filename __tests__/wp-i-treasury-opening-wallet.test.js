'use strict';

/**
 * WP-I — a treasury opening carries the wallet that holds its money.
 *
 * The reconciler refuses an opening with no wallet, so an opening created for a
 * provider-backed deposit must record one at birth. It comes from provider
 * evidence: an explicit provider-derived argument, or the stored payload of the
 * provider observation the opening cites. An internal treasury liquidation has
 * no provider wallet and must stay NULL rather than borrow one.
 */

const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = DB_URL ? describe : describe.skip;

let prisma;
let fiatLiquidity;

jest.setTimeout(60000);

describeDb('WP-I treasury opening wallet binding (real PostgreSQL)', () => {
    beforeAll(() => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        fiatLiquidity = require('../src/services/fiatLiquidityService');
    });

    beforeEach(async () => {
        await prisma.fiatLiquidityReceipt.deleteMany({});
        await prisma.fiatProviderEvent.deleteMany({});
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const record = (args) => prisma.$transaction((tx) => fiatLiquidity.recordReceipt(tx, args));

    test('the wallet is derived from the stored provider observation, not from a caller claim', async () => {
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: 'event:wallet-derive', amountGhs: 99,
                // The provider's own payload, kept verbatim.
                raw: { status: 1, data: { accountnumber: 'WALLET-FROM-PAYLOAD', externalref: 'AZM-1' } },
            },
        });

        const { receipt } = await record({
            provider: 'MOOLRE', dedupKey: 'treasury:wallet-derive',
            amountGhs: 99, treasury: true, eventDedupKey: 'event:wallet-derive',
        });

        expect(receipt.walletAccount).toBe('WALLET-FROM-PAYLOAD');
    });

    test('an explicit provider-derived wallet is recorded as given', async () => {
        const { receipt } = await record({
            provider: 'MOOLRE', dedupKey: 'treasury:wallet-explicit',
            amountGhs: 50, treasury: true, walletAccount: '0244000004',
        });

        expect(receipt.walletAccount).toBe('0244000004');
    });

    test('an internal liquidation has no wallet and never borrows one', async () => {
        const { receipt } = await record({
            provider: 'AZM_TREASURY', rail: 'INTERNAL', dedupKey: 'treasury:internal',
            amountGhs: 25, treasury: true, evidence: { kind: 'AUDITED_TREASURY_OPENING' },
        });

        expect(receipt.walletAccount).toBeNull();
    });

    test('an observation with no account number leaves the opening without a wallet', async () => {
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: 'event:no-account', amountGhs: 10,
                raw: { status: 1, data: { externalref: 'AZM-2' } },
            },
        });

        const { receipt } = await record({
            provider: 'MOOLRE', dedupKey: 'treasury:no-account',
            amountGhs: 10, treasury: true, eventDedupKey: 'event:no-account',
        });

        expect(receipt.walletAccount).toBeNull();
    });
});
