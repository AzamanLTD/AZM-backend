// Guarded helpers for converge-original-prod-branch.yml.
// Modes: preflight | counts | guard | verify  — ALL read-only except none.
// Safety: fails closed on any target mismatch; NEVER prints the connection
// string or credentials; failures withhold connection details.
import pg from 'pg';
import fs from 'node:fs';

const EXPECTED_HOST = 'ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech';
const EXPECTED_DB = 'neondb';

function targetUrl() {
  const url = process.env.DB_URL || process.env.DATABASE_URL;
  if (!url) { console.error('::error::no connection URL provided'); process.exit(1); }
  return url;
}

async function connect() {
  const url = targetUrl();
  let host;
  try { host = new URL(url).hostname; } catch { host = null; }
  if (host !== EXPECTED_HOST) {
    // deliberately does not echo the observed host: fail closed, no target details
    console.error('::error::target guard failed: connection is not the original production branch direct endpoint. Aborting.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  await client.connect();
  const db = (await client.query('SELECT current_database()')).rows[0].current_database;
  if (db !== EXPECTED_DB) {
    await client.end().catch(() => {});
    console.error('::error::target guard failed: database is not the expected one. Aborting.');
    process.exit(1);
  }
  return client;
}

async function scalar(client, q) {
  const r = await client.query(q);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

const CORE = {
  user_count: ['"User"', 'User'],
  transaction_count: ['"TransactionHistory"', 'TransactionHistory'],
  message_count: ['"Message"', 'Message'],
  business_profile_count: ['"BusinessProfile"', 'BusinessProfile'],
  business_product_count: ['"BusinessProduct"', 'BusinessProduct'],
};

async function coreCounts(client) {
  const out = {};
  for (const [key, [tbl, label]] of Object.entries(CORE)) {
    out[key] = Number(await scalar(client, `SELECT count(*) FROM ${tbl}`));
  }
  return out;
}

async function main() {
  const mode = process.argv[2];
  const client = await connect();
  try {
    if (mode === 'guard') {
      console.log('target guard passed: original production branch, expected database.');
      return;
    }

    if (mode === 'preflight') {
      const userRows = Number(await scalar(client, 'SELECT count(*) FROM "User"'));
      const txRows = Number(await scalar(client, 'SELECT count(*) FROM "TransactionHistory"'));
      if (userRows === 0 || txRows === 0) {
        console.error('::error::preflight failed: core application tables are missing or empty — this does not look like the original production branch. Aborting.');
        process.exit(1);
      }
      console.log(`production identity confirmed: User=${userRows} rows, TransactionHistory=${txRows} rows`);

      const ikAbsent = await scalar(client, `SELECT to_regclass('"IdempotencyKey"') IS NULL`);
      if (ikAbsent === false || ikAbsent === 'f') {
        const ikRows = Number(await scalar(client, 'SELECT count(*) FROM "IdempotencyKey"'));
        if (ikRows > 0) {
          console.error(`::error::preflight REFUSED: legacy IdempotencyKey exists and is populated (${ikRows} rows). The r42 installer retires this table; a human must export/migrate those rows first. Aborting before any write.`);
          process.exit(1);
        }
        console.log('IdempotencyKey: exists, 0 rows (safe for the reviewed r42 retirement path).');
      } else {
        console.log('IdempotencyKey: absent.');
      }

      for (const t of ['FinancialOperation', 'PaymentRequest', 'BusinessPrice']) {
        const absent = await scalar(client, `SELECT to_regclass('"${t}"') IS NULL`);
        console.log(`expected additive target ${t}: ${absent === true || absent === 't' ? 'absent (will be created)' : 'already present (idempotent replay)'}`);
      }
      return;
    }

    if (mode === 'counts') {
      const counts = await coreCounts(client);
      for (const [key, val] of Object.entries(counts)) {
        console.log(`${key}=${val}`);
        if (process.env.GITHUB_OUTPUT) {
          fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${val}\n`);
        }
      }
      return;
    }

    if (mode === 'verify') {
      let failed = 0;
      const mustExist = ['FinancialOperation', 'PaymentRequest', 'BusinessPrice',
        'ProviderSettlementAttempt', 'ReconciliationException',
        'FiatLiquidityReceipt', 'FiatLiquidityReservation', 'FiatLiquidityState', 'FiatProviderEvent',
        'ModelBSettlement', 'InventoryLot'];
      for (const t of mustExist) {
        const absent = await scalar(client, `SELECT to_regclass('"${t}"') IS NULL`);
        if (absent === true || absent === 't') { console.error(`::error::verify failed: table ${t} missing after apply.`); failed++; }
        else console.log(`table ${t}: present`);
      }
      const mustCols = [
        ['Withdrawal', 'transactionHistoryId'],
        ['GlobalSettings', 'fiatLiquidityAuthorityEnabled'],
        ['GlobalSettings', 'modelBSettlementEnabled'],
        ['VaultDeposit', 'idempotencyKey'],
        ['SmartRouteRun', 'executionKey'],
        ['SmartRouteRun', 'action'],
        ['SmartRouteRun', 'frequency'],
        ['SmartRouteRun', 'updatedAt'],
        ['AdminApprovalRequest', 'executedAt'],
        ['OrderTracking', 'yieldEnabled'],
      ];
      for (const [t, c] of mustCols) {
        const n = Number(await scalar(client, `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}'`));
        if (n === 0) { console.error(`::error::verify failed: column ${t}.${c} missing after apply.`); failed++; }
        else console.log(`column ${t}.${c}: present`);
      }
      const ikAbsent = await scalar(client, `SELECT to_regclass('"IdempotencyKey"') IS NULL`);
      if (ikAbsent === false || ikAbsent === 'f') {
        const ikRows = Number(await scalar(client, 'SELECT count(*) FROM "IdempotencyKey"'));
        if (ikRows !== 0) { console.error(`::error::verify failed: IdempotencyKey is not empty (${ikRows} rows).`); failed++; }
        else console.log('IdempotencyKey: present, 0 rows (retired/recreated cleanly).');
      } else {
        console.log('IdempotencyKey: absent (retired cleanly).');
      }
      const after = await coreCounts(client);
      for (const [key, val] of Object.entries(after)) {
        const before = Number(process.env[key.toUpperCase()]);
        if (Number.isNaN(before)) { console.log(`${key}: ${val} (no baseline passed)`); continue; }
        if (val !== before) { console.error(`::error::verify failed: ${key} changed ${before} -> ${val}; core tables must not lose rows.`); failed++; }
        else console.log(`${key}: ${val} (unchanged)`);
      }
      if (failed > 0) { console.error(`::error::verification failed with ${failed} error(s).`); process.exit(1); }
      console.log('verification complete: all audited targets converged, core rows intact.');
      return;
    }

    console.error(`::error::unknown mode '${mode}'`); process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  // never print err.connection?/detail: only the message, which never contains the URL
  console.error('::error::' + (err && err.message ? err.message.split('\n')[0] : 'unexpected failure'));
  process.exit(1);
});
