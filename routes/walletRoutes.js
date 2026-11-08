// routes/walletRoutes.js
// =============================================================================
// AZAMAN V2 — WALLET ROUTES
// Mounted at /api/wallet. Reads are JWT-only (banned users keep read-only
// access); writes go through the ban guard.
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

// ── §r42.2 EXACT USDC INPUT (internal-transfer) ──────────────────────────
// Every balance column on this path is Decimal(20, 8). The old handler ran
// `parseFloat` on the request and then handed that double to Prisma for BOTH
// balance mutations: the number that was validated was not necessarily the
// number that moved (values above 2^53 lost precision at JSON.parse, and a
// 9-dp input was silently rounded by NUMERIC(20,8) AFTER the negative-balance
// guard had already compared the unrounded double). The amount is now parsed
// into a Decimal ONCE and that same Decimal is what is compared, debited,
// credited, posted to the ledger and recorded in history.
const USDC_DP = 8;
// Decimal(20,8) holds 12 integer digits; the bound makes an out-of-range
// amount a deterministic 400 instead of a database error mid-transaction.
const USDC_MAX_EXCLUSIVE = new Prisma.Decimal('1000000000000');

// §r42.3 — money representation at the boundary.
//
// A DECIMAL STRING is the authoritative input: it is parsed exactly, however
// many digits it carries. A JSON number is still accepted for existing clients
// (the Flutter vendor dashboard sends `'amount': <double>`), but only when the
// value is EXACTLY representable at 8 decimal places. Above
// 2^53 / 10^8 ≈ 90,071,992.5474 USDC a double cannot express every 8-dp
// amount, and the digits JSON.parse already destroyed cannot be recovered by
// converting the surviving number to a string. Such a request is refused
// (USDC_AMOUNT_STRING_REQUIRED) instead of being silently rounded: fail closed,
// never guess.
// Fidelity limit for a FRACTIONAL JSON number. A double whose magnitude is at
// or above 2^25 has an ulp of 2^-26 ≈ 1.49e-8, i.e. WIDER than one 8-dp step,
// so a fractional amount there can silently lose its last digit during
// JSON.parse — 100000000.00000002 arrives as ...00000001. Such amounts must be
// sent as decimal strings. Whole numbers stay exact as doubles well beyond
// this point, so an integer input is not subject to the limit.
const USDC_NUMBER_FRACTION_MAX_MAGNITUDE = 2 ** 25; // 33,554,432 USDC

function toExactUsdcAmount(value) {
    if (value === null || value === undefined || value === '') {
        return { error: 'amount must be a positive number.', code: 'USDC_AMOUNT_REQUIRED' };
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return { error: 'amount must be a positive number.', code: 'USDC_AMOUNT_INVALID' };
        }
        // A fractional value accepted here survives JSON parsing exactly at
        // 8dp; one that cannot is refused and must be sent as a string.
        if (!Number.isInteger(value) && Math.abs(value) >= USDC_NUMBER_FRACTION_MAX_MAGNITUDE) {
            return {
                error: 'amount must be sent as a decimal string: this JSON number carries more precision than a double can represent at 8 decimal places.',
                code: 'USDC_AMOUNT_STRING_REQUIRED',
            };
        }
    }
    let d;
    try {
        // String() first: a string stays exactly what the client sent; an
        // accepted JSON number becomes its shortest round-trip decimal. This
        // does NOT restore digits the JSON parser already dropped — that is
        // why an over-precise number is refused above rather than converted.
        d = new Prisma.Decimal(String(value));
    } catch (_) {
        return { error: 'amount must be a positive number.', code: 'USDC_AMOUNT_INVALID' };
    }
    if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
        return { error: 'amount must be a positive number.', code: 'USDC_AMOUNT_INVALID' };
    }
    if (!d.equals(d.toDecimalPlaces(USDC_DP))) {
        return {
            error: `amount must be an exact ${USDC_DP}-decimal USDC figure; sub-${USDC_DP}dp precision is refused rather than rounded.`,
            code: 'USDC_AMOUNT_PRECISION',
        };
    }
    if (d.greaterThanOrEqualTo(USDC_MAX_EXCLUSIVE)) {
        return {
            error: 'amount is larger than the wallet can represent.',
            code: 'USDC_AMOUNT_OUT_OF_RANGE',
        };
    }
    return { value: d };
}
const express                  = require('express');
const router                   = express.Router();
const walletController         = require('../controllers/walletController');
const { protect }              = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { require2FA } = require('../middleware/require2FA');
const { protectActive }        = require('../middleware/banGuardMiddleware');

// Route-specific FX gate (AZM-Planning #75 — PROPOSED, pending owner
// approval): the wallet withdrawal is FX-dependent exactly when the
// destination dispatches a GHS MoMo payout. Destination classification is
// the SINGLE shared contract (services/payoutDestinationClassification.js)
// used by both this gate and the payout dispatch in walletController — the
// gate decision and the provider dispatch classification are identical by
// construction (financial-core blocker A).
const { requireFreshFxRate } = require('../middleware/fxTransactionGateMiddleware');


// Withdrawals — r42 WAVE-2: the claim commits INSIDE the withdrawal
// reservation transaction (see walletController.requestWithdrawal) with the
// deterministic created-ticket response. There is NO provider I/O in the
// request path (payout workers own dispatch), so the response is honest
// post-commit; 4xx/5xx responses prove the reservation rolled back and
// release the claim for retry (same disposition contract as /api/withdraw/*).
// Route-specific FX gate (PROPOSED): MoMo/GHS payout destinations demand
// a FRESH canonical rate and are refused 503 BEFORE the idempotency claim;
// Binance Pay IDs, TRC20 and EVM wallet addresses are same-asset USDC
// dispatches and are NOT FX-gated. A saved/demo fallback rate never opens
// the gate. Classification is shared — see the module comment above.
router.post('/withdraw',
    protectActive, require2FA(),
    requireFreshFxRate({ when: 'MOMO_PAYOUT_DESTINATION' }),
    idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }),
    walletController.requestWithdrawal);

// Read-only history (banned users still need to see their own history)
router.get('/history',         protect,       walletController.getWithdrawalHistory);
router.get('/withdraw/status/:withdrawalId', protect, walletController.getWithdrawalStatusById);

// Saved wallets / payout whitelist
// r42 §9.5 (integration review): /saved is non-financial saved-address CRUD
// (audit doc §3 classifies it as such). Forcing the financial
// Idempotency-Key contract onto it would break the production client's
// wallet-address management for no financial-safety gain — the route is
// de-mounted from the shared authority. `required: false` was NOT used: a
// half-protected route is worse than an honestly unprotected one.
router.post('/saved',          protectActive, walletController.addSavedWallet);
router.get('/saved',           protect,       walletController.getSavedWallets);
router.delete('/saved/:id',    protectActive, walletController.deleteSavedWallet);

// Fiat deposit gateway (initialize)
router.post('/deposit/initialize', protectActive, idempotency(), walletController.initializeFiatDeposit);

// Polygon deposit address (Phase C: Tatum HD wallet derivation)
router.get('/deposit-address/polygon', protect, walletController.getPolygonDepositAddress);

// ─── VENDOR INTERNAL TRANSFER (Fund Trading Pool / Withdraw to Wallet) ───────
// GET /api/wallet/pool-withdrawal-preview?amount=X — preview which ads would be deactivated
router.get('/pool-withdrawal-preview', protect, async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        // §r42.3 — this preview decides WHICH ADS GET DEACTIVATED, so the
        // comparison is made in Decimal, never in binary floating point.
        let amountExact = new Prisma.Decimal(0);
        const rawAmount = req.query.amount;
        if (rawAmount !== undefined && rawAmount !== '') {
            const parsedPreview = toExactUsdcAmount(rawAmount);
            if (parsedPreview.error) {
                return res.status(400).json({
                    success: false,
                    code: parsedPreview.code,
                    message: parsedPreview.error,
                });
            }
            amountExact = parsedPreview.value;
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { vendorUnallocatedBalance: true }
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const poolExact = new Prisma.Decimal(user.vendorUnallocatedBalance);
        const newPoolBalance = poolExact.minus(amountExact);

        const activeAds = await prisma.ad.findMany({
            where: { vendorId: userId, status: 'ACTIVE' },
            select: { id: true, maxLimit: true, minLimit: true, paymentMethod: true, type: true, createdAt: true },
            orderBy: { createdAt: 'desc' }
        });

        const adsAtRisk = activeAds.filter(a => new Prisma.Decimal(a.maxLimit).greaterThan(newPoolBalance));
        const adsSafe = activeAds.filter(a => !new Prisma.Decimal(a.maxLimit).greaterThan(newPoolBalance));

        return res.status(200).json({
            success: true,
            data: {
                currentPoolBalance: Number(poolExact),
                withdrawAmount: Number(amountExact),
                amountExact: amountExact.toFixed(USDC_DP),
                newPoolBalance: (!newPoolBalance.isNegative() ? newPoolBalance : new Prisma.Decimal(0)).toNumber(),
                newPoolBalanceExact: (!newPoolBalance.isNegative() ? newPoolBalance : new Prisma.Decimal(0)).toFixed(USDC_DP),
                totalActiveAds: activeAds.length,
                adsAtRisk,
                adsSafe,
                willDeactivate: adsAtRisk.length,
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// POST /api/wallet/internal-transfer
// Body: { direction: 'TO_POOL' | 'FROM_POOL', amount: number }
router.post('/internal-transfer', protectActive, require2FA(),
    idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }), async (req, res) => {
    const prisma = req.app.get('prisma');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const userId = req.user.id;
        const { direction, amount } = req.body;

        if (!direction || !['TO_POOL', 'FROM_POOL'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'direction must be "TO_POOL" or "FROM_POOL".'
            });
        }
        const parsedAmount = toExactUsdcAmount(amount);
        if (parsedAmount.error) {
            return res.status(400).json({
                success: false,
                code: parsedAmount.code,
                message: parsedAmount.error,
            });
        }
        const amountExact = parsedAmount.value;

        // Verify user is a vendor
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { role: true, availableBalance: true, vendorUnallocatedBalance: true }
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        if (user.role !== 'VENDOR' && user.role !== 'ADMIN') {
            return res.status(403).json({ success: false, message: 'Only vendors can transfer to/from the trading pool.' });
        }

        // §R42.1 — the shared idempotency claim (Idempotency-Key header,
        // required by the mounted authority) commits WITH the economics and
        // the wire response body is built inside the money transaction, so
        // a same-key retry replays the byte-identical committed result and
        // a crash between commit and HTTP response can never leave
        // committed money under an IN_PROGRESS identity.
        const operation = res.locals?.financialOperation || null;

        if (direction === 'TO_POOL') {
            // Available → Vendor Unallocated (fund trading pool).
            // §P.4: the mutation is a guarded conditional decrement inside the
            // SAME transaction as the history row and the ledger posting —
            // a racing wallet spend loses the CAS cleanly instead of driving
            // the balance negative.
            const committedBody = await prisma.$transaction(async (tx) => {
                const claim = await tx.user.updateMany({
                    where: { id: userId, availableBalance: { gte: amountExact } },
                    data: {
                        availableBalance: { decrement: amountExact },
                        vendorUnallocatedBalance: { increment: amountExact },
                    },
                });
                if (claim.count !== 1) {
                    throw new Error(`Insufficient available balance. You have ${user.availableBalance} USDC.`);
                }
                const history = await tx.transactionHistory.create({
                    data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: amountExact.negated(), feeUsdc: 0, status: 'COMPLETED' }
                });
                //   D user:{vendor}:liability    — available liability down
                //   C user:{vendor}:unallocated  — restricted pool liability up
                await ledger.post(tx, {
                    idempotencyKey: `ledger:wallet:pool-topup:${history.id}`,
                    entryType: 'VENDOR_TOPUP',
                    description: 'Vendor trading-pool top-up from available wallet',
                    userId,
                    relatedEntity: 'transactionHistory',
                    relatedEntityId: history.id,
                    metadata: { direction, amount: _exact(amountExact) },
                    lines: [
                        { account: `user:${userId}:liability`, debit: _exact(amountExact) },
                        { account: `user:${userId}:unallocated`, credit: _exact(amountExact) },
                    ],
                });

                // The wire keeps a JSON number (the published contract) but it
                // is derived from the exact Decimal, never from float math.
                const amountWire = Number(amountExact.toFixed(USDC_DP));
                const body = {
                    success: true,
                    message: `${amountExact.toString()} USDC moved to Trading Pool.`,
                    data: { direction, amount: amountWire }
                };
                if (operation) {
                    const committed = await tx.financialOperation.updateMany({
                        where: { id: operation.id, status: 'IN_PROGRESS' },
                        data: {
                            status: 'COMMITTED',
                            statusCode: 200,
                            responseBody: JSON.stringify(body),
                        },
                    });
                    if (committed.count !== 1) {
                        const err = new Error('Idempotency operation state conflict.');
                        err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                        throw err;
                    }
                }
                return body;
            });

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);
            // The exact body committed with the economics.
            return res.status(200).json(committedBody);
        } else {
            // Vendor Unallocated → Available (withdraw from trading pool)
            if (new Prisma.Decimal(user.vendorUnallocatedBalance).lessThan(amountExact)) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient trading pool balance. You have ${user.vendorUnallocatedBalance} USDC.`
                });
            }

            // §R42.1: the ad deactivation and the response derivation now
            // live INSIDE the money transaction. The old code computed
            // the post-transfer pool balance from the stale pre-transaction
            // user read and deactivated the ads AFTER the transaction
            // committed — a concurrent pool transfer between the read and
            // the deactivation made the ad set stale. The fresh in-tx
            // read below is authoritative because the guarded claim holds
            // the user row lock.
            const committedBody = await prisma.$transaction(async (tx) => {
                const claim = await tx.user.updateMany({
                    where: { id: userId, vendorUnallocatedBalance: { gte: amountExact } },
                    data: {
                        vendorUnallocatedBalance: { decrement: amountExact },
                        availableBalance: { increment: amountExact },
                    },
                });
                if (claim.count !== 1) {
                    throw new Error(`Insufficient trading pool balance. You have ${user.vendorUnallocatedBalance} USDC.`);
                }
                const history = await tx.transactionHistory.create({
                    data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: amountExact, feeUsdc: 0, status: 'COMPLETED' }
                });
                //   D user:{vendor}:unallocated  — restricted pool liability down
                //   C user:{vendor}:liability    — available liability up
                await ledger.post(tx, {
                    idempotencyKey: `ledger:wallet:pool-withdraw:${history.id}`,
                    entryType: 'VENDOR_ALLOCATE',
                    description: 'Vendor trading-pool withdrawal to available wallet',
                    userId,
                    relatedEntity: 'transactionHistory',
                    relatedEntityId: history.id,
                    metadata: { direction, amount: _exact(amountExact) },
                    lines: [
                        { account: `user:${userId}:unallocated`, debit: _exact(amountExact) },
                        { account: `user:${userId}:liability`, credit: _exact(amountExact) },
                    ],
                });

                // Authoritative post-transfer pool balance — read inside
                // the transaction that holds the row lock, never derived
                // from the stale pre-transaction snapshot.
                const freshUser = await tx.user.findUnique({
                    where: { id: userId },
                    select: { vendorUnallocatedBalance: true },
                });
                // The post-transfer pool balance stays a Decimal for the ad
                // comparison: comparing NUMERIC(20,8) against a double could
                // deactivate an ad whose limit equals the balance exactly.
                const newPoolBalanceExact = new Prisma.Decimal(freshUser.vendorUnallocatedBalance);
                const newPoolBalance = Number(newPoolBalanceExact.toFixed(USDC_DP));

                // Auto-deactivate ads that exceed the new pool balance —
                // same transaction as the balance move it depends on.
                const overLimitAds = await tx.ad.findMany({
                    where: {
                        vendorId: userId,
                        status: 'ACTIVE',
                        maxLimit: { gt: newPoolBalanceExact }
                    },
                    select: { id: true, maxLimit: true, paymentMethod: true }
                });

                if (overLimitAds.length > 0) {
                    await tx.ad.updateMany({
                        where: { id: { in: overLimitAds.map(a => a.id) } },
                        data: { status: 'INACTIVE' }
                    });
                }

                const body = overLimitAds.length > 0
                    ? {
                        success: true,
                        message: `${amountExact.toString()} USDC moved to Available Wallet. ${overLimitAds.length} ad(s) were deactivated because they exceed your new pool balance.`,
                        data: {
                            direction,
                            amount: Number(amountExact.toFixed(USDC_DP)),
                            newPoolBalance,
                            deactivatedAds: overLimitAds,
                            deactivatedCount: overLimitAds.length,
                        }
                    }
                    : {
                        success: true,
                        message: `${amountExact.toString()} USDC moved to Available Wallet.`,
                        data: { direction, amount: Number(amountExact.toFixed(USDC_DP)) }
                    };
                if (operation) {
                    const committed = await tx.financialOperation.updateMany({
                        where: { id: operation.id, status: 'IN_PROGRESS' },
                        data: {
                            status: 'COMMITTED',
                            statusCode: 200,
                            responseBody: JSON.stringify(body),
                        },
                    });
                    if (committed.count !== 1) {
                        const err = new Error('Idempotency operation state conflict.');
                        err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                        throw err;
                    }
                }
                return body;
            });

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);
            // The exact body committed with the economics.
            return res.status(200).json(committedBody);
        }
    } catch (error) {
        if (String(error.message || '').startsWith('Insufficient')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        logger.error({ err: error }, '[wallet.internalTransfer] error');
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
