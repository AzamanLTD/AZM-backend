process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const biz = await db.businessProfile.create({ data: {} }).catch(async () => null);
  console.log('biz probe skipped');
})().catch(()=>{});
