// services/p2p.service.js
// =============================================================================
// AZAMAN V2 — P2P MECHANICS SERVICE
// Phase 2.2: Ping System, Trade Adjustments, Strike Engine, Margin Split
// Phase 3.0: Vendor Gamification Integration (XP, Streaks, Achievements)
//
// All balance mutations happen inside a single prisma.$transaction block.
// No req/res here — pure business logic, consumed by p2p.controller.js.
//
// Exported functions:
//   pingVendor(prisma, { tradeId, buyerId })
//   acceptPing(prisma, { tradeId, vendorId, topUpAmount })
//   markUnderpaid(prisma, { tradeId, callerUserId, paidAmountFiat, intentional })
//   flagOverpayment(prisma, { tradeId, buyerId, overpaidAmountUsdc })
//   completeTrade(prisma, { tradeId, releasedByUserId })
// =============================================================================

const logger = require('../src/config/logger');
const journal = require('./journalIntegration');
const gamification = require('./vendorGamificationService');
const { calculateFeeSplit } = require('../utils/feeMath');

// ── Constants ────────────────────────────────────────────────────────────────
const STRIKE_BAN_THRESHOLD   = 3;          // strikes before auto-ban
const PING_TIMEOUT_MS        = 5 * 60_000; // 5 minutes

// Phase ADMIN-CONTROL: These are now FALLBACK values only. The live values
// are read from GlobalSettings on every trade completion. If the DB row is
// missing or the query fails, these kick in as safe defaults.
const FALLBACK_UNDER_1K_ADMIN_PCT = 0.60;
const FALLBACK_OVER_1K_ADMIN_PCT  = 0.50;
const FALLBACK_P2P_MARGIN_PCT     = 0.02;
const FALLBACK_TIER_THRESHOLD     = 1000;

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Lazy-upsert SystemProfitFees singleton so we never crash on empty DB. */
const _ensureProfitFees = async (tx) =>
    tx.systemProfitFees.upsert({
        where:  { id: 1 },
        update: {},
        create: { id: 1, balance: 0.0 }
    });


/**
 * _applyStrike
 * Increment buyer strikeCount inside a running $transaction.
 * If count reaches STRIKE_BAN_THRESHOLD, lock the account to BANNED_INDEF.
 * Returns { newCount, banned }.
 */
const _applyStrike = async (tx, buyerId) => {
    const updated = await tx.user.update({
        where: { id: buyerId },
        data:  { strikeCount: { increment: 1 } },
        select: { strikeCount: true }
    });

    const newCount = updated.strikeCount;
    let banned = false;

    if (newCount >= STRIKE_BAN_THRESHOLD) {
        await tx.user.update({
            where: { id: buyerId },
            data:  { banStatus: 'BANNED_INDEF' }
        });
        banned = true;
    }

    return { newCount, banned };
};

// =============================================================================
// 1. PING VENDOR
//    Buyer pings vendor when vendorUnallocatedBalance is insufficient.
//    Creates a 5-minute timeout notification; no balance moves at this stage.
// =============================================================================

/**
 * pingVendor
 *
 * Validates that:
 *   - Trade exists and is in PENDING_PAYMENT
 *   - Caller is the buyer on the trade
 *   - vendorUnallocatedBalance < trade.amountCrypto
 *
 * Writes a VENDOR_PRIORITY notification to the vendor with a 5-min expiry
 * timestamp embedded in actionPayload. No $transaction needed (read + notify).
 *
 * @param {object} prisma
 * @param {{ tradeId: number, buyerId: number }} params
 * @returns {Promise<{ pingExpiresAt: string }>}
 */
const pingVendor = async (prisma, { tradeId, buyerId }) => {
    const trade = await prisma.trade.findUnique({
        where: { id: tradeId },
        select: { id: true, status: true, userId: true, vendorId: true, amountCrypto: true }
    });

    if (!trade)                         throw new Error('Trade not found.');
    if (trade.userId !== buyerId)       throw new Error('Only the buyer can ping the vendor.');
    if (trade.status !== 'PENDING_PAYMENT')
        throw new Error(`Cannot ping: trade status is ${trade.status}.`);

    const vendor = await prisma.user.findUnique({
        where:  { id: trade.vendorId },
        select: { id: true, vendorUnallocatedBalance: true }
    });
    if (!vendor) throw new Error('Vendor not found.');

    if (vendor.vendorUnallocatedBalance >= trade.amountCrypto) {
        throw new Error(
            `Vendor already has sufficient unallocated balance ` +
            `(${vendor.vendorUnallocatedBalance} USDC >= ${trade.amountCrypto} USDC). No ping needed.`
        );
    }

    const pingExpiresAt = new Date(Date.now() + PING_TIMEOUT_MS).toISOString();

    // Phase N: notification data returned to controller for delivery via
    // notificationService (DB + socket + FCM in one pipeline).
    return {
        pingExpiresAt,
        _notifications: [{
            userId:        trade.vendorId,
            title:         '🔔 Buyer Ping — Action Required',
            body:          `Buyer is waiting for you to top up your unallocated balance for Trade #${tradeId}. You have 5 minutes.`,
            category:      'VENDOR_PRIORITY',
            actionPayload: {
                action:       'PING_TOPUP',
                tradeId:      String(tradeId),
                pingExpiresAt,
                requiredUsdc: trade.amountCrypto
            }
        }]
    };
};

// =============================================================================
// 2. ACCEPT PING — Vendor tops up vendorUnallocatedBalance
//    Atomically moves topUpAmount from availableBalance → vendorUnallocatedBalance
// =============================================================================

/**
 * acceptPing
 *
 * The vendor responds to a buyer ping by moving funds from their
 * availableBalance into vendorUnallocatedBalance so the escrow can proceed.
 *
 * ACID guarantee: both sides of the balance move happen in one $transaction.
 *
 * @param {object} prisma
 * @param {{ tradeId: number, vendorId: number, topUpAmount: number }} params
 * @returns {Promise<{ newAvailableBalance: number, newVendorUnallocatedBalance: number }>}
 */
const acceptPing = async (prisma, { tradeId, vendorId, topUpAmount }) => {
    if (!topUpAmount || topUpAmount <= 0) throw new Error('topUpAmount must be positive.');

    const trade = await prisma.trade.findUnique({
        where:  { id: tradeId },
        select: { id: true, status: true, vendorId: true, userId: true, amountCrypto: true }
    });

    if (!trade)                           throw new Error('Trade not found.');
    if (trade.vendorId !== vendorId)      throw new Error('Only the vendor on this trade can accept a ping.');
    if (trade.status !== 'PENDING_PAYMENT')
        throw new Error(`Cannot accept ping: trade status is ${trade.status}.`);

    const result = await prisma.$transaction(async (tx) => {
        const vendor = await tx.user.findUnique({ where: { id: vendorId } });
        if (!vendor) throw new Error('Vendor not found.');

        if (vendor.availableBalance < topUpAmount) {
            throw new Error(
                `Insufficient available balance. ` +
                `Required: ${topUpAmount} USDC, available: ${vendor.availableBalance.toFixed(6)} USDC.`
            );
        }

        const updated = await tx.user.update({
            where: { id: vendorId },
            data: {
                availableBalance:         { decrement: topUpAmount },
                vendorUnallocatedBalance: { increment: topUpAmount }
            },
            select: { availableBalance: true, vendorUnallocatedBalance: true }
        });

        // Notify the buyer that the vendor has topped up
        // Phase N: removed from transaction — delivered post-commit via controller.

        return updated;
    });

    return {
        newAvailableBalance:         result.availableBalance,
        newVendorUnallocatedBalance: result.vendorUnallocatedBalance,
        _notifications: [{
            userId:        trade.userId,
            title:         '✅ Vendor Responded to Ping',
            body:          `Vendor topped up ${topUpAmount} USDC for Trade #${tradeId}. You can proceed.`,
            category:      'GENERAL',
            actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
        }]
    };
};


// =============================================================================
// 3. MARK UNDERPAID
//    Admin or vendor marks a trade as underpaid.
//    - Release the paid USDC portion to the buyer's availableBalance (via rate)
//    - Refund the unpaid locked USDC back to vendor's availableBalance
//    - If intentional=true, apply a strike to the buyer
//    - Strike threshold → BANNED_INDEF
// =============================================================================

/**
 * markUnderpaid
 *
 * @param {object} prisma
 * @param {{
 *   tradeId:         number,
 *   callerUserId:    number,   // must be vendorId or ADMIN
 *   paidAmountFiat:  number,   // the fiat amount the buyer actually paid
 *   intentional:     boolean   // true → apply strike
 * }} params
 */
const markUnderpaid = async (prisma, { tradeId, callerUserId, paidAmountFiat, intentional }) => {
    if (paidAmountFiat < 0) throw new Error('paidAmountFiat cannot be negative.');

    // Pre-fetch trade + caller outside the transaction (read-only)
    const trade = await prisma.trade.findUnique({
        where:  { id: tradeId },
        select: {
            id: true, status: true, vendorId: true, userId: true,
            amountCrypto: true, amountFiat: true, type: true, rate: true
        }
    });

    if (!trade) throw new Error('Trade not found.');

    if (!['PAID', 'PENDING_PAYMENT', 'DISPUTED'].includes(trade.status)) {
        throw new Error(`Cannot mark underpaid: trade status is ${trade.status}.`);
    }

    const caller = await prisma.user.findUnique({
        where:  { id: callerUserId },
        select: { id: true, role: true }
    });
    if (!caller) throw new Error('Caller not found.');

    const isVendor = trade.vendorId === callerUserId;
    const isAdmin  = caller.role === 'ADMIN';
    if (!isVendor && !isAdmin) {
        throw new Error('Only the vendor or an admin can mark a trade as underpaid.');
    }

    // ── Arithmetic ─────────────────────────────────────────────────────────
    // rate = GHS per 1 USDC (stored on trade, fallback to amountCrypto/amountFiat)
    const storedRate = trade.rate > 0
        ? trade.rate
        : (trade.amountFiat / trade.amountCrypto);

    const totalLockedUsdc   = trade.amountCrypto;
    const paidFractionUsdc  = parseFloat((paidAmountFiat  / storedRate).toFixed(6));
    const unpaidFractionUsdc = parseFloat((totalLockedUsdc - paidFractionUsdc).toFixed(6));

    if (paidFractionUsdc < 0 || unpaidFractionUsdc < 0) {
        throw new Error('paidAmountFiat exceeds the original trade amount. Use flagOverpayment instead.');
    }

    const result = await prisma.$transaction(async (tx) => {
        // Phase H8 BUGFIX (2026-05-27): atomic conditional status flip.
        // Done FIRST inside the transaction so two concurrent
        // markUnderpaid calls can't both pass the status check (which
        // happens outside the transaction at the top of this function)
        // and both move escrow money. The conditional updateMany flips
        // PAID → CANCELLED if and only if the row is still PAID; if not,
        // the second caller gets count=0 and aborts before any balance
        // mutation runs.
        const claimed = await tx.trade.updateMany({
            where: { id: tradeId, status: 'PAID' },
            data:  { status: 'CANCELLED', completedAt: new Date() }
        });
        if (claimed.count === 0) {
            throw new Error('TRADE_ALREADY_FINALIZED');
        }

        const isSellAd = trade.type === 'SELL';

        if (isSellAd) {
            // SELL ad: vendor escrowed USDC. Release paid portion to buyer,
            // refund unpaid portion back to vendor.
            await tx.user.update({
                where: { id: trade.userId },
                data:  { availableBalance: { increment: paidFractionUsdc } }
            });

            if (unpaidFractionUsdc > 0) {
                await tx.user.update({
                    where: { id: trade.vendorId },
                    data: {
                        escrowLockedBalance: { decrement: unpaidFractionUsdc },
                        availableBalance:    { increment: unpaidFractionUsdc }
                    }
                });
            }
        } else {
            // BUY ad: user escrowed USDC (they're selling crypto to vendor).
            // Vendor underpaid fiat — release paid USDC portion to vendor,
            // refund unpaid portion back to user.
            await tx.user.update({
                where: { id: trade.vendorId },
                data:  { availableBalance: { increment: paidFractionUsdc } }
            });

            if (unpaidFractionUsdc > 0) {
                await tx.user.update({
                    where: { id: trade.userId },
                    data: {
                        escrowLockedBalance: { decrement: unpaidFractionUsdc },
                        availableBalance:    { increment: unpaidFractionUsdc }
                    }
                });
            }
        }

        // 3. Trade was already stamped CANCELLED at the top of this
        //    transaction (Phase H8 atomic conditional flip).

        // 4. Strike engine (only if intentional)
        let strikeResult = null;
        if (intentional) {
            strikeResult = await _applyStrike(tx, trade.userId);

            // Phase N: strike notification delivered post-commit via controller.
        }

        // 5. Phase N: both-parties notifications delivered post-commit via controller.

        return { strikeResult, paidFractionUsdc, unpaidFractionUsdc };
    });

    // Phase N: build notification list for post-commit delivery by controller
    const _notifications = [
        {
            userId:        trade.userId,
            title:         'Trade Adjusted — Underpayment',
            body:          `Trade #${tradeId} was adjusted. Paid portion (${paidAmountFiat} GHS) credited. Remaining escrow refunded to vendor.`,
            category:      'GENERAL',
            actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
        },
        {
            userId:        trade.vendorId,
            title:         'Trade Adjusted — Underpayment',
            body:          `Underpayment confirmed for Trade #${tradeId}. ${result.unpaidFractionUsdc.toFixed(4)} USDC refunded to your available balance.`,
            category:      'VENDOR_PRIORITY',
            actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
        }
    ];

    if (intentional && result.strikeResult) {
        _notifications.push({
            userId:        trade.userId,
            title:         '⚠️ Strike Issued',
            body:          result.strikeResult.banned
                ? `You have received ${result.strikeResult.newCount} strikes and your account has been restricted.`
                : `You have received strike ${result.strikeResult.newCount}/${STRIKE_BAN_THRESHOLD} for intentional underpayment.`,
            category:      'SECURITY_ACCOUNT',
            actionPayload: {
                action:     'VIEW_ACCOUNT',
                strikeCount: result.strikeResult.newCount,
                banned:      result.strikeResult.banned
            }
        });
    }

    return {
        tradeId,
        paidAmountFiat,
        paidFractionUsdc:    result.paidFractionUsdc,
        unpaidFractionUsdc:  result.unpaidFractionUsdc,
        strikeApplied:       intentional,
        strikeResult:        result.strikeResult,
        _notifications
    };
};


// =============================================================================
// 4. FLAG OVERPAYMENT
//    Buyer flags they paid more than the trade amount.
//    The disputed difference is moved from vendorUnallocatedBalance (or
//    availableBalance as fallback) into the vendor's disputeEscrowBalance.
// =============================================================================

/**
 * flagOverpayment
 *
 * @param {object} prisma
 * @param {{
 *   tradeId:           number,
 *   buyerId:           number,
 *   overpaidAmountUsdc: number   // the disputed excess in USDC
 * }} params
 */
const flagOverpayment = async (prisma, { tradeId, buyerId, overpaidAmountUsdc }) => {
    if (!overpaidAmountUsdc || overpaidAmountUsdc <= 0)
        throw new Error('overpaidAmountUsdc must be positive.');

    const trade = await prisma.trade.findUnique({
        where:  { id: tradeId },
        select: { id: true, status: true, userId: true, vendorId: true, amountCrypto: true }
    });

    if (!trade)                       throw new Error('Trade not found.');
    if (trade.userId !== buyerId)     throw new Error('Only the buyer can flag an overpayment.');
    if (!['PAID', 'PENDING_PAYMENT', 'DISPUTED', 'COMPLETED'].includes(trade.status)) {
        throw new Error(`Cannot flag overpayment: trade status is ${trade.status}.`);
    }

    const result = await prisma.$transaction(async (tx) => {
        // Phase H11 BUGFIX (2026-05-27): idempotency via TransactionHistory.
        // The previous version of flagOverpayment had no protection
        // against duplicate flags — two concurrent calls (or a buyer
        // double-tap on bad latency) could both see status=PAID, both
        // freeze fromUnallocated/fromAvailable, and the vendor's
        // disputeEscrowBalance would jump by 2 × overpaidAmountUsdc.
        //
        // Unlike the trade-status flips fixed in H8, flagOverpayment
        // accepts calls from MULTIPLE statuses (PAID, PENDING_PAYMENT,
        // DISPUTED, COMPLETED) by design — admins may need to flag a
        // post-hoc overpayment on a trade that's already DISPUTED or
        // COMPLETED. So a "flip status if PENDING" precondition doesn't
        // fit. The canonical alternative is the TransactionHistory
        // @unique txHash constraint that the peer-fulfill flow already
        // uses: write a row keyed `OVERPAYMENT_FREEZE_<tradeId>` and
        // the second flag's create() hits P2002, rolling back the whole
        // transaction (including the balance moves) cleanly.
        const freezeTxHash = `OVERPAYMENT_FREEZE_${tradeId}`;

        const vendor = await tx.user.findUnique({
            where:  { id: trade.vendorId },
            select: { vendorUnallocatedBalance: true, availableBalance: true }
        });
        if (!vendor) throw new Error('Vendor not found.');

        let remainingToLock = overpaidAmountUsdc;
        let fromUnallocated = 0;
        let fromAvailable   = 0;

        // Drain from vendorUnallocatedBalance first
        if (vendor.vendorUnallocatedBalance >= remainingToLock) {
            fromUnallocated = remainingToLock;
            remainingToLock = 0;
        } else {
            fromUnallocated = vendor.vendorUnallocatedBalance;
            remainingToLock -= fromUnallocated;
        }

        // Drain remainder from availableBalance
        if (remainingToLock > 0) {
            if (vendor.availableBalance < remainingToLock) {
                throw new Error(
                    `Vendor has insufficient combined balance to cover the disputed amount. ` +
                    `Unallocated: ${vendor.vendorUnallocatedBalance}, Available: ${vendor.availableBalance}, ` +
                    `Disputed: ${overpaidAmountUsdc}.`
                );
            }
            fromAvailable = remainingToLock;
        }

        // Atomically move to disputeEscrowBalance
        await tx.user.update({
            where: { id: trade.vendorId },
            data: {
                vendorUnallocatedBalance: { decrement: fromUnallocated },
                availableBalance:         { decrement: fromAvailable },
                disputeEscrowBalance:     { increment: overpaidAmountUsdc }
            }
        });

        // Escalate trade to DISPUTED (idempotent — already-disputed trades
        // stay DISPUTED, so this is safe to run inside the transaction
        // even when the trade was already in DISPUTED state).
        await tx.trade.update({
            where: { id: tradeId },
            data:  { status: 'DISPUTED' }
        });

        // Phase H11: idempotency lock. This is the LAST write inside the
        // transaction so any earlier balance mutation is fully rolled
        // back if the unique constraint trips. The audit log row also
        // serves as a permanent record that this flag was applied —
        // useful for admins reviewing the dispute resolution.
        await tx.transactionHistory.create({
            data: {
                userId:     buyerId,
                type:       'OVERPAYMENT_FREEZE',
                amountUsdc: overpaidAmountUsdc,
                feeUsdc:    0,
                txHash:     freezeTxHash,
                status:     'COMPLETED'
            }
        });

        // Notify both parties + admin
        // Phase N: removed from transaction — delivered post-commit via controller.

        return { fromUnallocated, fromAvailable };
    });

    return {
        tradeId,
        overpaidAmountUsdc,
        frozenBreakdown: {
            fromUnallocated: result.fromUnallocated,
            fromAvailable:   result.fromAvailable
        },
        tradeStatus: 'DISPUTED',
        _notifications: [
            {
                userId:        trade.userId,
                title:         '🔒 Overpayment Dispute Opened',
                body:          `Your overpayment dispute for Trade #${tradeId} has been filed. ${overpaidAmountUsdc} USDC is frozen pending review.`,
                category:      'SECURITY_ACCOUNT',
                actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
            },
            {
                userId:        trade.vendorId,
                title:         '⚠️ Overpayment Dispute — Funds Frozen',
                body:          `Buyer reported an overpayment on Trade #${tradeId}. ${overpaidAmountUsdc} USDC has been moved to dispute escrow.`,
                category:      'VENDOR_PRIORITY',
                actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
            }
        ]
    };
};


// =============================================================================
// 5. COMPLETE TRADE — Margin Split Engine
//    Called when a vendor (or buyer on a BUY ad) releases assets.
//    Calculates platform margin profit and splits it:
//      Trades < $1 000 USDC  →  60 % Admin / 40 % Vendor
//      Trades >= $1 000 USDC →  50 % Admin / 50 % Vendor
//    Admin cut  → SystemProfitFees (upserted singleton)
//    Vendor cut → vendor's availableBalance (increment)
// =============================================================================

/**
 * completeTrade
 *
 * @param {object} prisma
 * @param {{
 *   tradeId:         number,
 *   releasedByUserId: number   // must be vendorId for SELL ad, userId for BUY ad
 * }} params
 */
const completeTrade = async (prisma, { tradeId, releasedByUserId, adminOverride = false }) => {
    // Pre-fetch outside the transaction (read-only checks)
    const trade = await prisma.trade.findUnique({
        where:  { id: tradeId },
        select: {
            id: true, status: true, type: true,
            vendorId: true, userId: true,
            amountCrypto: true, amountFiat: true, rate: true,
            paymentMethod: true
        }
    });

    if (!trade) throw new Error('Trade not found.');
    if (trade.status === 'COMPLETED') throw new Error('Trade is already completed.');
    // HIGH-11: Only allow completion from PAID status (buyer must have submitted proof).
    // Admin override (issue #48) allows DISPUTED → COMPLETED in one atomic transaction.
    const allowedStatus = adminOverride ? 'DISPUTED' : 'PAID';
    if (trade.status !== allowedStatus) {
        throw new Error(`Cannot complete trade: status must be ${allowedStatus} (current: ${trade.status}).${adminOverride ? ' Admin override path.' : ' Buyer must submit payment proof first.'}`);
    }

    const isSellAd = trade.type === 'SELL';

    // Authorization: only the party receiving fiat can release crypto.
    // Admin override bypasses counterparty authorization — the admin route
    // (adminOnly middleware) is the authorization gate for that path.
    if (!adminOverride) {
        if (isSellAd  && trade.vendorId !== releasedByUserId)
            throw new Error('Only the vendor can release assets on a SELL ad.');
        if (!isSellAd && trade.userId  !== releasedByUserId)
            throw new Error('Only the buyer can release assets on a BUY ad.');
    }

    // ── Fetch settings for fee percentage ─────────────────────────────────
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

    // ── Phase Q1: Resolve active fee profile for this trade context ───────
    const { resolveFeeProfile } = require('./feeProfileService');
    const feeProfile = await resolveFeeProfile(prisma, {
        vendorId: trade.vendorId,
        buyerId: trade.userId,
        amountCrypto: Number(trade.amountCrypto)
    });

    // Use profile values; fall back to GlobalSettings → hardcoded defaults
    const p2pFeePct = feeProfile.platformFeePct || (settings?.p2pFeePct ?? FALLBACK_P2P_MARGIN_PCT);

    // ── Per-payment-method fee override ───────────────────────────────────
    // If the trade's payment method has a specific fee rate configured,
    // use that instead of the global p2pFeePct.
    let effectiveFeePct = Number(p2pFeePct);
    if (settings?.feeByPaymentMethod && trade.paymentMethod) {
        const methodMap = typeof settings.feeByPaymentMethod === 'string'
            ? JSON.parse(settings.feeByPaymentMethod)
            : settings.feeByPaymentMethod;
        const methodKey = trade.paymentMethod.toUpperCase().replace(/[\s-]/g, '_');
        if (methodMap[methodKey] !== undefined) {
            effectiveFeePct = Number(methodMap[methodKey]);
        }
    }

    // ── Phase F2: Flat USDC fee arithmetic (no GHS oracle math) ───────────
    // P2P trades are USDC↔USD (1:1 parity). Fee is a flat % of amountCrypto.

    // Phase ADMIN-CONTROL: Read tier threshold and splits from GlobalSettings
    const tierThreshold = Number(settings?.tierThreshold ?? FALLBACK_TIER_THRESHOLD);

    // Phase Q1: Admin/vendor split from fee profile (replaces hardcoded tiers)
    const adminPct  = feeProfile.adminSplitPct || (Number(trade.amountCrypto) >= tierThreshold
        ? (1 - Number(settings?.vendorShareOver1k ?? (1 - FALLBACK_OVER_1K_ADMIN_PCT)))
        : (1 - Number(settings?.vendorShareUnder1k ?? (1 - FALLBACK_UNDER_1K_ADMIN_PCT))));
    const vendorPct = feeProfile.vendorSplitPct || (1 - adminPct);

    // Fee split via the shared util (utils/feeMath) — the single source of truth
    // also used by __tests__/math.test.js. vendorPct is passed explicitly so a
    // fee profile's vendorSplitPct is honoured exactly as the inline math did.
    const { totalFeeUsdc, adminCutUsdc, vendorCutUsdc, netUsdc } =
        calculateFeeSplit(trade.amountCrypto, effectiveFeePct, adminPct, vendorPct);

    const result = await prisma.$transaction(async (tx) => {
        // Phase H8 BUGFIX (2026-05-27): atomic conditional status flip.
        // The status check was happening OUTSIDE the transaction
        // (`findUnique` at the top of the function), so two concurrent
        // `completeTrade` calls (vendor double-tapping the release
        // button under bad latency) both saw status=PAID, both passed
        // auth, and both entered this transaction. Without a unique
        // constraint to catch the duplicate (unlike peer transfer
        // fulfill), the result was DOUBLE-PAYOUT: escrow drained
        // twice, counterparty credited twice, admin fees doubled. This
        // is real money loss.
        //
        // Fix: claim the row BEFORE moving any money. `updateMany` with
        // a `status: 'PAID'` precondition flips the row to COMPLETED if
        // and only if it's still PAID. The second concurrent caller
        // gets count=0 and aborts the transaction before any balance
        // mutation runs.
        const claimStatus = adminOverride ? 'DISPUTED' : 'PAID';
        const claimed = await tx.trade.updateMany({
            where: { id: tradeId, status: claimStatus },
            data: {
                status:          'COMPLETED',
                completedAt:     new Date(),
                vendorProfitCut: vendorCutUsdc
            }
        });
        if (claimed.count === 0) {
            throw new Error('TRADE_ALREADY_FINALIZED');
        }

        // 1. BUY/SELL diverge on who receives USDC from escrow.
        if (isSellAd) {
            // SELL ad: user escrowed USDC. Vendor sent fiat.
            // User releases → vendor gets net USDC, user's escrow cleared.
            await tx.user.update({
                where: { id: trade.userId },
                data: {
                    escrowLockedBalance: { decrement: trade.amountCrypto }
                }
            });

            // Vendor receives net USDC (amountCrypto minus admin fee)
            const vendorNetUsdc = trade.amountCrypto - adminCutUsdc;
            await tx.user.update({
                where: { id: trade.vendorId },
                data: {
                    availableBalance: { increment: vendorNetUsdc },
                    tradesCompleted:  { increment: 1 }
                }
            });
        } else {
            // BUY ad: vendor escrowed USDC. User sent fiat.
            // Vendor releases → user gets net USDC, vendor's escrow cleared.
            await tx.user.update({
                where: { id: trade.vendorId },
                data: {
                    escrowLockedBalance: { decrement: trade.amountCrypto },
                    tradesCompleted:     { increment: 1 }
                }
            });

            // User receives net USDC (amountCrypto minus admin fee)
            await tx.user.update({
                where: { id: trade.userId },
                data: {
                    availableBalance: { increment: netUsdc }
                }
            });
        }

        // 3. Route admin cut to SystemProfitFees
        await _ensureProfitFees(tx);
        await tx.systemProfitFees.update({
            where: { id: 1 },
            data:  { balance: { increment: adminCutUsdc } }
        });

        // 4. AdminProfitLog
        const profitLog = await tx.adminProfitLog.create({
            data: {
                amountUsdc:  adminCutUsdc,
                source:      'P2P_MARGIN',
                relatedTxId: `trade_complete_${tradeId}_${Date.now()}`
            }
        });

        // 5. TransactionHistory for buyer
        await tx.transactionHistory.create({
            data: {
                userId:     trade.userId,
                type:       'P2P_TRADE',
                amountUsdc: trade.amountCrypto,
                feeUsdc:    adminCutUsdc,
                status:     'COMPLETED'
            }
        });

        // 6. Trade was already stamped as COMPLETED at the top of this
        //    transaction (Phase H8 atomic conditional flip). The previous
        //    placement here meant the row was claimed AFTER all balance
        //    mutations had run, leaving a window where two concurrent
        //    callers both saw PAID, both moved money, and only the
        //    second `update` won. The conditional `updateMany` at the
        //    top of the transaction is the canonical Prisma pattern for
        //    "do this if and only if no one else has".

        // 7. Phase N: notifications moved post-commit — delivered by controller
        //    via notificationService (DB + socket + FCM pipeline).

        // 8. VENDOR GAMIFICATION — Phase I3: deferred, NOT inside this transaction.
        //    Previously the gamification engine ran here inside the $transaction
        //    so XP / streak / level / achievement writes settled atomically with
        //    the trade. That added 100-200ms (vendorGamificationService runs ~6
        //    sequential Prisma writes plus an achievement scan) to every trade
        //    complete request — a perf cost the audit flagged as a P2 in §15.
        //
        //    Phase I3 moves the gamification call out of the request path
        //    entirely. The controller (p2p.controller.completeTrade) schedules
        //    `processPostCompletionGamification` via setImmediate AFTER the
        //    HTTP response goes out. Trade settlement remains atomic; XP /
        //    streak / level / achievement updates run in their own transaction
        //    a few ms later and reach the FE via the existing
        //    `gamification_update` socket event.
        //
        //    Trade-off: a server crash between response and the setImmediate
        //    firing leaves XP/streak un-applied for one trade. Acceptable —
        //    vendor stats are recomputed from completed trades on next stats
        //    fetch, and the gamification engine is idempotent on repeated
        //    calls for the same trade (volume/profit increments would
        //    double-count if reprocessed, so we don't auto-retry; the engine
        //    moves forward from current state rather than replaying history).

        return { profitLog };
    });

    // ── Double-entry journal (non-blocking, fail-safe) ──────────────────────
    const escrowUserId = isSellAd ? trade.userId : trade.vendorId;
    const receiverUserId = isSellAd ? trade.vendorId : trade.userId;
    const tradeAmount = parseFloat(trade.amountCrypto);

    journal.recordEscrowRelease(escrowUserId, receiverUserId, tradeAmount, String(tradeId), {
        isSellAd, adminCutUsdc, vendorCutUsdc
    }).catch(e => logger.warn({ err: e.message, tradeId }, '[p2p.service] Journal escrow release failed'));

    if (parseFloat(adminCutUsdc) > 0) {
        journal.recordFee(receiverUserId, adminCutUsdc, String(tradeId), { adminPct }).catch(e =>
            logger.warn({ err: e.message, tradeId }, '[p2p.service] Journal fee failed')
        );
    }

    return {
        tradeId,
        netUsdc,
        adminCutUsdc,
        vendorCutUsdc,
        adminPct,
        vendorPct,
        totalFeeUsdc,
        profitLog: result.profitLog,
        // Phase I3: gamification field intentionally absent from immediate
        // response. Controllers that previously read it will see undefined;
        // FE consumers (none today, but kept for forward-compat) read the
        // `gamification_update` socket event instead.
        gamification: null,
        // Phase I3: gamification inputs surfaced for the controller's
        // setImmediate-deferred call to processPostCompletionGamification.
        // Hoisted out of the trade row to avoid an extra Prisma read in
        // the controller.
        _gamificationInputs: {
            vendorId:        trade.vendorId,
            tradeVolumeUsdc: trade.amountCrypto,
            vendorProfitUsdc: vendorCutUsdc
        },
        // Phase N: notification data for post-commit delivery by controller
        _notifications: isSellAd
            ? [
                {
                    userId:        trade.userId,
                    title:         '✅ USDC Released',
                    body:          `Trade #${tradeId} completed. Your escrowed USDC has been released to the vendor.`,
                    category:      'GENERAL',
                    actionPayload: { action: 'OPEN_WALLET', tradeId: String(tradeId) }
                },
                {
                    userId:        trade.vendorId,
                    title:         '🎉 USDC Received!',
                    body:          `Trade #${tradeId} settled. ${(trade.amountCrypto - adminCutUsdc).toFixed(4)} USDC credited to your wallet.`,
                    category:      'VENDOR_PRIORITY',
                    actionPayload: { action: 'OPEN_WALLET', tradeId: String(tradeId) }
                }
            ]
            : [
                {
                    userId:        trade.userId,
                    title:         '🎉 USDC Received!',
                    body:          `Trade #${tradeId} completed. ${netUsdc.toFixed(4)} USDC credited to your wallet.`,
                    category:      'GENERAL',
                    actionPayload: { action: 'OPEN_WALLET', tradeId: String(tradeId) }
                },
                {
                    userId:        trade.vendorId,
                    title:         '✅ Trade Settled',
                    body:          `Trade #${tradeId} settled. Escrow released.`,
                    category:      'VENDOR_PRIORITY',
                    actionPayload: { action: 'OPEN_WALLET', tradeId: String(tradeId) }
                }
            ]
    };
};

// =============================================================================
// 5b. POST-COMPLETION GAMIFICATION (Phase I3)
//     Runs the vendor gamification engine OUTSIDE the trade-complete
//     transaction, scheduled via setImmediate from the controller after the
//     HTTP response has been sent. Uses the regular `prisma` client (not a
//     transaction) so each gamification write commits independently. Errors
//     are caught and logged — they cannot fail the already-settled trade.
//
//     Returns the gamification engine's result (or null on failure) so the
//     caller can emit the `gamification_update` socket event with the same
//     shape the FE used to expect from the response body.
//
//     Phase N2: notifications moved post-commit via notificationService.
// =============================================================================
const NotificationService = require('./notificationService');

const processPostCompletionGamification = async (prisma, {
    tradeId,
    vendorId,
    tradeVolumeUsdc,
    vendorProfitUsdc
}) => {
    try {
        // Run the gamification engine in its own transaction so the XP +
        // streak + level + achievement writes are atomic with each other
        // (the engine reads-modifies-writes on the User row).
        const gamificationResult = await prisma.$transaction(async (tx) => {
            const result = await gamification.processTradeCompletion(
                tx,
                vendorId,
                tradeVolumeUsdc,
                vendorProfitUsdc
            );

            return result;
        });

        // Phase N2: fire level-up and achievement notifications post-commit
        // via notificationService for full DB + socket + FCM delivery
        if (gamificationResult) {
            const io = global.socketIoInstance;
            const notifSvc = new NotificationService(prisma, io);

            const notifications = [];

            if (gamificationResult.leveledUp) {
                notifications.push({
                    userId: vendorId,
                    title: '🏆 Level Up!',
                    body: `Congratulations! You've reached ${gamificationResult.level} level! (${gamificationResult.newXpTotal} XP)`,
                    category: 'VENDOR_PRIORITY',
                    actionPayload: {
                        action: 'VIEW_VENDOR_STATS',
                        newLevel: gamificationResult.level,
                        previousLevel: gamificationResult.previousLevel
                    }
                });
            }

            if (gamificationResult.newAchievements && gamificationResult.newAchievements.length > 0) {
                for (const a of gamificationResult.newAchievements) {
                    notifications.push({
                        userId: vendorId,
                        title: `🎖️ Achievement Unlocked: ${a.name}`,
                        body: `${a.description} (+${a.xpReward} XP)`,
                        category: 'VENDOR_PRIORITY',
                        actionPayload: {
                            action: 'VIEW_ACHIEVEMENT',
                            achievementId: a.achievementId,
                            tier: a.tier
                        }
                    });
                }
            }

            if (notifications.length > 0) {
                setImmediate(() => {
                    Promise.all(notifications.map(n => notifSvc.sendNotification(n)))
                        .catch(err => logger.error({ err: err }, '[p2p.gamification] post-commit notif error'));
                });
            }

            // Phase E1: Award AZM for achievements unlocked during trade completion
            if (gamificationResult.newAchievements && gamificationResult.newAchievements.length > 0) {
                const { AzmRewardService } = require('./azmRewardService');
                const azmSvc = new AzmRewardService(prisma, io);
                setImmediate(() => {
                    Promise.all(
                        gamificationResult.newAchievements.map(a =>
                            azmSvc.rewardAchievementUnlock(vendorId, a.achievementId, a.name, a.tier)
                        )
                    ).catch(err => logger.error({ err: err }, '[p2p.gamification] AZM achievement reward error'));
                });
            }
        }

        return gamificationResult;
    } catch (gamErr) {
        logger.error(
            `[p2p.processPostCompletionGamification] tradeId=${tradeId} vendorId=${vendorId} ` +
            `non-fatal error: ${gamErr.message}`
        );
        return null;
    }
};

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
    pingVendor,
    acceptPing,
    markUnderpaid,
    flagOverpayment,
    completeTrade,
    processPostCompletionGamification,
    // expose constants for tests / controller
    STRIKE_BAN_THRESHOLD,
    FALLBACK_UNDER_1K_ADMIN_PCT,
    FALLBACK_OVER_1K_ADMIN_PCT,
    FALLBACK_TIER_THRESHOLD,
};
