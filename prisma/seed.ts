// prisma/seed.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import "dotenv/config";

// Default password for seeded test accounts. Change here if you want a different one.
const DEFAULT_SEED_PASSWORD = 'Test1234';

// 1. Initialize the Pool
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL 
});

// 2. Initialize the Adapter
const adapter = new PrismaPg(pool);

// 3. Initialize Prisma Client (THIS IS THE MISSING PIECE IN YOUR SEED FILE)
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Seeding Azaman Database for P2P Testing...');

  // Hash the default password once and reuse it for all seeded accounts.
  // Cost factor 12 matches the auth controller (controllers/authController.js).
  const hashedPassword = await bcrypt.hash(DEFAULT_SEED_PASSWORD, 12);

  // 1. Create/Update Vendor (Mirroring your server.js logic)
  const vendor = await prisma.user.upsert({
    where: { email: 'vendor@azaman.com' },
    update: { password: hashedPassword },
    create: {
      username: 'GoldTrader_GH',
      email: 'vendor@azaman.com',
      password: hashedPassword,
      availableBalance: 5000.0,
      role: 'VENDOR',
      tradesCompleted: 142,
      completionRate: 98.5,
    },
  });

  // 2. Create/Update Buyer
  const buyer = await prisma.user.upsert({
    where: { email: 'user@azaman.com' },
    update: { password: hashedPassword },
    create: {
      username: 'Azaman_User_1',
      email: 'user@azaman.com',
      password: hashedPassword,
      availableBalance: 2000.0,
      role: 'USER',
    },
  });

  console.log(`✅ Success! Seeded ${vendor.email} (vendor) and ${buyer.email} (user).`);
  console.log(`🔑 Login password for both accounts: ${DEFAULT_SEED_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (pool) {
      await (pool as Pool).end(); 
    }
    console.log('🔌 Seed connection closed.');
  });