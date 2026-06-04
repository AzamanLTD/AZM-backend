#!/usr/bin/env node
/**
 * Seed an active PENDING_PAYMENT trade between two users in the local DB.
 *
 * Usage: node scripts/seed-active-trade.js USER_EMAIL VENDOR_EMAIL
 *
 * Creates a Trade with status=PENDING_PAYMENT and expiresAt=now+15min,
 * plus a matching Conversation row so chat / extension messages have a
 * place to land. Skips Cloudinary, escrow lock, and notification fanout
 * since the goal is just to give the extension test a target.
 */

const { PrismaClient } = require('@prisma/client');

async function main() {
  const userEmail = process.argv[2];
  const vendorEmail = process.argv[3];
  if (!userEmail || !vendorEmail) {
    console.error('Usage: node scripts/seed-active-trade.js USER_EMAIL VENDOR_EMAIL');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email: userEmail } });
    const vendor = await prisma.user.findUnique({ where: { email: vendorEmail } });
    if (!user || !vendor) {
      console.error('User or vendor not found.');
      process.exit(1);
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const trade = await prisma.trade.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        amountFiat: 100,
        amountCrypto: 8.5,
        rate: 11.76,
        crypto: 'USDC',
        currency: 'KES',
        paymentMethod: 'M-PESA',
        type: 'BUY',
        status: 'PENDING_PAYMENT',
        expiresAt,
        selectedTimeframe: 15,
      },
    });

    await prisma.conversation.create({
      data: {
        type: 'TRADE',
        tradeId: String(trade.id),
        participants: { connect: [{ id: user.id }, { id: vendor.id }] },
      },
    });

    console.log(JSON.stringify({ tradeId: trade.id, expiresAt }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
