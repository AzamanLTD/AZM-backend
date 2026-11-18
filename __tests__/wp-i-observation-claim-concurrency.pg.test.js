// __tests__/wp-i-observation-claim-concurrency.pg.test.js
// =============================================================================
// §WP-I — THE CROSS-PATH CLAIM, PROVEN ON REAL POSTGRESQL
//
// The defect: the treasury witness refused a payment that had "already settled a
// customer deposit" by READING the deposit table inside its own transaction, and
// the deposit path did the mirror image. Two concurrent transactions can both
// read "not used yet" and both commit — one Moolre payment, two economic uses.
//
// These tests run REAL transactions against REAL PostgreSQL through the REAL
// claim service, with the two competing operations genuinely overlapping around
// the claim (each holds its transaction open after claiming). Nothing is mocked
// and no test depends on which side wins.
// =============================================================================
'use strict';

const DB_URL = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (!DB_URL) {
    if (IS_CI) {
        test('WP-I observation claim requires TEST_DATABASE_URL in CI', () => {
            throw new Error('TEST_DATABASE_URL is not set: a skipped concurrency proof must not look like a green build');
        });
    }
}

const run = DB_URL ? describe : describe.skip;

run('§WP-I — provider observation claim (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { claimProviderObservation, CLAIM_PURPOSE, ProviderObservationClaimError } =
        require('../src/services/providerObservationClaimService');

    let prisma;
    const createdKeys = [];

    const refFor = (tag) => {
        const ref = `claim-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        createdKeys.push(`moolre|collection|${ref}`);
        return ref;
    };

    beforeAll(async () => {
        prisma = new PrismaClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        if (prisma) {
            if (createdKeys.length) {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: { in: createdKeys } } });
            }
            await prisma.$disconnect();
        }
    });

    /** One competing economic operation: claim, then write a marker, then commit. */
    async function depositSide(reference, ownerRef) {
        return prisma.$transaction(async (tx) => {
            await claimProviderObservation(tx, {
                provider: 'moolre',
                reference,
                purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT,
                claimedByRef: ownerRef,
            });
            await new Promise((r) => setTimeout(r, 40));   // hold the claim open
            await tx.fiatProviderEvent.create({
                data: {
                    provider: 'MOOLRE', direction: 'INBOUND', status: 'SETTLED',
                    dedupKey: `race:deposit:${ownerRef}`, providerRef: reference,
                    amountGhs: 1.00,
                },
            });
            return 'deposit';
        }, { timeout: 20000 });
    }

    async function treasurySide(reference, ownerRef) {
        return prisma.$transaction(async (tx) => {
            await claimProviderObservation(tx, {
                provider: 'moolre',
                reference,
                purpose: CLAIM_PURPOSE.TREASURY_WITNESS,
                claimedByRef: ownerRef,
            });
            await new Promise((r) => setTimeout(r, 40));   // hold the claim open
            await tx.fiatProviderEvent.create({
                data: {
                    provider: 'MOOLRE', direction: 'INBOUND', status: 'SETTLED',
                    dedupKey: `race:treasury:${ownerRef}`, providerRef: reference,
                    amountGhs: 1.00,
                },
            });
            return 'treasury';
        }, { timeout: 20000 });
    }

    test('one observation, two economic uses: exactly one commits, the loser leaves nothing behind', async () => {
        for (let i = 0; i < 5; i += 1) {
            const reference = refFor(`race-${i}`);
            const depositRef = `dep-${Date.now()}-${i}`;
            const treasuryRef = `open-${Date.now()}-${i}`;

            const results = await Promise.allSettled([
                depositSide(reference, depositRef),
                treasurySide(reference, treasuryRef),
            ]);

            const fulfilled = results.filter((r) => r.status === 'fulfilled');
            const rejected = results.filter((r) => r.status === 'rejected');

            // 1 + 2: exactly one economic use wins; the other gets a typed conflict.
            expect(fulfilled.length).toBe(1);
            expect(rejected.length).toBe(1);
            expect(rejected[0].reason).toBeInstanceOf(ProviderObservationClaimError);
            expect(rejected[0].reason.code).toBe('OBSERVATION_SPENT_BY_OTHER_PATH');

            // 8: no stranded or duplicate claim.
            const claims = await prisma.providerObservationClaim.findMany({
                where: { observationKey: `moolre|collection|${reference}` },
            });
            expect(claims.length).toBe(1);

            // 4/5/6/7: the loser left no marker, so its "credit" cannot exist.
            const winner = fulfilled[0].value;
            const markers = await prisma.fiatProviderEvent.findMany({
                where: { dedupKey: { in: [`race:deposit:${depositRef}`, `race:treasury:${treasuryRef}`] } },
                select: { dedupKey: true },
            });
            expect(markers.length).toBe(1);
            expect(markers[0].dedupKey).toBe(winner === 'deposit' ? `race:deposit:${depositRef}` : `race:treasury:${treasuryRef}`);

            // 9 + 10: the winner may retry safely; the OTHER use still may not.
            const winnerPurpose = winner === 'deposit' ? CLAIM_PURPOSE.CUSTOMER_DEPOSIT : CLAIM_PURPOSE.TREASURY_WITNESS;
            const winnerOwner = winner === 'deposit' ? depositRef : treasuryRef;
            const retry = await prisma.$transaction((tx) => claimProviderObservation(tx, {
                provider: 'moolre', reference, purpose: winnerPurpose, claimedByRef: winnerOwner,
            }));
            expect(retry.claimed).toBe(false);
            expect(retry.samePathRetry).toBe(true);

            const losingPurpose = winner === 'deposit' ? CLAIM_PURPOSE.TREASURY_WITNESS : CLAIM_PURPOSE.CUSTOMER_DEPOSIT;
            await expect(prisma.$transaction((tx) => claimProviderObservation(tx, {
                provider: 'moolre', reference, purpose: losingPurpose, claimedByRef: 'other-owner',
            }))).rejects.toMatchObject({ code: 'OBSERVATION_SPENT_BY_OTHER_PATH' });
        }
    }, 120000);

    test('a claim whose transaction fails is rolled back, and the other path can then succeed', async () => {
        const reference = refFor('rollback');
        await expect(prisma.$transaction(async (tx) => {
            await claimProviderObservation(tx, {
                provider: 'moolre', reference,
                purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-rollback',
            });
            throw new Error('economic step failed after the claim');
        })).rejects.toThrow('economic step failed after the claim');

        const afterFailure = await prisma.providerObservationClaim.findMany({
            where: { observationKey: `moolre|collection|${reference}` },
        });
        expect(afterFailure.length).toBe(0);

        const claimed = await prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference,
            purpose: CLAIM_PURPOSE.TREASURY_WITNESS, claimedByRef: 'open-after-rollback',
        }));
        expect(claimed.claimed).toBe(true);
    }, 60000);

    test('different observations never collide, and one pays only once', async () => {
        const a = refFor('distinct-a');
        const b = refFor('distinct-b');
        const ra = await prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference: a, purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-a',
        }));
        const rb = await prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference: b, purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-b',
        }));
        expect(ra.claimed).toBe(true);
        expect(rb.claimed).toBe(true);
    }, 60000);

    test('an unidentifiable observation is refused rather than claimed', async () => {
        await expect(prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference: '   ', purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-x',
        }))).rejects.toMatchObject({ code: 'OBSERVATION_REFERENCE_MISSING' });

        await expect(prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'unknownpay', reference: 'abc-123', purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-x',
        }))).rejects.toMatchObject({ code: 'OBSERVATION_PROVIDER_UNSUPPORTED' });
    }, 60000);

    test('the same reference observed against a different account is refused for review, not merged', async () => {
        const reference = refFor('account');
        await prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference, accountNumber: '0244000001',
            purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-acct',
        }));
        await expect(prisma.$transaction((tx) => claimProviderObservation(tx, {
            provider: 'moolre', reference, accountNumber: '0244000002',
            purpose: CLAIM_PURPOSE.CUSTOMER_DEPOSIT, claimedByRef: 'dep-acct',
        }))).rejects.toMatchObject({ code: 'OBSERVATION_ACCOUNT_MISMATCH' });
    }, 60000);
});
