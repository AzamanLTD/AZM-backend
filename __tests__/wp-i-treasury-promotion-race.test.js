'use strict';

/**
 * WP-I — concurrent treasury promotion (real PostgreSQL).
 *
 * Two confirmations of the same opening must not both increment availableGhs.
 * A witness makes the opening fundable; it does not make it fundable TWICE.
 */

const { PrismaClient } = require('@prisma/client');
const fiatLiquidity = require('../src/services/fiatLiquidityService');
const {
    recordProviderSettlementWitness,
} = require('../src/services/providerSettlementWitnessService');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
const describeDb = URL ? describe : describe.skip;

const OPENING = 'treasury:race:1';
const EVENT = 'event:race:1';
const AMOUNT = 300;

async function state() {
    return prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
}

describeDb('WP-I treasury promotion race (real PostgreSQL)', () => {
    beforeAll(() => {
        process.env.AZM_RECONCILER_MODE = '1';
        process.env.AZM_RECONCILER_PROVIDER_KEY = 'race-test-key';
    });

    beforeEach(async () => {
        await prisma.providerSettlementWitness.deleteMany();
        await prisma.fiatProviderEvent.deleteMany();
        await prisma.fiatLiquidityReceipt.deleteMany();
        await prisma.fiatLiquidityReservation.deleteMany();
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 0 },
            create: { id: 1, availableGhs: 0 },
        });

        await prisma.$transaction((tx) => fiatLiquidity.recordReceipt(tx, {
            provider: 'AZM_TREASURY',
            rail: 'INTERNAL',
            dedupKey: OPENING,
            amountGhs: AMOUNT,
            treasury: true,
            evidence: { kind: 'AUDITED_TREASURY_OPENING' },
        }));
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', rail: 'BANK', direction: 'INBOUND', status: 'FUNDED',
                providerRef: 'RACE-REF-1', dedupKey: EVENT, amountGhs: AMOUNT,
            },
        });
        const payload = { state: 'SETTLED', value: String(AMOUNT.toFixed(2)) };
        await prisma.$transaction((tx) => recordProviderSettlementWitness(tx, {
            openingDedupKey: OPENING,
            provider: 'MOOLRE',
            fundingType: 'COLLECTION',
            endpoint: 'https://api.moolre.com/open/transact/status',
            requestParams: { id: 'RACE-REF-1' },
            rawResponse: JSON.stringify(payload),
            providerPayload: payload,
            fetchedAt: new Date(),
            walletAccount: '0244000000',
            currencyMapping: { '0244000000': 'GHS' },
        }));
    }, 60000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    test('five concurrent confirmations credit the pool exactly once', async () => {
        const confirm = () => prisma.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
            dedupKey: OPENING, confirmedBy: 1, providerEventDedupKey: EVENT,
        }), { timeout: 20000 });

        const results = await Promise.allSettled([confirm(), confirm(), confirm(), confirm(), confirm()]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        const after = await state();
        // THE invariant: never double-credit, whatever the interleaving.
        expect(Number(after.availableGhs)).toBe(AMOUNT);

        // At most one of them may have performed the transition.
        const nonReplay = fulfilled.filter((r) => r.value && r.value.replay === false);
        expect(nonReplay.length).toBeLessThanOrEqual(1);
        if (rejected.length) {
            // A loser may fail truthfully rather than silently double-apply.
            expect(rejected[0].reason).toBeTruthy();
        }
    }, 60000);
});
