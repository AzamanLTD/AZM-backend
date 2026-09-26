// prisma/seed.js — Seed the test SQLite database with realistic data
const { PrismaClient } = require('@prisma/test-client');

const prisma = new PrismaClient();

async function main() {
  // Clean slate
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.e2eeSession.deleteMany();
  await prisma.e2eeOneTimePreKey.deleteMany();
  await prisma.e2eePreKeyBundle.deleteMany();
  await prisma.escrowDispute.deleteMany();
  await prisma.escrow.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.globalSettings.deleteMany();

  // Global settings
  await prisma.globalSettings.create({ data: { id: 1 } });

  // Test users
  const hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcU7q0Jqgq3xHq7xQ7xQ7xQ7xQ';
  const alice = await prisma.user.create({
    data: {
      id: 'user_alice_001',
      email: 'alice@azaman.test',
      username: 'alice',
      password: hash,
      role: 'user',
      banStatus: 'active',
      isVerified: true,
      availableBalance: 5000.0,
      azmBalance: 250.0,
    }
  });

  const bob = await prisma.user.create({
    data: {
      id: 'user_bob_001',
      email: 'bob@azaman.test',
      username: 'bob',
      password: hash,
      role: 'user',
      banStatus: 'active',
      isVerified: true,
      availableBalance: 1500.0,
      azmBalance: 75.0,
    }
  });

  // Conversation between Alice and Bob
  const conv = await prisma.conversation.create({
    data: {
      id: 'conv_alice_bob_001',
      type: 'personal',
      participants: { connect: [{ id: alice.id }, { id: bob.id }] }
    }
  });

  // Some messages
  await prisma.message.createMany({
    data: [
      {
        id: 'msg_001',
        conversationId: conv.id,
        senderId: alice.id,
        content: 'Hey Bob, ready for the trade?',
        messageType: 'TEXT',
        status: 'delivered',
      },
      {
        id: 'msg_002',
        conversationId: conv.id,
        senderId: bob.id,
        content: 'Yes! Send me the money.',
        messageType: 'TEXT',
        status: 'delivered',
      },
      {
        id: 'msg_003',
        conversationId: conv.id,
        senderId: alice.id,
        content: 'Sending $500',
        messageType: 'MONEY_SEND',
        status: 'sent',
        moneyAmount: 500.0,
        moneyDirection: 'send',
        moneyStatus: 'pending',
      },
    ]
  });

  // Escrow
  const escrow = await prisma.escrow.create({
    data: {
      id: 'escrow_001',
      tradeId: 'trade_test_001',
      buyerId: alice.id,
      vendorId: bob.id,
      amount: 750.0,
      status: 'FUNDED',
    }
  });

  console.log('Seed complete:');
  console.log('  Users: ' + [alice.username, bob.username].join(', '));
  console.log('  Conversation: ' + conv.id);
  console.log('  Messages: 3');
  console.log('  Escrow: ' + escrow.id + ' (' + escrow.status + ')');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
