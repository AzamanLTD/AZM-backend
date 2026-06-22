// __tests__/helpers/factories.js
// =============================================================================
// Test data factories — seed real rows in a disposable PostgreSQL test DB.
//
// Used by the DB-backed suites (escrow-flow, business-orders, trade-flow). Each
// factory takes the test's PrismaClient as its first arg so the suites control
// the connection (DATABASE_URL = TEST_DATABASE_URL).
//
// IMPORTANT: these are written against the ACTUAL prisma/schema.prisma, not the
// idealised shapes in the design doc. Verified field/relationship facts:
//   • User requires only username/email/password; balances/azamanId are optional.
//   • Trade has NO buyerId/adId/fee/exchangeRate/cryptoCurrency columns. It uses
//     userId (buyer) + vendorId, crypto, amountCrypto/amountFiat, rate, type,
//     currency, paymentMethod, and a REQUIRED expiresAt.
//   • On a SELL ad the BUYER (user) escrows USDC and the VENDOR releases &
//     receives — so seedPaidTrade locks the buyer's escrow and releases as vendor.
//   • Ad uses pricePerUSD/minLimit/maxLimit (not price/min/max), status string.
//   • SmartEscrow.feeUsdc is platform revenue and is NOT locked; only the
//     principal (amountUsdc) sits in escrowLockedBalance once FUNDED.
// =============================================================================

const bcrypt = require('bcryptjs');

const TEST_PASSWORD = 'TestPass1!secure'; // upper + number + special — passes validateRegisterInput

// Monotonic suffix so parallel/repeat creates never collide on unique columns.
let _seq = 0;
const _uniq = () => `${Date.now()}_${++_seq}`;

async function seedUser(prisma, overrides = {}) {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const id = _uniq();
    const { availableBalance, escrowLockedBalance, disputeEscrowBalance, azamanId, ...rest } = overrides;
    const startingBalance = availableBalance ?? 1000.0;
    const user = await prisma.user.create({
        data: {
            username: overrides.username || `user_${id}`,
            email: overrides.email || `user_${id}@test.com`,
            password: hash,
            availableBalance: startingBalance,
            escrowLockedBalance: escrowLockedBalance ?? 0.0,
            disputeEscrowBalance: disputeEscrowBalance ?? 0.0,
            azamanId: azamanId || `AZM-TEST-${id}`,
            ...rest,
        },
    });

    // LEDGER CONSISTENCY: utils/securityCheck.runDoubleCheck (run pre-flight by
    // fundEscrow/withdrawals) recomputes availableBalance from the sum of the
    // user's COMPLETED TransactionHistory rows. A seeded balance with no backing
    // ledger row trips that audit, so back any positive starting balance with a
    // single COMPLETED deposit of exactly that amount. escrowLockedBalance /
    // disputeEscrowBalance are NOT part of the audit and need no ledger row.
    if (Number(startingBalance) > 0) {
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'DEPOSIT_CRYPTO',
                amountUsdc: startingBalance,
                feeUsdc: 0,
                status: 'COMPLETED',
            },
        });
    }

    return user;
}

async function seedVendor(prisma, overrides = {}) {
    return seedUser(prisma, { role: 'VENDOR', ...overrides });
}

// Creates a PAID SELL trade ready for p2p.service.completeTrade().
// On a SELL ad the buyer (user) has escrowed `amountCrypto`; the vendor is the
// releasing party and receives the net. Returns the ids completeTrade needs.
async function seedPaidTrade(prisma, overrides = {}) {
    const amountCrypto = overrides.amountCrypto ?? 100;
    const rate = overrides.rate ?? 15.5;

    const buyer = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: amountCrypto });
    const vendor = await seedVendor(prisma, { availableBalance: 0 });

    const ad = await prisma.ad.create({
        data: {
            vendorId: vendor.id,
            type: 'SELL',
            crypto: 'USDT',
            pricePerUSD: rate,
            minLimit: 10,
            maxLimit: 500,
            paymentMethod: 'Bank Transfer',
            status: 'ACTIVE',
        },
    });

    const trade = await prisma.trade.create({
        data: {
            userId: buyer.id,
            vendorId: vendor.id,
            type: 'SELL',
            crypto: 'USDT',
            amountCrypto,
            amountFiat: amountCrypto * rate,
            currency: 'GHS',
            rate,
            paymentMethod: 'Bank Transfer',
            status: 'PAID',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
    });

    return {
        trade,
        ad,
        buyer,
        vendor,
        tradeId: trade.id,
        // SELL ad → the vendor releases the asset.
        releasedByUserId: vendor.id,
        vendorId: vendor.id,
        buyerId: buyer.id,
        amountCrypto,
    };
}

// Creates a verified business profile + one active product.
async function seedBusiness(prisma, overrides = {}) {
    const owner = await seedUser(prisma, overrides.owner || {});
    const id = _uniq();
    const biz = await prisma.businessProfile.create({
        data: {
            userId: owner.id,
            businessName: overrides.businessName || `Test Business ${id}`,
            bizId: `BIZ-TEST-${id}`,
            category: 'FREELANCE_SERVICES',
            kybStatus: 'VERIFIED',
            isVerified: true,
        },
    });
    const product = await prisma.businessProduct.create({
        data: {
            businessProfileId: biz.id,
            name: 'Test Product',
            priceUsdc: 50.0,
            slug: `test-product-${id}`,
            isActive: true,
        },
    });
    return { owner, biz, product };
}

// Creates a Friendship → ESCROW Ticket → SmartEscrow in the requested status.
// For a FUNDED-ish escrow the payer's principal sits in escrowLockedBalance
// (the fee is NOT locked); for DRAFT no money has moved so the payer simply
// holds spendable availableBalance.
async function seedEscrowTicket(prisma, escrowStatus = 'FUNDED', overrides = {}) {
    const amountUsdc = overrides.amountUsdc ?? 50.0;
    const feeUsdc = overrides.feeUsdc ?? 0.25;
    const isDraft = escrowStatus === 'DRAFT';

    const payer = await seedUser(prisma, {
        availableBalance: isDraft ? 200 : 0,
        escrowLockedBalance: isDraft ? 0 : amountUsdc,
    });
    const payee = await seedUser(prisma);

    const friendship = await prisma.friendship.create({
        data: { requesterId: payer.id, addresseeId: payee.id, status: 'ACCEPTED' },
    });

    const ticket = await prisma.ticket.create({
        data: {
            friendshipId: friendship.id,
            creatorId: payer.id,
            counterpartyId: payee.id,
            name: 'Test Escrow',
            type: 'ESCROW',
            targetAmount: amountUsdc,
            targetCurrency: 'USDC',
            status: 'OPEN',
            lastActivityAt: new Date(),
        },
    });

    const escrow = await prisma.smartEscrow.create({
        data: {
            ticketId: ticket.id,
            payerId: payer.id,
            payeeId: payee.id,
            amountUsdc,
            feeUsdc,
            status: escrowStatus,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            ...(isDraft ? {} : { fundedAt: new Date() }),
            ...(overrides.escrow || {}),
        },
    });

    return { payer, payee, friendship, ticket, escrow };
}

// ── Savings + AZM factories (Backend Completion Sprint, 2026-06-22) ───────────
// Adapted to the ACTUAL prisma/schema.prisma, NOT the design-doc shapes:
//   • SavingsGoal requires only targetAmountGhs + frequencyAmount; the lock
//     semantics are isLocked (bool) + endDate (maturity), NOT the doc's
//     `lockUntil`. The penalty field is earlyWithdrawalPenalty (default 0.02).
//     status/streak/missed columns all default, so we set only what tests read.
//   • There is NO AzmEarnLog model — the reward audit table is AzmRewardLog
//     (fields amount/reason/source/balanceAfter). azmBalance lives on User and
//     is independent of the USDC balances.

/**
 * seedSavingsGoal — create a user + an ACTIVE savings goal.
 * @param {PrismaClient} prisma
 * @param {object} overrides
 *   user: overrides forwarded to seedUser (e.g. { availableBalance: 300 })
 *   goal: overrides forwarded to savingsGoal.create. Lock/maturity is expressed
 *         with isLocked (bool) + endDate (a past endDate → matured → no penalty;
 *         a future/null endDate while isLocked → early withdrawal → penalty).
 * @returns {{ user, goal }}
 */
async function seedSavingsGoal(prisma, overrides = {}) {
    const user = await seedUser(prisma, overrides.user || { availableBalance: 500 });
    const id = _uniq();
    const g = overrides.goal || {};
    const goal = await prisma.savingsGoal.create({
        data: {
            userId:                 user.id,
            name:                   g.name ?? `Test Goal ${id}`,
            targetAmountGhs:        g.targetAmountGhs ?? 1000,
            currentAmountGhs:       g.currentAmountGhs ?? 0,
            frequencyAmount:        g.frequencyAmount ?? 50,
            frequency:              g.frequency ?? 'WEEKLY',
            nextDueDate:            g.nextDueDate ?? new Date(Date.now() + 7 * 86400000),
            endDate:                g.endDate ?? null,
            isLocked:               g.isLocked ?? true,
            earlyWithdrawalPenalty: g.earlyWithdrawalPenalty ?? 0.05, // 5%
            status:                 g.status ?? 'ACTIVE',
        },
    });
    return { user, goal };
}

/**
 * seedAzmBalance — create a user with a known azmBalance (AZM loyalty points).
 * Used by the AZM economy tests. Best-effort writes a backing AzmRewardLog row
 * (the real reward-audit table) so history endpoints return sensible data;
 * swallowed if the table is absent in an older schema snapshot.
 * @returns the created user object with azmBalance overlaid as a plain number.
 */
async function seedAzmBalance(prisma, azmBalance = 100, overrides = {}) {
    const user = await seedUser(prisma, overrides);
    await prisma.user.update({
        where: { id: user.id },
        data:  { azmBalance },
    });
    try {
        await prisma.azmRewardLog.create({
            data: {
                userId:       user.id,
                amount:       azmBalance,
                reason:       'Seeded test balance',
                source:       'SEED',
                balanceAfter: azmBalance,
            },
        });
    } catch (_) {
        // Table might not exist in older schema snapshots — swallow gracefully.
    }
    return { ...user, azmBalance };
}

module.exports = {
    TEST_PASSWORD,
    seedUser,
    seedVendor,
    seedPaidTrade,
    seedBusiness,
    seedEscrowTicket,
    seedSavingsGoal,   // NEW
    seedAzmBalance,    // NEW
};
