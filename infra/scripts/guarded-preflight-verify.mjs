// Guarded helpers for converge-original-prod-branch.yml.
// Modes: preflight | counts | guard | verify.
//
// Read-only contract: every mode opens ONE connection, issues
// `BEGIN READ ONLY`, does all of its work inside that transaction, and ALWAYS
// rolls back + ends the connection in a finally block. PostgreSQL rejects any
// write inside a READ ONLY transaction, so the contract is enforced by the
// engine, not by discipline.
//
// Target guard (fails closed): the connection host must equal GUARD_EXPECTED_HOST
// (default: the original production branch direct endpoint) and the database
// must equal GUARD_EXPECTED_DB (default: neondb). The observed host is never
// echoed on mismatch; connection strings and credentials are never printed.
// The env overrides exist ONLY so disposable-PostgreSQL tests can exercise all
// modes; the production workflow never sets them.

import pg from 'pg';
import fs from 'node:fs';

const DEFAULT_EXPECTED_HOST = 'ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech';
const DEFAULT_EXPECTED_DB = 'neondb';

// ============================================================================
// Audited convergence inventory (read-only dual audit 2026-10-12, Actions run
// 38248783888, branch prod-audit). These are EXACTLY the objects the audited
// schema-only installer sequence provisions on the original production branch.
//
// Installer-owned tables (missing on the branch, created by the sequence):
//   r42 -> FinancialOperation; payment-requests -> PaymentRequest;
//   business-price -> BusinessPrice; fiat-liquidity -> Fiat* x4;
//   model-b-settlement -> ModelBSettlement, InventoryLot;
//   payout-reconciliation -> ProviderSettlementAttempt, ReconciliationException.
// Installer-owned columns (missing on the branch, added by the sequence):
//   payout-reconciliation -> Withdrawal.transactionHistoryId
//   fiat-liquidity        -> GlobalSettings.fiatLiquidityAuthorityEnabled
//   model-b-settlement    -> GlobalSettings.modelBSettlementEnabled
//   r16                   -> VaultDeposit.idempotencyKey, SmartRouteRun.executionKey
//   r19                   -> SmartRouteRun.{action, claimedOccurrenceAt, dayOfMonth,
//                            destFriendUserId, destMomoNumber, destMomoProvider,
//                            destSavingsGoalId, destVaultId, frequency}
//   inventory-restock     -> InventoryRestockOperation.fingerprintVersion;
//                            InventoryRestockIntent.status is asserted too
//                            (present on the audited branch, re-asserted here)
// Named constraints/indexes asserted after apply:
//   Withdrawal_transactionHistoryId_key, ProviderSettlementAttempt_provider_providerReference_key,
//   ReconciliationException_entity_reason_open_key, business_price_current_unique.
//
// OUT OF SCOPE (prisma-schema objects with NO production installer — missing on
// BOTH audited databases, NOT provisioned by the reviewed sequence, and NOT
// verified here; the backend demonstrably runs without them):
//   LedgerAccount, LedgerTransaction, RestrictedObligation, InventoryLotConsumption,
//   AdminRoleAssignment, CustodyAccount/CustodyEvidence/CustodyExecution/CustodyMovement
//   (custody installers are not part of the release chain),
//   GlobalSettings.lastAdminSetAt/lastEchoAt/lastExternalSync,
//   JournalEntry.ledgerTransactionId/lineNumber, SmartRouteRun.updatedAt,
//   AdminApprovalRequest.executedAt, OrderTracking.yieldEnabled (neither is
//   installer-owned: the first audit's installer-scan pairing attributed
//   these to installers via a regex artifact — the dual prisma-authoritative
//   audit shows no installer adds them),
//   ProofOfReservesSnapshot custody/ledger columns.
// ============================================================================

const AUDITED_TABLES = [
  'FinancialOperation', 'PaymentRequest', 'BusinessPrice',
  'FiatLiquidityReceipt', 'FiatLiquidityReservation', 'FiatLiquidityState', 'FiatProviderEvent',
  'ModelBSettlement', 'InventoryLot', 'ProviderSettlementAttempt', 'ReconciliationException',
];

const AUDITED_COLUMNS = [
  ['Withdrawal', 'transactionHistoryId'],
  ['GlobalSettings', 'fiatLiquidityAuthorityEnabled'],
  ['GlobalSettings', 'modelBSettlementEnabled'],
  ['VaultDeposit', 'idempotencyKey'],
  ['SmartRouteRun', 'executionKey'],
  ['SmartRouteRun', 'action'],
  ['SmartRouteRun', 'claimedOccurrenceAt'],
  ['SmartRouteRun', 'dayOfMonth'],
  ['SmartRouteRun', 'destFriendUserId'],
  ['SmartRouteRun', 'destMomoNumber'],
  ['SmartRouteRun', 'destMomoProvider'],
  ['SmartRouteRun', 'destSavingsGoalId'],
  ['SmartRouteRun', 'destVaultId'],
  ['SmartRouteRun', 'frequency'],
  ['InventoryRestockOperation', 'fingerprintVersion'],
  ['InventoryRestockIntent', 'status'],
];

const AUDITED_INDEXES = [
  'Withdrawal_transactionHistoryId_key',
  'ProviderSettlementAttempt_provider_providerReference_key',
  'ReconciliationException_entity_reason_open_key',
  'business_price_current_unique',
];

// Baseline-preservation set: important existing business/financial tables whose
// row counts must be identical before and after the apply step.
const CORE_TABLES = [
  ['user_count', 'User'],
  ['transaction_count', 'TransactionHistory'],
  ['message_count', 'Message'],
  ['trade_count', 'Trade'],
  ['peer_transfer_count', 'PeerTransfer'],
  ['business_profile_count', 'BusinessProfile'],
  ['business_product_count', 'BusinessProduct'],
  ['wallet_count', 'Wallet'],
];

function targetUrl() {
  const url = process.env.DB_URL || process.env.DATABASE_URL;
  if (!url) { console.error('::error::no connection URL provided'); process.exit(1); }
  return url;
}

async function connect() {
  const url = targetUrl();
  const expectedHost = process.env.GUARD_EXPECTED_HOST || DEFAULT_EXPECTED_HOST;
  const expectedDb = process.env.GUARD_EXPECTED_DB || DEFAULT_EXPECTED_DB;
  let host = null;
  try { host = new URL(url).hostname; } catch { host = null; }
  if (host !== expectedHost) {
    // fail closed; never echo the observed host or URL
    console.error('::error::target guard failed: connection is not the expected guarded endpoint. Aborting.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  await client.connect();
  const db = (await client.query('SELECT current_database()')).rows[0].current_database;
  if (db !== expectedDb) {
    await client.end().catch(() => {});
    console.error('::error::target guard failed: database is not the expected one. Aborting.');
    process.exit(1);
  }
  // Engine-enforced read-only contract for everything this script does.
  await client.query('BEGIN READ ONLY');
  return client;
}

async function scalar(client, q) {
  const r = await client.query(q);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

function isAbsent(v) {
  return v === true || v === 't';
}

async function coreCounts(client) {
  const out = {};
  for (const [key, tbl] of CORE_TABLES) {
    const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${tbl}"') IS NULL`));
    out[key] = absent ? -1 : Number(await scalar(client, `SELECT count(*) FROM "${tbl}"`));
  }
  return out;
}

async function main() {
  const mode = process.argv[2];
  const client = await connect();
  try {
    if (mode === 'guard') {
      console.log('target guard passed: expected endpoint and database.');
      return;
    }

    if (mode === 'preflight') {
      const userRows = Number(await scalar(client, 'SELECT count(*) FROM "User"'));
      const txRows = Number(await scalar(client, 'SELECT count(*) FROM "TransactionHistory"'));
      if (userRows === 0 || txRows === 0) {
        console.error('::error::preflight failed: core application tables are missing or empty — this does not look like the original production branch. Aborting.');
        process.exitCode = 1;
        return;
      }
      console.log(`production identity confirmed: User=${userRows} rows, TransactionHistory=${txRows} rows`);

      const ikAbsent = isAbsent(await scalar(client, 'SELECT to_regclass(\'"IdempotencyKey"\') IS NULL'));
      if (!ikAbsent) {
        const ikRows = Number(await scalar(client, 'SELECT count(*) FROM "IdempotencyKey"'));
        if (ikRows > 0) {
          console.error(`::error::preflight REFUSED: legacy IdempotencyKey exists and is populated (${ikRows} rows). The r42 installer retires this table; a human must export/migrate those rows first. Aborting before any write.`);
          process.exitCode = 1;
          return;
        }
        console.log('IdempotencyKey: exists, 0 rows (safe for the reviewed r42 retirement path).');
      } else {
        console.log('IdempotencyKey: absent.');
      }

      for (const t of AUDITED_TABLES) {
        const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${t}"') IS NULL`));
        console.log(`audited additive target ${t}: ${absent ? 'absent (will be created)' : 'already present (idempotent replay)'}`);
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
      for (const t of AUDITED_TABLES) {
        const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${t}"') IS NULL`));
        if (absent) { console.error(`::error::verify failed: audited table ${t} missing after apply.`); failed++; }
        else {
          const pk = Number(await scalar(client, `SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='${t}' AND constraint_type='PRIMARY KEY'`));
          if (pk === 0) { console.error(`::error::verify failed: audited table ${t} has no PRIMARY KEY.`); failed++; }
          else console.log(`table ${t}: present, PRIMARY KEY present`);
        }
      }
      for (const [t, c] of AUDITED_COLUMNS) {
        const n = Number(await scalar(client, `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}'`));
        if (n === 0) { console.error(`::error::verify failed: audited column ${t}.${c} missing after apply.`); failed++; }
        else console.log(`column ${t}.${c}: present`);
      }
      for (const idx of AUDITED_INDEXES) {
        const n = Number(await scalar(client, `SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${idx}'`));
        if (n === 0) { console.error(`::error::verify failed: audited index ${idx} missing after apply.`); failed++; }
        else console.log(`index ${idx}: present`);
      }
      const ikAbsent = isAbsent(await scalar(client, 'SELECT to_regclass(\'"IdempotencyKey"\') IS NULL'));
      if (!ikAbsent) {
        const ikRows = Number(await scalar(client, 'SELECT count(*) FROM "IdempotencyKey"'));
        if (ikRows !== 0) { console.error(`::error::verify failed: IdempotencyKey still exists and is not empty (${ikRows} rows).`); failed++; }
        else console.log('IdempotencyKey: present, 0 rows.');
      } else {
        console.log('IdempotencyKey: absent (retired cleanly by the r42 installer).');
      }
      const after = await coreCounts(client);
      for (const [key, val] of Object.entries(after)) {
        const before = Number(process.env[key.toUpperCase()]);
        if (val === -1) { console.log(`${key}: table absent (skipped)`); continue; }
        if (Number.isNaN(before)) { console.log(`${key}: ${val} (no baseline passed)`); continue; }
        if (val !== before) { console.error(`::error::verify failed: ${key} changed ${before} -> ${val}; core tables must not lose rows.`); failed++; }
        else console.log(`${key}: ${val} (unchanged)`);
      }
      if (failed > 0) { console.error(`::error::verification failed with ${failed} error(s).`); process.exitCode = 1; return; }
      console.log('verification complete: all audited targets converged, core rows intact.');
      return;
    }

    console.error(`::error::unknown mode '${mode}'`);
    process.exitCode = 1;
  } finally {
    // reliable cleanup: always roll back the read-only transaction and release
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  // print only the first line of the error message; pg errors never contain
  // the connection string, and we never echo the URL ourselves
  console.error('::error::' + (err && err.message ? err.message.split('\n')[0] : 'unexpected failure'));
  process.exit(1);
});
