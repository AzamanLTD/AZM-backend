// controllers/orderBookController.js
// =============================================================================
// AZAMAN V3 — Order Book Trading (Phase 5)
//
// A limit-order book for USDC/AZM trading. Users place buy/sell limit orders
// that are matched against each other. This is a platform-internal CEX-style
// order book — no on-chain settlement, balances are ledger entries.
//
// Order matching:
//   - Price-time priority (FIFO)
//   - Market orders execute against best available prices
//   - Limit orders rest on the book until filled or cancelled
//   - Partial fills supported (remaining qty stays on book)
//
// Fee model:
//   - 0.5% taker fee (market orders)
//   - 0.2% maker fee (limit orders that rest on the book)
//   - Fees paid in USDC, credited to SystemProfitFees
//
// r16 P0-F hardening (audit P0, 2026-09-20):
//   1. BUY placement no longer references the order id before the order row
//      exists (the old code posted `ledger:orderbook:reserve:${order.id}`
//      BEFORE `tx.orderBookOrder.create(...)` — a temporal-dead-zone crash on
//      every BUY placement).
//   2. Matching is guarded by a DB-authoritative candidate claim: a
//      conditional decrement (status still resting AND remainingQuantity >=
//      matchQty) must win before any balance moves. Two concurrent takers can
//      no longer settle against the same stale remainingQuantity, and
//      cancellation vs matching converges through the same row claim.
//   3. Partially-filled resting orders stay matchable (the old candidate
//      filter only matched status OPEN, stranding every partially-filled
//      resting order's remaining quantity).
//   4. Fee funding: every ledger charge to clearing:orderbook:usdc is now
//      exactly funded by a reserve. The old settlement charged the maker fee
//      and taker fee to the clearing pool even though no reserve ever
//      included them — every match overdrawed the clearing account by the fee
//      amount (unfunded value minted into equity:treasury). Both fees are now
//      deducted from the USDC recipient's credit, so each match charges the
//      clearing pool exactly matchQty * matchPrice.
//   5. Trades execute at the RESTING order's price (standard price-time
//      priority). BUY takers filling below their limit get an immediate
//      price-improvement refund of (limit - matchPrice) * matchQty, so no
//      reserve dust strands in the clearing pool; the matching condition for
//      MARKET BUY is bounded by the reservation price, so a concurrent book
//      move upward can never make charges exceed the reserve.
//
// Pair: AZM/USDC (price in USDC, quantity in AZM)
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');
const ledger = require('../services/ledgerService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

const PAIR = 'AZM/USDC';
const MAKER_FEE = 0.002; // 0.2%
const TAKER_FEE = 0.005; // 0.5%
const MIN_ORDER_SIZE = 1;   // min 1 AZM

const RESTING_STATUSES = ['OPEN', 'PARTIALLY_FILLED'];

// ── POST /api/order-book/orders ──────────────────────────────────────────────
async function placeOrder(req, res) {
  try {
    const userId = req.user.id;
    const { side, type, price, quantity } = req.body;

    // Validation
    if (!side || !['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ success: false, message: 'Side must be BUY or SELL.' });
    }
    if (!type || !['LIMIT', 'MARKET'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type must be LIMIT or MARKET.' });
    }
    if (!quantity || parseFloat(quantity) < MIN_ORDER_SIZE) {
      return res.status(400).json({ success: false, message: `Minimum order size is ${MIN_ORDER_SIZE} AZM.` });
    }

    const qty = parseFloat(quantity);
    const orderPrice = type === 'LIMIT' ? parseFloat(price) : null;

    if (type === 'LIMIT' && (!orderPrice || orderPrice <= 0)) {
      return res.status(400).json({ success: false, message: 'Limit orders require a positive price.' });
    }

    // Friendly preflight against a possibly-stale snapshot. The authoritative
    // guards are the conditional balance claims INSIDE the placement
    // transaction below — a concurrent spend between this read and the claim
    // fails the claim and rolls the whole placement back.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { azmBalance: true, availableBalance: true },
    });

    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (side === 'SELL') {
      const azmBal = parseFloat(user.azmBalance.toString());
      if (azmBal < qty) {
        return res.status(400).json({ success: false, message: 'Insufficient AZM balance.' });
      }
    } else {
      // BUY: need price * quantity in USDC
      const usdcNeeded = type === 'MARKET'
        ? qty * await getBestAskPrice() // estimate at best ask
        : qty * orderPrice;
      const usdcBal = parseFloat(user.availableBalance.toString());
      if (usdcBal < usdcNeeded) {
        return res.status(400).json({ success: false, message: 'Insufficient USDC balance.' });
      }
    }

    // Create order and attempt matching
    const result = await prisma.$transaction(async (tx) => {
      // r16 P0-F: guarded balance claims. SELL reserves AZM; BUY reserves
      // USDC at the limit price (MARKET BUY: at the best-ask estimate).
      // The conditional decrement fails closed when a concurrent placement
      // spent the balance first — the CHECK constraints on User are the
      // last-resort backstop, these claims are the primary guard.
      let reserveUsdc = null;
      if (side === 'SELL') {
        const azmClaim = await tx.user.updateMany({
          where: { id: userId, azmBalance: { gte: qty } },
          data: { azmBalance: { decrement: qty } },
        });
        if (azmClaim.count !== 1) {
          const err = new Error('Insufficient AZM balance.');
          err.status = 400;
          throw err;
        }
      } else {
        reserveUsdc = type === 'MARKET'
          ? qty * (await getBestAskPriceTx(tx))
          : qty * orderPrice;
        // No asks at all for a MARKET BUY: nothing to reserve (the refund
        // path at the end of matching handles the zero-reserve case).
        if (!Number.isFinite(reserveUsdc)) reserveUsdc = 0;
        if (reserveUsdc < 0) reserveUsdc = 0;

        if (reserveUsdc > 0) {
          const usdcClaim = await tx.user.updateMany({
            where: { id: userId, availableBalance: { gte: reserveUsdc } },
            data: { availableBalance: { decrement: reserveUsdc } },
          });
          if (usdcClaim.count !== 1) {
            const err = new Error('Insufficient USDC balance.');
            err.status = 400;
            throw err;
          }
        }
      }

      // r16 P0-F (defect 1): create the order FIRST — the ledger reserve
      // identity must reference an order id that already exists. The old
      // code posted `ledger:orderbook:reserve:${order.id}` before creating
      // `order`, a temporal-dead-zone crash on every BUY placement.
      const order = await tx.orderBookOrder.create({
        data: {
          userId,
          pair: PAIR,
          side,
          type,
          price: orderPrice,
          quantity: qty,
          remainingQuantity: qty,
          status: 'OPEN',
        },
      });

      if (side === 'BUY' && reserveUsdc > 0) {
        // §P.4 AUTHORITATIVE LEDGER — BUY reserve enters the matching
        // engine's clearing pool (the order book never touches user escrow
        // projection columns), same transaction, idempotent on the freshly
        // created order identity:
        //   D user:{userId}:liability — available liability down
        //   C clearing:orderbook:usdc — reserve held by the matching engine
        await ledger.post(tx, {
          idempotencyKey: `ledger:orderbook:reserve:${order.id}`,
          entryType: 'TRADE',
          description: 'Order-book BUY placed — USDC reserve withheld by matching engine',
          userId,
          relatedEntity: 'orderBookOrder',
          relatedEntityId: order.id,
          metadata: { side: 'BUY', type, reserveUsdc: _exact(reserveUsdc) },
          lines: [
            { account: `user:${userId}:liability`, debit: _exact(reserveUsdc) },
            { account: 'clearing:orderbook:usdc', credit: _exact(reserveUsdc) },
          ],
        });
      }

      // Match the order
      const matches = await matchOrder(tx, order, { reserveUsdc });

      return { order, matches };
    });

    return res.json({
      success: true,
      message: `Order placed. ${result.matches.length} trade(s) executed.`,
      order: result.order,
      trades: result.matches,
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    logger.error({ err: err }, '[orderBook] place error');
    return res.status(500).json({ success: false, message: 'Failed to place order.' });
  }
}

// ── Matching engine ─────────────────────────────────────────────────────────
async function matchOrder(tx, order, opts = {}) {
  const matches = [];

  const reserveUsdc = opts.reserveUsdc ?? null;
  // Reservation unit price: the per-AZM price the reserve actually covers.
  // For LIMIT BUY it is the limit price; for MARKET BUY the best-ask
  // estimate captured at reservation time. A MARKET BUY may never fill
  // above this price — a concurrent upward book move cannot make charges
  // exceed the reserve.
  const reservedUnitPrice = order.side === 'BUY' && reserveUsdc !== null && reserveUsdc > 0
    ? reserveUsdc / parseFloat(order.quantity.toString())
    : null;

  // Find opposite-side orders to match against
  const oppositeSide = order.side === 'BUY' ? 'SELL' : 'BUY';
  const matchingCondition = order.side === 'BUY'
    ? { lte: order.price } // BUY matches SELLs at or below buy price
    : { gte: order.price }; // SELL matches BUYs at or above sell price

  const candidates = await tx.orderBookOrder.findMany({
    where: {
      pair: PAIR,
      side: oppositeSide,
      // r16 P0-F (defect 3): partially-filled resting orders stay on the
      // book — the old `status: 'OPEN'` filter stranded their remaining
      // quantity (and the AZM/USDC already reserved against it).
      status: { in: RESTING_STATUSES },
      type: 'LIMIT',
      price: order.type === 'MARKET'
        ? (order.side === 'BUY' && reservedUnitPrice !== null
            ? { lte: reservedUnitPrice } // MARKET BUY: bounded by the reservation
            : undefined)
        : matchingCondition,
      remainingQuantity: { gt: 0 },
      userId: { not: order.userId }, // don't match self
    },
    orderBy: order.side === 'BUY'
      ? [{ price: 'asc' }, { createdAt: 'asc' }]  // BUY: best (lowest) ask first
      : [{ price: 'desc' }, { createdAt: 'asc' }], // SELL: best (highest) bid first
  });

  let remainingQty = order.remainingQuantity;

  for (const candidate of candidates) {
    if (remainingQty <= 0) break;

    // r16 P0-F (defect 2): DB-authoritative candidate claim. The guarded
    // conditional decrement must win before any money moves; a concurrent
    // taker (or a cancellation) that changed the candidate's state between
    // our read and this write makes the claim fail and we re-read/skip
    // instead of settling more quantity than the order contains.
    let matchQty = Math.min(remainingQty, parseFloat(candidate.remainingQuantity.toString()));
    let claim = await claimCandidateQuantity(tx, candidate.id, matchQty);
    if (claim.count !== 1) {
      const fresh = await tx.orderBookOrder.findUnique({
        where: { id: candidate.id },
        select: { status: true, remainingQuantity: true },
      });
      if (!fresh || !RESTING_STATUSES.includes(fresh.status)) continue;
      const freshRemaining = parseFloat(fresh.remainingQuantity.toString());
      if (!(freshRemaining > 0)) continue;
      matchQty = Math.min(remainingQty, freshRemaining);
      claim = await claimCandidateQuantity(tx, candidate.id, matchQty);
      if (claim.count !== 1) continue;
    }

    // Trades execute at the RESTING order's price (price-time priority):
    // a BUY taker matching a cheaper ask fills at the ask (improvement
    // refunded below); a SELL taker matching a higher resting bid fills
    // at the bid — exactly what the resting BUY reserved.
    const matchPrice = parseFloat(candidate.price.toString());

    // Both fees are deducted from the USDC recipient's credit, so the
    // clearing pool is charged EXACTLY matchQty * matchPrice — fully
    // funded by the BUY-side reserve on either taker direction. The old
    // code charged fees to clearing without any reserve including them
    // (unfunded overdraw on every match).
    const makerFee = matchQty * matchPrice * MAKER_FEE;
    const takerFee = matchQty * matchPrice * TAKER_FEE;
    const totalFees = makerFee + takerFee;
    const usdcToRecipient = matchQty * matchPrice - totalFees;

    // Create trade record
    const trade = await tx.orderBookTrade.create({
      data: {
        pair: PAIR,
        makerOrderId: candidate.id,
        takerOrderId: order.id,
        price: matchPrice,
        quantity: matchQty,
        makerFee,
        takerFee,
        makerUserId: candidate.userId,
        takerUserId: order.userId,
      },
    });

    // Settle balances
    // BUY (taker) receives AZM, pays USDC from its reserve
    // SELL (taker) receives USDC (minus both fees), pays AZM
    // The USDC recipient absorbs both fees; the AZM recipient pays none.
    if (order.side === 'BUY') {
      // Taker is buyer: credit AZM; USDC (minus fees) to the maker (seller)
      await tx.user.update({
        where: { id: order.userId },
        data: { azmBalance: { increment: matchQty } },
      });
      await tx.user.update({
        where: { id: candidate.userId },
        data: { availableBalance: { increment: usdcToRecipient } },
      });
    } else {
      // Taker is seller: USDC (minus fees) to the taker; AZM to the maker (buyer)
      await tx.user.update({
        where: { id: order.userId },
        data: { availableBalance: { increment: usdcToRecipient } },
      });
      await tx.user.update({
        where: { id: candidate.userId },
        data: { azmBalance: { increment: matchQty } },
      });
    }

    // Credit fees to platform
    await tx.systemProfitFees.upsert({
      where: { id: 1 },
      update: { balance: { increment: totalFees } },
      create: { id: 1, balance: totalFees },
    });

    // §P.4 AUTHORITATIVE LEDGER — match settlement, same transaction,
    // idempotent on the durable orderBookTrade row. The clearing pool is
    // charged EXACTLY what is distributed (recipient credit + fees), and
    // that charge is exactly what a BUY-side reserve funded:
    //   D clearing:orderbook:usdc → C user:{recipient}:liability + fees
    await ledger.post(tx, {
      idempotencyKey: `ledger:orderbook:match:${trade.id}`,
      entryType: 'TRADE',
      description: 'Order-book match settled — USDC reserve released to seller side, fees realized',
      userId: order.userId,
      relatedEntity: 'orderBookTrade',
      relatedEntityId: trade.id,
      metadata: {
        takerOrderId: order.id,
        makerOrderId: candidate.id,
        matchQty, matchPrice,
        makerFee: _exact(makerFee), takerFee: _exact(takerFee),
      },
      lines: [
        { account: 'clearing:orderbook:usdc', debit: _exact(matchQty * matchPrice) },
        { account: `user:${order.side === 'BUY' ? candidate.userId : order.userId}:liability`, credit: _exact(usdcToRecipient) },
        { account: 'equity:treasury', credit: _exact(totalFees) },
      ],
    });

    // BUY-taker price improvement: the taker reserved at its limit price
    // (or the MARKET estimate) but filled at the cheaper resting ask —
    // refund the difference immediately so no reserve dust strands in the
    // clearing pool when the order fully fills.
    if (order.side === 'BUY' && reservedUnitPrice !== null && reservedUnitPrice > matchPrice) {
      const improvement = (reservedUnitPrice - matchPrice) * matchQty;
      if (improvement > 0) {
        await tx.user.update({
          where: { id: order.userId },
          data: { availableBalance: { increment: improvement } },
        });
        await ledger.post(tx, {
          idempotencyKey: `ledger:orderbook:improvement:${trade.id}`,
          entryType: 'TRADE',
          description: 'Order-book BUY filled below the reserved price — price-improvement refund',
          userId: order.userId,
          relatedEntity: 'orderBookTrade',
          relatedEntityId: trade.id,
          metadata: { matchPrice: _exact(matchPrice), reservedUnitPrice: _exact(reservedUnitPrice), improvement: _exact(improvement) },
          lines: [
            { account: 'clearing:orderbook:usdc', debit: _exact(improvement) },
            { account: `user:${order.userId}:liability`, credit: _exact(improvement) },
          ],
        });
      }
    }

    // Candidate terminal status (we hold the row lock from the claim inside
    // this transaction — the read-compute-write below cannot interleave).
    const afterClaim = await tx.orderBookOrder.findUnique({
      where: { id: candidate.id },
      select: { remainingQuantity: true },
    });
    const candidateRemaining = parseFloat(afterClaim.remainingQuantity.toString());
    await tx.orderBookOrder.update({
      where: { id: candidate.id },
      data: {
        status: candidateRemaining <= 0 ? 'FILLED' : 'PARTIALLY_FILLED',
      },
    });

    remainingQty -= matchQty;
    matches.push(trade);
  }

  // Update the incoming order (created in this transaction — only this
  // transaction can touch it).
  const filledQty = order.remainingQuantity - remainingQty;
  const newStatus = remainingQty <= 0 ? 'FILLED' : (filledQty > 0 ? 'PARTIALLY_FILLED' : 'OPEN');

  await tx.orderBookOrder.update({
    where: { id: order.id },
    data: {
      remainingQuantity: remainingQty,
      status: newStatus,
    },
  });

  // MARKET BUY leftover reserve: the unreserved portion of the estimate
  // (fills consumed exactly matchQty * matchPrice at candidate prices, the
  // improvement block already refunded per-unit estimate differences) is
  // refunded at the reservation rate. The old code multiplied the leftover
  // quantity by `order.price || bestAsk || 0` — both null for MARKET BUY —
  // so a book that lost its asks between reservation and matching silently
  // kept the user's reserve.
  if (order.type === 'MARKET' && order.side === 'BUY' && remainingQty > 0 && reservedUnitPrice !== null) {
    const refundAmount = remainingQty * reservedUnitPrice;
    if (refundAmount > 0) {
      await tx.user.update({
        where: { id: order.userId },
        data: { availableBalance: { increment: refundAmount } },
      });
      // §P.4 AUTHORITATIVE LEDGER — unused market-order reserve refunds
      // from the clearing pool, same transaction, idempotent on the
      // order's placement identity (a MARKET order finalizes once).
      await ledger.post(tx, {
        idempotencyKey: `ledger:orderbook:place-refund:${order.id}`,
        entryType: 'TRADE',
        description: 'Market BUY could not fully fill — unused reserve refunded',
        userId: order.userId,
        relatedEntity: 'orderBookOrder',
        relatedEntityId: order.id,
        metadata: { refundAmount: _exact(refundAmount) },
        lines: [
          { account: 'clearing:orderbook:usdc', debit: _exact(refundAmount) },
          { account: `user:${order.userId}:liability`, credit: _exact(refundAmount) },
        ],
      });
    }
  }

  return matches;
}

// Guarded conditional decrement on a resting order: wins only if the order
// is still resting AND still holds the requested quantity. This is the
// single-winner claim that prevents two takers (or a taker and a
// cancellation) from consuming the same resting quantity.
async function claimCandidateQuantity(tx, candidateId, matchQty) {
  return tx.orderBookOrder.updateMany({
    where: {
      id: candidateId,
      status: { in: RESTING_STATUSES },
      remainingQuantity: { gte: matchQty },
    },
    data: { remainingQuantity: { decrement: matchQty } },
  });
}

async function getBestAskPrice() {
  const best = await prisma.orderBookOrder.findFirst({
    where: { pair: PAIR, side: 'SELL', status: { in: RESTING_STATUSES }, type: 'LIMIT', remainingQuantity: { gt: 0 } },
    orderBy: [{ price: 'asc' }, { createdAt: 'asc' }],
    select: { price: true },
  });
  return best ? parseFloat(best.price.toString()) : null;
}

async function getBestAskPriceTx(tx) {
  const best = await tx.orderBookOrder.findFirst({
    where: { pair: PAIR, side: 'SELL', status: { in: RESTING_STATUSES }, type: 'LIMIT', remainingQuantity: { gt: 0 } },
    orderBy: [{ price: 'asc' }, { createdAt: 'asc' }],
    select: { price: true },
  });
  return best ? parseFloat(best.price.toString()) : null;
}

// ── GET /api/order-book ─────────────────────────────────────────────────────
async function getOrderBook(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.depth, 10) || 20, 50);

    const [bids, asks] = await Promise.all([
      prisma.orderBookOrder.findMany({
        where: { pair: PAIR, side: 'BUY', status: { in: ['OPEN', 'PARTIALLY_FILLED'] }, type: 'LIMIT', remainingQuantity: { gt: 0 } },
        orderBy: [{ price: 'desc' }, { createdAt: 'asc' }],
        take: limit,
        select: { price: true, remainingQuantity: true, createdAt: true },
      }),
      prisma.orderBookOrder.findMany({
        where: { pair: PAIR, side: 'SELL', status: { in: ['OPEN', 'PARTIALLY_FILLED'] }, type: 'LIMIT', remainingQuantity: { gt: 0 } },
        orderBy: [{ price: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        select: { price: true, remainingQuantity: true, createdAt: true },
      }),
    ]);

    // Aggregate by price level
    const bidLevels = aggregateByPrice(bids);
    const askLevels = aggregateByPrice(asks);

    // Last trade price
    const lastTrade = await prisma.orderBookTrade.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { price: true, quantity: true, createdAt: true },
    });

    return res.json({
      success: true,
      pair: PAIR,
      bids: bidLevels,
      asks: askLevels,
      lastPrice: lastTrade ? parseFloat(lastTrade.price.toString()) : null,
      lastTradeAt: lastTrade?.createdAt?.toISOString() || null,
    });
  } catch (err) {
    logger.error({ err: err }, '[orderBook] book error');
    return res.status(500).json({ success: false, message: 'Failed to load order book.' });
  }
}

function aggregateByPrice(orders) {
  const levels = {};
  for (const o of orders) {
    const price = parseFloat(o.price.toString());
    const qty = parseFloat(o.remainingQuantity.toString());
    if (levels[price]) {
      levels[price] += qty;
    } else {
      levels[price] = qty;
    }
  }
  return Object.entries(levels).map(([price, quantity]) => ({
    price: parseFloat(price),
    quantity: parseFloat(quantity.toFixed(8)),
  }));
}

// ── GET /api/order-book/orders/my ────────────────────────────────────────────
async function getMyOrders(req, res) {
  try {
    const orders = await prisma.orderBookOrder.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ success: true, orders });
  } catch (err) {
    logger.error({ err: err }, '[orderBook] my orders error');
    return res.status(500).json({ success: false, message: 'Failed to load orders.' });
  }
}

// ── GET /api/order-book/trades ──────────────────────────────────────────────
async function getTradeHistory(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const trades = await prisma.orderBookTrade.findMany({
      where: {
        OR: [{ makerUserId: req.user.id }, { takerUserId: req.user.id }],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return res.json({ success: true, trades });
  } catch (err) {
    logger.error({ err: err }, '[orderBook] trade history error');
    return res.status(500).json({ success: false, message: 'Failed to load trades.' });
  }
}

// ── DELETE /api/order-book/orders/:id ───────────────────────────────────────
async function cancelOrder(req, res) {
  try {
    const orderId = req.params.id;
    const userId = req.user.id;

    const order = await prisma.orderBookOrder.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.userId !== userId) return res.status(403).json({ success: false, message: 'Not your order.' });
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Order cannot be cancelled.' });
    }

    await prisma.$transaction(async (tx) => {
      // r16 P0-F: the CANCELLED claim and the refunded quantity are now ONE
      // atomic statement. The old code claimed by status and then refunded
      // `remainingQuantity` from the stale pre-transaction read — a match
      // decrementing the same row between the read and the claim flipped
      // the row to CANCELLED with the taker's quantity still attached:
      // both the taker and the canceller were paid for the same quantity.
      // UPDATE ... RETURNING captures the exact remaining at claim time.
      // The locked CTE captures the pre-cancel remaining (RETURNING a
      // subselect column, not the post-update row) so the refund and the
      // terminal state stay one atomic statement — a CANCELLED order must
      // never leave quantity attached (the old claim left
      // remainingQuantity dangling on the cancelled row).
      const rows = await tx.$queryRawUnsafe(
        'UPDATE "OrderBookOrder" o SET "status" = \'CANCELLED\', "remainingQuantity" = 0, "updatedAt" = now() ' +
        'FROM (SELECT "remainingQuantity" AS rem, "price" FROM "OrderBookOrder" ' +
        'WHERE "id" = $1 AND "status" IN (\'OPEN\', \'PARTIALLY_FILLED\') FOR UPDATE) prev ' +
        'WHERE o."id" = $1 RETURNING prev.rem AS "remainingQuantity", prev."price"',
        orderId
      );
      const claimed = rows?.[0];
      if (!claimed) {
        throw new Error('ORDER_ALREADY_FINALIZED');
      }
      const remaining = parseFloat(claimed.remainingQuantity.toString());

      if (order.side === 'SELL') {
        if (remaining > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { azmBalance: { increment: remaining } },
          });
        }
      } else if (remaining > 0) {
        const refundUsdc = remaining * parseFloat(claimed.price.toString());
        await tx.user.update({
          where: { id: userId },
          data: { availableBalance: { increment: refundUsdc } },
        });
        // §P.4 AUTHORITATIVE LEDGER — cancelled BUY reserve refunds from
        // the clearing pool, same transaction, idempotent on the order's
        // terminal identity (the CANCELLED claim above is single-winner).
        await ledger.post(tx, {
          idempotencyKey: `ledger:orderbook:cancel:${orderId}`,
          entryType: 'TRADE',
          description: 'Order-book BUY cancelled — remaining reserve refunded',
          userId,
          relatedEntity: 'orderBookOrder',
          relatedEntityId: orderId,
          metadata: { refundUsdc: _exact(refundUsdc) },
          lines: [
            { account: 'clearing:orderbook:usdc', debit: _exact(refundUsdc) },
            { account: `user:${userId}:liability`, credit: _exact(refundUsdc) },
          ],
        });
      }
    });

    return res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    if (err && err.message === 'ORDER_ALREADY_FINALIZED') {
      return res.status(409).json({ success: false, message: 'Order already finalized.' });
    }
    logger.error({ err: err }, '[orderBook] cancel error');
    return res.status(500).json({ success: false, message: 'Failed to cancel order.' });
  }
}

module.exports = {
  placeOrder,
  getOrderBook,
  getMyOrders,
  getTradeHistory,
  cancelOrder,
};
