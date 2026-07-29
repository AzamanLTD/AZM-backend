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
// Pair: AZM/USDC (price in USDC, quantity in AZM)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

const PAIR = 'AZM/USDC';
const MAKER_FEE = 0.002; // 0.2%
const TAKER_FEE = 0.005; // 0.5%
const MIN_ORDER_SIZE = 1;   // min 1 AZM

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

    // Check user has sufficient balance
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
      // Lock user balance
      if (side === 'SELL') {
        await tx.user.update({
          where: { id: userId },
          data: { azmBalance: { decrement: qty } },
        });
      } else {
        // For BUY, reserve USDC = qty * price (or best ask for market)
        const reserveUsdc = type === 'MARKET'
          ? qty * (await getBestAskPriceTx(tx))
          : qty * orderPrice;
        await tx.user.update({
          where: { id: userId },
          data: { availableBalance: { decrement: reserveUsdc } },
        });
      }

      // Create the order
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

      // Match the order
      const matches = await matchOrder(tx, order);

      return { order, matches };
    });

    return res.json({
      success: true,
      message: `Order placed. ${result.matches.length} trade(s) executed.`,
      order: result.order,
      trades: result.matches,
    });
  } catch (err) {
    logger.error({ err: err }, '[orderBook] place error');
    return res.status(500).json({ success: false, message: 'Failed to place order.' });
  }
}

// ── Matching engine ─────────────────────────────────────────────────────────
async function matchOrder(tx, order) {
  const matches = [];

  // Find opposite-side orders to match against
  const oppositeSide = order.side === 'BUY' ? 'SELL' : 'BUY';
  const matchingCondition = order.side === 'BUY'
    ? { lte: order.price } // BUY matches SELLs at or below buy price
    : { gte: order.price }; // SELL matches BUYs at or above sell price

  const candidates = await tx.orderBookOrder.findMany({
    where: {
      pair: PAIR,
      side: oppositeSide,
      status: 'OPEN',
      type: 'LIMIT',
      price: order.type === 'MARKET' ? undefined : matchingCondition,
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

    // For market orders, match at candidate's price
    const matchPrice = order.type === 'MARKET'
      ? parseFloat(candidate.price.toString())
      : parseFloat(order.price.toString());

    const matchQty = Math.min(remainingQty, parseFloat(candidate.remainingQuantity.toString()));

    // Determine maker/taker
    // The resting order (candidate) is the maker; the incoming order is the taker
    const makerFee = matchQty * matchPrice * MAKER_FEE;
    const takerFee = matchQty * matchPrice * TAKER_FEE;

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
    // BUY (taker) receives AZM, pays USDC
    // SELL (taker) receives USDC, pays AZM
    if (order.side === 'BUY') {
      // Taker is buyer: credit AZM, USDC already reserved
      await tx.user.update({
        where: { id: order.userId },
        data: { azmBalance: { increment: matchQty } },
      });
      // Maker is seller: credit USDC (minus maker fee), AZM already reserved
      const makerUsdcCredit = matchQty * matchPrice - makerFee;
      await tx.user.update({
        where: { id: candidate.userId },
        data: { availableBalance: { increment: makerUsdcCredit } },
      });
    } else {
      // Taker is seller: credit USDC (minus taker fee), AZM already reserved
      const takerUsdcCredit = matchQty * matchPrice - takerFee;
      await tx.user.update({
        where: { id: order.userId },
        data: { availableBalance: { increment: takerUsdcCredit } },
      });
      // Maker is buyer: credit AZM, USDC already reserved
      await tx.user.update({
        where: { id: candidate.userId },
        data: { azmBalance: { increment: matchQty } },
      });
    }

    // Credit fees to platform
    const totalFees = makerFee + takerFee;
    await tx.systemProfitFees.update({
      where: { id: 1 },
      data: { balance: { increment: totalFees } },
    });

    // Update remaining quantities
    remainingQty -= matchQty;
    const candidateRemaining = parseFloat(candidate.remainingQuantity.toString()) - matchQty;

    await tx.orderBookOrder.update({
      where: { id: candidate.id },
      data: {
        remainingQuantity: candidateRemaining,
        status: candidateRemaining <= 0 ? 'FILLED' : 'PARTIALLY_FILLED',
      },
    });

    matches.push(trade);
  }

  // Update the incoming order
  const filledQty = order.remainingQuantity - remainingQty;
  const newStatus = remainingQty <= 0 ? 'FILLED' : (filledQty > 0 ? 'PARTIALLY_FILLED' : 'OPEN');

  await tx.orderBookOrder.update({
    where: { id: order.id },
    data: {
      remainingQuantity: remainingQty,
      status: newStatus,
    },
  });

  // If BUY market order has remaining qty but no asks, refund unused USDC
  if (order.type === 'MARKET' && order.side === 'BUY' && remainingQty > 0) {
    const bestAsk = await getBestAskPriceTx(tx);
    if (bestAsk === null) {
      // No asks available, refund remaining
      const refundAmount = remainingQty * (order.price || bestAsk || 0);
      if (refundAmount > 0) {
        await tx.user.update({
          where: { id: order.userId },
          data: { availableBalance: { increment: refundAmount } },
        });
      }
    }
  }

  return matches;
}

async function getBestAskPrice() {
  const best = await prisma.orderBookOrder.findFirst({
    where: { pair: PAIR, side: 'SELL', status: 'OPEN', type: 'LIMIT', remainingQuantity: { gt: 0 } },
    orderBy: [{ price: 'asc' }, { createdAt: 'asc' }],
    select: { price: true },
  });
  return best ? parseFloat(best.price.toString()) : null;
}

async function getBestAskPriceTx(tx) {
  const best = await tx.orderBookOrder.findFirst({
    where: { pair: PAIR, side: 'SELL', status: 'OPEN', type: 'LIMIT', remainingQuantity: { gt: 0 } },
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

    // Refund remaining balance
    const remaining = parseFloat(order.remainingQuantity.toString());
    await prisma.$transaction(async (tx) => {
      if (order.side === 'SELL') {
        await tx.user.update({
          where: { id: userId },
          data: { azmBalance: { increment: remaining } },
        });
      } else {
        const refundUsdc = remaining * parseFloat(order.price.toString());
        await tx.user.update({
          where: { id: userId },
          data: { availableBalance: { increment: refundUsdc },
        },
        });
      }

      await tx.orderBookOrder.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
      });
    });

    return res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
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
