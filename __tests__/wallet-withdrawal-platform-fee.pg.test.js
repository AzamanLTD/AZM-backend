'use strict';

// =============================================================================
// The wallet withdrawal platform fee (GlobalSettings.cryptoPlatformFeePct, set
// in the Fee Lab), end to end on real PostgreSQL.
//
// It was locked at 0%: the profit log wrote source CRYPTO_WITHDRAWAL_FEE,
// which is not a ProfitSource value, so any fee above 0% made every
// POST /api/wallet/withdraw fail. And an admin rejection refunded the full
// amount out of the reserve, which only holds the amount less the fee.
//
//  F1. A 1% fee: the customer is debited the amount, the fee is booked under
//      WITHDRAWAL_FEE linked to the withdrawal, the profit bucket grows by
//      it, and the reserve holds the amount less the fee.
//  F2. An admin rejection gives back everything: the customer is whole, the
//      bucket is back, the fee's profit entry is reversed once, the reserve
//      and treasury lines net to zero, and the obligation is cancelled.
//  F3. At 0% nothing is booked and a rejection works as before.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('wallet withdrawal platform fee (PostgreSQL)', () => {
    let prisma;
    let wallet;
    let admin;
    let ledger;

    const call = (handler, { user, body = {}, params = {} }) => new Promise((resolve, reject) => {
        const settings = { prisma, socketio: null, emitBalanceUpdate: null, notificationService: { sendNotification: async () => {} } };
        const app = { get: (k) => (k in settings ? settings[k] : null) };
        const req = { app, body, params, user, headers: {}, get: () => undefined, ip: '127.0.0.1' };
        const res = {
            statusCode: 200, locals: {}, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { if (!this.headersSent) { this.headersSent = true; resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(b)) }); } return this; },
            setHeader() {},
            end() { resolve({ status: this.statusCode, body: null }); return this; },
        };
        Promise.resolve(handler(req, res)).catch(reject);
    });

    const setFee = (fee) => prisma.globalSettings.upsert({
        where: { id: 1 }, update: { cryptoPlatformFeePct: fee }, create: { id: 1, cryptoPlatformFeePct: fee },
    });
    const bucket = async () => {
        const row = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        return new Prisma.Decimal(row ? row.balance : 0);
    };
    const acct = async (code) => (await ledger.accountBalance(prisma, code)).netDebit;
    const balanceOf = async (id) => new Prisma.Decimal((await prisma.user.findUnique({ where: { id } })).availableBalance);
    const withdraw = (user, amount) => call(wallet.requestWithdrawal, {
        user: { id: user.id, username: user.username },
        body: { amount, destination: '123456789', destinationType: 'BINANCE_PAY_ID' },
    });
    const reject = (adminUser, id) => call(admin.rejectWithdrawal, {
        user: { id: adminUser.id, username: adminUser.username, role: 'ADMIN' },
        params: { id: String(id) },
        body: { reason: 'Destination could not be verified' },
    });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        wallet = require('../controllers/walletController');
        admin = require('../controllers/adminController');
        ledger = require('../services/ledgerService');
    });

    afterAll(async () => {
        if (prisma) {
            await setFee('0');
            await prisma.$disconnect();
        }
    });

    test('F1 + F2: a 1% fee is booked against the withdrawal, and a rejection gives all of it back', async () => {
        await setFee('0.01');
        const customer = await seedUser(prisma, { availableBalance: 100 });
        const adminUser = await seedUser(prisma, { role: 'ADMIN', availableBalance: 0 });
        const bucket0 = await bucket();
        const reserves0 = await acct('restricted:reserves');
        const treasury0 = await acct('equity:treasury');

        const out = await withdraw(customer, '50');
        expect(out.status).toBe(200);
        const id = out.body.withdrawal.id;

        // F1
        expect((await balanceOf(customer.id)).toFixed(8)).toBe('50.00000000');
        const logs = await prisma.adminProfitLog.findMany({ where: { relatedTxId: `wallet_wd_fee_${id}` } });
        expect(logs).toHaveLength(1);
        expect(logs[0].source).toBe('WITHDRAWAL_FEE');
        expect(new Prisma.Decimal(logs[0].amountUsdc).toFixed(8)).toBe('0.50000000');
        expect((await bucket()).minus(bucket0).toFixed(8)).toBe('0.50000000');
        const obligation = await prisma.restrictedObligation.findFirst({ where: { sourceEntity: 'withdrawal', sourceEntityId: String(id) } });
        expect(new Prisma.Decimal(obligation.amount).toFixed(8)).toBe('49.50000000');

        // F2
        const rejected = await reject(adminUser, id);
        expect(rejected.status).toBe(200);
        expect((await balanceOf(customer.id)).toFixed(8)).toBe('100.00000000');
        expect((await bucket()).minus(bucket0).toFixed(8)).toBe('0.00000000');
        const reversal = await prisma.adminProfitLog.findMany({ where: { relatedTxId: `wallet_wd_fee_reversal_${id}` } });
        expect(reversal).toHaveLength(1);
        expect(reversal[0].source).toBe('WITHDRAWAL_FEE');
        expect(new Prisma.Decimal(reversal[0].amountUsdc).toFixed(8)).toBe('-0.50000000');
        expect((await acct('restricted:reserves')).minus(reserves0).toFixed(8)).toBe('0.00000000');
        expect((await acct('equity:treasury')).minus(treasury0).toFixed(8)).toBe('0.00000000');
        const after = await prisma.restrictedObligation.findUnique({ where: { id: obligation.id } });
        expect(after.status).toBe('CANCELLED');
        expect((await prisma.withdrawal.findUnique({ where: { id } })).status).toBe('REJECTED');

        // A second rejection changes nothing.
        const again = await reject(adminUser, id);
        expect(again.status).toBe(400);
        expect((await balanceOf(customer.id)).toFixed(8)).toBe('100.00000000');
        expect(await prisma.adminProfitLog.count({ where: { relatedTxId: `wallet_wd_fee_reversal_${id}` } })).toBe(1);
    });

    test('F3: at 0% nothing is booked and a rejection works as before', async () => {
        await setFee('0');
        const customer = await seedUser(prisma, { availableBalance: 40 });
        const adminUser = await seedUser(prisma, { role: 'ADMIN', availableBalance: 0 });
        const reserves0 = await acct('restricted:reserves');

        const out = await withdraw(customer, '10');
        expect(out.status).toBe(200);
        const id = out.body.withdrawal.id;
        expect(await prisma.adminProfitLog.count({ where: { relatedTxId: { startsWith: `wallet_wd_fee_` }, AND: [{ relatedTxId: { endsWith: `_${id}` } }] } })).toBe(0);

        const rejected = await reject(adminUser, id);
        expect(rejected.status).toBe(200);
        expect((await balanceOf(customer.id)).toFixed(8)).toBe('40.00000000');
        expect((await acct('restricted:reserves')).minus(reserves0).toFixed(8)).toBe('0.00000000');
    });
});
