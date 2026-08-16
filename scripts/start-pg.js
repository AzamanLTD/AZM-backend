const EmbeddedPostgres = require('embedded-postgres').default;

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: './pgdata',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    createPostgresUser: true,
  });
  
  console.log('Starting embedded PostgreSQL...');
  await pg.initialise();
  await pg.start();
  console.log('PostgreSQL started on port 5432');
  console.log('DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres');
  
  process.on('SIGINT', async () => {
    console.log('Stopping...');
    await pg.stop();
    process.exit(0);
  });
  
  console.log('Running. Press Ctrl+C to stop.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
