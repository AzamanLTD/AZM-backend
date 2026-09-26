// Restore migrations-only tables that `prisma db push` drops because their
// models are not (or no longer) in schema.prisma, while test suites still
// reference the physical tables (e.g. via raw SQL TRUNCATE lists).
// Usage: DATABASE_URL=... node scripts/restore-orphan-tables.js
const fs = require('fs');
const path = require('path');

const TARGETS = {
    'ProofOfReservesLeaf': '20260830070000_proof_of_reserves_leaf',
    'TransactionQuote': '20260829060000_transaction_quotes',
};

async function main() {
    const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
    const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
        for (const [table, dir] of Object.entries(TARGETS)) {
            const have = await c.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [table]);
            if (have.rowCount > 0) { console.log('exists:', table); continue; }
            const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', dir, 'migration.sql'), 'utf8');
            try {
                await c.query('BEGIN');
                await c.query(sql);
                await c.query('COMMIT');
                console.log('restored:', table, '(whole migration)');
            } catch (e) {
                await c.query('ROLLBACK');
                const start = sql.search(new RegExp('CREATE TABLE (?:IF NOT EXISTS )?"?' + table + '"?'));
                if (start < 0) throw new Error('cannot locate CREATE TABLE for ' + table);
                let depth = 0, end = -1, seen = false;
                for (let i = start; i < sql.length; i++) {
                    if (sql[i] === '(') { depth++; seen = true; }
                    else if (sql[i] === ')') { depth--; if (seen && depth === 0) { end = sql.indexOf(';', i) + 1; break; } }
                }
                await c.query(sql.slice(start, end));
                console.log('restored:', table, '(CREATE TABLE only)');
            }
        }
    } finally {
        await c.end();
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
