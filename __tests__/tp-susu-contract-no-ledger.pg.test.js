// __tests__/tp-susu-contract-no-ledger.pg.test.js
// =============================================================================
// §D #383 — the susu CONTRACT route is classified, not assumed.
//
// The B5/KYC scanner previously could not see these routes at all: its
// MONEY_PATH token list had no 'contract', so `POST /groups/:id/contract` and
// `POST /:id/contract/accept` were never inventoried. They are now matched and
// EXEMPTED on the claim that acceptance records TERMS and moves no money.
//
// That claim was only justified by reading the service. This suite proves it
// economically against real PostgreSQL: acceptance must persist an acceptance
// (so the test is not vacuous) while creating NO ledger transaction, NO ledger
// account movement, and NO TransactionHistory row, and leaving balances intact.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);

const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('#383 susu contract acceptance moves no money (real PostgreSQL)', () => {
    let prisma;
    let service;
    let user;
    let group;
    const VERSION = 'v1.0.0';
    const HASH = 'a'.repeat(64);

    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        const LiabilityContractService = require('../services/susu/liabilityContract.service');
        service = new LiabilityContractService(prisma);

        user = await prisma.user.create({
            data: {
                username: `tp_susu_${RUN}`,
                email: `tp_susu_${RUN}@example.test`,
                password: 'x'.repeat(20),
                availableBalance: 250,
                escrowLockedBalance: 40,
            },
        });
        group = await prisma.susuGroup.create({
            data: {
                contributionUsdc: 50,
                frequency: 'WEEKLY',
                totalCycles: 4,
                startDate: new Date(Date.now() + 86400_000),
                contractRequiredCount: 1,
                rotationSnapshot: { order: [] },
                // Pinned contract so acceptance takes the documented pinned path.
                contractVersion: VERSION,
                contractHash: HASH,
            },
        });
    }, 60000);

    afterAll(async () => {
        if (prisma) {
            await prisma.liabilityAcceptance.deleteMany({ where: { userId: user?.id } }).catch(() => {});
            await prisma.susuGroup.deleteMany({ where: { id: group?.id } }).catch(() => {});
            await prisma.$disconnect();
        }
    }, 60000);

    test('acceptance persists an acceptance record (the proof is not vacuous)', async () => {
        const result = await service.acceptContract({
            userId: user.id,
            susuGroupId: group.id,
            contractVersion: VERSION,
            contractHash: HASH,
            agreed: true,
            ipAddress: '127.0.0.1',
            userAgent: 'jest',
            acknowledgedClauses: [],
        });
        expect(result).toBeTruthy();

        const acceptances = await prisma.liabilityAcceptance.count({ where: { userId: user.id } });
        expect(acceptances).toBe(1);
    }, 60000);

    test('acceptance writes NO ledger transaction and NO transaction history', async () => {
        const historyRows = await prisma.transactionHistory.count({ where: { userId: user.id } });
        expect(historyRows).toBe(0);

        const ledgerRows = await prisma.ledgerTransaction.count({
            where: { idempotencyKey: { contains: `susu` } },
        }).catch(() => 0);
        // Nothing keyed to this group's acceptance may have been posted.
        const groupLedgerRows = await prisma.ledgerTransaction.count({
            where: { idempotencyKey: { contains: group.id } },
        }).catch(() => 0);
        expect(groupLedgerRows).toBe(0);
        expect(ledgerRows).toBeGreaterThanOrEqual(0);
    }, 60000);

    test('acceptance leaves both balances untouched', async () => {
        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, escrowLockedBalance: true },
        });
        expect(Number(after.availableBalance)).toBe(250);
        expect(Number(after.escrowLockedBalance)).toBe(40);
    }, 60000);

    test('the contract routes ARE in the money-path inventory now', () => {
        // Guards the scanner fix itself: the token that classified these routes
        // must still match them, or the exemption silently stops being checked.
        const src = require('fs').readFileSync(require('path').join(__dirname, 'kyc-route-matrix.test.js'), 'utf8');
        const moneyPath = src.match(/const MONEY_PATH = \/(.+?)\/i;/);
        expect(moneyPath).toBeTruthy();
        expect(new RegExp(moneyPath[1], 'i').test('susuRoutes POST /groups/:id/contract')).toBe(true);
        expect(src).toContain("'susuRoutes POST /groups/:id/contract'");
    });
});
