const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/azaman_db'
});
async function main() {
  await client.connect();
  const res = await client.query('SELECT id, content, "messageType", metadata FROM "DirectMessage" ORDER BY "createdAt" DESC LIMIT 10');
  console.log(res.rows);
  await client.end();
}
main().catch(console.error);
