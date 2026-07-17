const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres:postgres@localhost:5432/azaman_db" // Assuming local default for testing, or we can check the real url from environment or somewhere
    }
  }
});
async function main() {
  const msgs = await prisma.directMessage.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log('Direct Messages:', msgs.map(m => ({ id: m.id, type: m.messageType, content: m.content, metadata: m.metadata })));
}
main().catch(console.error).finally(() => prisma.$disconnect());
