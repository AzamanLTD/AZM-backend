// Guarded helpers for converge-original-prod-branch.yml.
// Modes: preflight | counts | guard | verify.
//
// Read-only contract: every mode opens ONE connection, issues
// `BEGIN READ ONLY`, does all of its work inside that transaction, and ALWAYS
// rolls back + releases the connection in a finally block. PostgreSQL rejects
// any write inside a READ ONLY transaction, so the contract is enforced by the
// engine, not by discipline.
//
// Side-effect gates: the reviewed installer sequence is NOT purely DDL. Some
// steps would retire legacy tables, archive+delete orphaned financial
// records, backfill columns on existing rows, or insert initial system rows.
// preflight makes every one of those effects VISIBLE, and fails closed on any
// effect that has not been separately reviewed for THIS convergence run:
//   - legacy E2EE private-key tables (dropped by install-e2ee-server-blind):
//     a populated legacy table refuses the run;
//   - ConversationMoneyTicket orphan archival (install-business-os): any
//     orphan candidate refuses the run — those records must go through a
//     separately reviewed archival/reconciliation step;
//   - AzmRewardLog/AzmSpendLog dedupKey backfills (install-prod-drift):
//     any affected row refuses the run;
//   - initial system rows (DeFiYieldStrategy seeds, FiatLiquidityState
//     singleton) are EXPECTED INITIALIZATIONS: preflight reports their
//     current state and verify distinguishes them from changes to
//     pre-existing records.
//
// Target guard (fails closed): the connection host must equal GUARD_EXPECTED_HOST
// (default: the original production branch direct endpoint) and the database
// must equal GUARD_EXPECTED_DB (default: neondb). The observed host is never
// echoed on mismatch; connection strings and credentials are never printed.
// The env overrides exist ONLY so disposable-PostgreSQL tests can exercise all
// modes; the production workflow never sets them.
//
// Key values are never read: E2EE gates use row COUNTS and column presence
// only. No key material, passphrase, or credential is ever printed.

import pg from 'pg';
import fs from 'node:fs';

const DEFAULT_EXPECTED_HOST = 'ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech';
const DEFAULT_EXPECTED_DB = 'neondb';

// ============================================================================
// Audited convergence inventory (read-only dual audit 2026-10-12, Actions run
// 38248783888, branch prod-audit) — schema objects the sequence provisions.
//
// Installer-owned tables (missing on the branch, created by the sequence):
//   r42 -> FinancialOperation; payment-requests -> PaymentRequest;
//   business-price -> BusinessPrice; fiat-liquidity -> Fiat* x4;
//   model-b-settlement -> ModelBSettlement, InventoryLot, InventoryLotConsumption;
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
// INTENTIONAL INITIAL SYSTEM ROWS (documented, allowed):
//   install-phase3 seeds DeFiYieldStrategy rows AAVE + COMPOUND + INTERNAL_LP
//     (INSERT ... WHERE NOT EXISTS — additive, never overwrites);
//   install-fiat-liquidity inserts the zero-valued FiatLiquidityState
//     singleton (ON CONFLICT DO NOTHING).
// verify() distinguishes these expected initializations from any change to
// pre-existing records (see DEFI/FIAT rules below).
//
// OUT OF SCOPE (intentionally not added by this convergence):
//   AdminRoleAssignment, AdminApprovalRequest.executedAt, OrderTracking.yieldEnabled
//   (the dual prisma-authoritative audit showed no production installer owns them).
// ============================================================================

const AUDITED_TABLES = [
  'FinancialOperation', 'PaymentRequest', 'BusinessPrice',
  'FiatLiquidityReceipt', 'FiatLiquidityReservation', 'FiatLiquidityState', 'FiatProviderEvent',
  'ModelBSettlement', 'InventoryLot', 'InventoryLotConsumption', 'ProviderSettlementAttempt', 'ReconciliationException',
  'LedgerAccount', 'LedgerTransaction', 'RestrictedObligation',
  'CustodyExecution', 'CustodyAccount', 'CustodyMovement', 'CustodyEvidence', 'ProofOfReservesLeaf',
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
  ['GlobalSettings', 'lastExternalSync'],
  ['GlobalSettings', 'lastAdminSetAt'],
  ['GlobalSettings', 'lastEchoAt'],
  ['SmartRouteRun', 'updatedAt'],
  ['JournalEntry', 'ledgerTransactionId'],
  ['JournalEntry', 'lineNumber'],
  ['LedgerAccount', 'code'],
  ['LedgerAccount', 'accountClass'],
  ['LedgerAccount', 'normalSide'],
  ['LedgerTransaction', 'idempotencyKey'],
  ['LedgerTransaction', 'entryType'],
  ['LedgerTransaction', 'postingHash'],
  ['LedgerTransaction', 'conversionIdentity'],
  ['RestrictedObligation', 'reference'],
  ['RestrictedObligation', 'amount'],
  ['RestrictedObligation', 'status'],
  ['RestrictedObligation', 'reserveInclusionPolicy'],
  ['CustodyExecution', 'idempotencyKey'],
  ['CustodyExecution', 'status'],
  ['CustodyExecution', 'lastRecoveryAttemptAt'],
  ['CustodyExecution', 'nextRecoveryAttemptAt'],
  ['CustodyExecution', 'recoveryAttemptCount'],
  ['CustodyAccount', 'tier'],
  ['CustodyAccount', 'status'],
  ['CustodyAccount', 'walletAddressId'],
  ['CustodyMovement', 'idempotencyKey'],
  ['CustodyMovement', 'kind'],
  ['CustodyMovement', 'status'],
  ['CustodyMovement', 'custodyExecutionId'],
  ['CustodyEvidence', 'custodyAccountId'],
  ['CustodyEvidence', 'scope'],
  ['CustodyEvidence', 'status'],
  ['CustodyEvidence', 'balanceBaseUnits'],
  ['ProofOfReservesLeaf', 'snapshotId'],
  ['ProofOfReservesLeaf', 'userId'],
  ['ProofOfReservesSnapshot', 'usdcLiabilityTotal'],
  ['ProofOfReservesSnapshot', 'evidenceLinkedLiabilityTotal'],
  ['ProofOfReservesSnapshot', 'unclassifiedExposure'],
  ['ProofOfReservesSnapshot', 'eligibleReserveTotal'],
  ['ProofOfReservesSnapshot', 'restrictedObligationsTotal'],
  ['ProofOfReservesSnapshot', 'restrictedObligationsAvailable'],
  ['ProofOfReservesSnapshot', 'liabilityAttestation'],
  ['ProofOfReservesSnapshot', 'evidenceStatus'],
  ['ProofOfReservesSnapshot', 'custodyAccountCount'],
  ['ProofOfReservesSnapshot', 'acceptedEvidenceCount'],
  ['ProofOfReservesSnapshot', 'missingEvidenceCount'],
  ['ProofOfReservesSnapshot', 'evidenceSummary'],
  ['ProofOfReservesSnapshot', 'assetIdentity'],
  ['ProofOfReservesSnapshot', 'liabilityBreakdown'],
];

const AUDITED_INDEXES = [
  'Withdrawal_transactionHistoryId_key',
  'ProviderSettlementAttempt_provider_providerReference_key',
  'ReconciliationException_entity_reason_open_key',
  'business_price_current_unique',
  'InventoryLot_acquisitionKey_key',
  'InventoryLotConsumption_consumptionKey_key',
  'InventoryLotConsumption_lotId_idx',
  'InventoryLot_eligible_status_idx',
  'JournalEntry_ledgerTransactionId_idx',
  'JournalEntry_account_ledgerTransactionId_idx',
  'LedgerAccount_code_key',
  'LedgerAccount_userId_idx',
  'LedgerAccount_accountClass_status_idx',
  'LedgerTransaction_idempotencyKey_key',
  'LedgerTransaction_relatedEntity_relatedEntityId_idx',
  'LedgerTransaction_userId_postedAt_idx',
  'LedgerTransaction_entryType_postedAt_idx',
  'LedgerTransaction_conversionIdentity_key',
  'RestrictedObligation_reference_key',
  'RestrictedObligation_sourceType_status_idx',
  'RestrictedObligation_userId_status_idx',
  'RestrictedObligation_status_asset_idx',
  'CustodyExecution_idempotencyKey_key',
  'CustodyExecution_txHash_key',
  'CustodyExecution_kind_refId_idx',
  'CustodyExecution_status_idx',
  'CustodyExecution_walletAddressId_idx',
  'CustodyExecution_status_nextRecoveryAttemptAt_idx',
  'CustodyExecution_userId_idx',
  'CustodyExecution_one_inflight_sweep_per_wallet_idx',
  'CustodyAccount_address_network_asset_contract_key',
  'CustodyAccount_walletAddressId_key',
  'CustodyAccount_tier_status_idx',
  'CustodyAccount_userId_idx',
  'CustodyMovement_idempotencyKey_key',
  'CustodyMovement_custodyExecutionId_key',
  'CustodyMovement_kind_status_idx',
  'CustodyMovement_sourceAccountId_idx',
  'CustodyMovement_destinationAccountId_idx',
  'CustodyMovement_txHash_idx',
  'CustodyMovement_status_createdAt_idx',
  'CustodyEvidence_account_active_key',
  'CustodyEvidence_account_tx_key',
  'CustodyEvidence_account_createdAt_idx',
  'CustodyEvidence_status_idx',
  'CustodyEvidence_scope_status_idx',
  'ProofOfReservesLeaf_snapshotId_userId_idx',
];

const AUDITED_CONSTRAINTS = [
  ['JournalEntry', 'JournalEntry_ledgerTransactionId_fkey'],
  ['ProofOfReservesLeaf', 'ProofOfReservesLeaf_snapshotId_fkey'],
  ['ProofOfReservesLeaf', 'ProofOfReservesLeaf_userId_fkey'],
  ['ProofOfReservesLeaf', 'ProofOfReservesLeaf_snapshotId_userId_key'],
];

const AUDITED_ENUM_VALUES = [
  ['LedgerAccountClass', 'ASSET'],
  ['LedgerAccountClass', 'LIABILITY'],
  ['LedgerAccountClass', 'RESTRICTED'],
  ['LedgerNormalSide', 'DEBIT'],
  ['LedgerNormalSide', 'CREDIT'],
  ['RestrictedObligationStatus', 'ACTIVE'],
  ['RestrictedObligationStatus', 'RELEASED'],
  ['RestrictedObligationStatus', 'CANCELLED'],
  ['ReserveInclusionPolicy', 'INCLUDED_IN_RESERVE_DENOMINATOR'],
  ['ReserveInclusionPolicy', 'EXCLUDED_FROM_RESERVE_DENOMINATOR'],
  ['JournalEntryType', 'ASSET_CONVERSION'],
  ['JournalEntryType', 'CUSTODY_DEPOSIT'],
  ['JournalEntryType', 'CUSTODY_SWEEP'],
  ['JournalEntryType', 'CUSTODY_WITHDRAWAL'],
  ['JournalEntryType', 'INVENTORY_ACQUISITION'],
  ['InventoryLotStatus', 'OPEN'],
  ['InventoryLotStatus', 'CONSUMED'],
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

// Content-preservation set: tables whose DATA must not change at all. Row-count
// equality alone is never accepted as proof — verify() also compares an
// order-stable md5 checksum over every row.
const CONTENT_TABLES = [
  ['conversation_money_ticket', 'ConversationMoneyTicket'],
  ['azm_reward_log', 'AzmRewardLog'],
  ['azm_spend_log', 'AzmSpendLog'],
];

const DEFI_SEED_NAMES = "('AAVE','COMPOUND','INTERNAL_LP')";

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

async function tableInfo(client, table) {
  const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${table}"') IS NULL`));
  if (absent) return { exists: false, rows: 0 };
  const rows = Number(await scalar(client, `SELECT count(*) FROM "${table}"`));
  return { exists: true, rows };
}

async function hasColumn(client, table, column) {
  const n = Number(await scalar(client,
    `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}'`));
  return n > 0;
}

async function checksum(client, table) {
  const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${table}"') IS NULL`));
  if (absent) return '-1';
  return String(await scalar(client,
    `SELECT md5(COALESCE(string_agg(CAST(t AS text), '|' ORDER BY t."id"), '')) FROM "${table}" t`));
}

// Content checksum over a reviewed, static predicate. An absent table is
// represented by -1; callers separately handle an expected table creation.
async function filteredChecksum(client, table, predicate) {
  const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${table}"') IS NULL`));
  if (absent) return '-1';
  return String(await scalar(client,
    `SELECT md5(COALESCE(string_agg(CAST(t AS text), '|' ORDER BY t."id"), '')) FROM "${table}" t WHERE ${predicate}`));
}

async function coreCounts(client) {
  const out = {};
  for (const [key, tbl] of CORE_TABLES) {
    const info = await tableInfo(client, tbl);
    out[key] = info.exists ? info.rows : -1;
  }
  return out;
}

async function contentBaselines(client) {
  const out = {};
  for (const [key, tbl] of CONTENT_TABLES) {
    const info = await tableInfo(client, tbl);
    out[`${key}_count`] = info.exists ? info.rows : -1;
    out[`${key}_checksum`] = await checksum(client, tbl);
  }
  return out;
}

async function defiInfo(client) {
  const info = await tableInfo(client, 'DeFiYieldStrategy');
  if (!info.exists) return { count: -1, seeds: 0, aaveCount: 0, compoundCount: 0, internalLpCount: 0 };
  const aaveCount = Number(await scalar(client,
    `SELECT count(*) FROM "DeFiYieldStrategy" WHERE "name" = 'AAVE'`));
  const compoundCount = Number(await scalar(client,
    `SELECT count(*) FROM "DeFiYieldStrategy" WHERE "name" = 'COMPOUND'`));
  const internalLpCount = Number(await scalar(client,
    `SELECT count(*) FROM "DeFiYieldStrategy" WHERE "name" = 'INTERNAL_LP'`));
  const seeds = Number(await scalar(client,
    `SELECT count(*) FROM "DeFiYieldStrategy" WHERE "name" IN ${DEFI_SEED_NAMES}`));
  return { count: info.rows, seeds, aaveCount, compoundCount, internalLpCount };
}

async function fiatInfo(client) {
  const info = await tableInfo(client, 'FiatLiquidityState');
  if (!info.exists) return { count: -1, zeroValued: 0 };
  const zeroValued = Number(await scalar(client,
    `SELECT count(*) FROM "FiatLiquidityState" WHERE "availableGhs" = 0 AND "reservedGhs" = 0 AND "inTransitGhs" = 0 AND "paidOutGhs" = 0 AND "reconciliationHeldGhs" = 0`));
  return { count: info.rows, zeroValued };
}

// ---------------------------------------------------------------------------
// Side-effect gate: legacy E2EE private-key tables dropped by
// install-e2ee-server-blind-overlay.js. Counts and column presence only —
// key values are never read.
async function e2eeGate(client) {
  let refused = false;
  for (const t of ['E2EESession', 'E2EEPreKeyBundle']) {
    const info = await tableInfo(client, t);
    if (!info.exists) { console.log(`e2ee legacy table ${t}: absent (nothing to retire).`); continue; }
    if (info.rows > 0) {
      console.error(`::error::preflight REFUSED: legacy E2EE table ${t} is populated (${info.rows} rows). The e2ee installer drops it unconditionally; populated private-key data must be reviewed before retirement. No key values were read.`);
      refused = true;
    } else {
      console.log(`e2ee legacy table ${t}: exists, 0 rows (follows the reviewed retirement path).`);
    }
  }
  const otpk = await tableInfo(client, 'E2EEOneTimePreKey');
  if (otpk.exists) {
    const legacyShape = await hasColumn(client, 'E2EEOneTimePreKey', 'privateKey');
    if (legacyShape) {
      if (otpk.rows > 0) {
        console.error(`::error::preflight REFUSED: E2EEOneTimePreKey has the LEGACY shape (privateKey column) and is populated (${otpk.rows} rows). The e2ee installer drops the legacy shape; live claimed keys must be reviewed first. No key values were read.`);
        refused = true;
      } else {
        console.log('E2EEOneTimePreKey: legacy shape, 0 rows (dropped and recreated by the reviewed path).');
      }
    } else {
      console.log(`E2EEOneTimePreKey: current shape, ${otpk.rows} rows (not dropped; created if absent).`);
    }
  } else {
    console.log('E2EEOneTimePreKey: absent (created by the sequence).');
  }
  const dev = await tableInfo(client, 'E2EEDevice');
  console.log(`E2EEDevice: ${dev.exists ? `exists, ${dev.rows} rows (never dropped)` : 'absent (created by the sequence)'}.`);
  return !refused;
}

// ---------------------------------------------------------------------------
// Side-effect gate: ConversationMoneyTicket orphan archival + deletion inside
// install-business-os-overlay.js. Each FK is added only when absent, and the
// archive+delete runs only when candidates exist — a general convergence run
// must not silently perform financial-record archival.
async function orphanGate(client) {
  const reasons = [
    ['missing_message', 'ConversationMoneyTicket_messageId_fkey', 'Message', 'messageId'],
    ['missing_conversation', 'ConversationMoneyTicket_conversationId_fkey', 'Conversation', 'conversationId'],
    ['missing_requester', 'ConversationMoneyTicket_requesterId_fkey', 'User', 'requesterId'],
    ['missing_counterparty', 'ConversationMoneyTicket_counterpartyId_fkey', 'User', 'counterpartyId'],
  ];
  let total = 0;
  for (const [reason, constraint, refTable, col] of reasons) {
    const fkPresent = Number(await scalar(client,
      `SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_name='${constraint}'`)) > 0;
    if (fkPresent) { console.log(`orphan check ${reason}: FK already present (archival path for this relationship is inert).`); continue; }
    const tickets = await tableInfo(client, 'ConversationMoneyTicket');
    if (!tickets.exists) { console.log(`orphan check ${reason}: ConversationMoneyTicket absent.`); continue; }
    const n = Number(await scalar(client,
      `SELECT count(*) FROM "ConversationMoneyTicket" t LEFT JOIN "${refTable}" r ON r."id" = t."${col}" WHERE r."id" IS NULL`));
    if (n > 0) {
      console.error(`::error::preflight REFUSED: ${n} ConversationMoneyTicket rows would be archived+deleted by install-business-os (${reason}). Orphan financial records require a separately reviewed archival/reconciliation step before schema convergence.`);
      total += n;
    } else {
      console.log(`orphan check ${reason}: 0 candidates.`);
    }
  }
  return total === 0;
}

// ---------------------------------------------------------------------------
// Side-effect gate: dedupKey backfills in install-prod-drift-remediation.js.
// affected = rows the installer would actually UPDATE (dedupKey IS NULL,
// legacy metadata carries dedupKey, first row per (userId, source, dedupKey)).
async function backfillGate(client) {
  let refused = false;
  for (const t of ['AzmRewardLog', 'AzmSpendLog']) {
    const info = await tableInfo(client, t);
    if (!info.exists) { console.log(`backfill check ${t}: table absent.`); continue; }
    const pending = Number(await scalar(client,
      `SELECT count(*) FROM "${t}" WHERE "dedupKey" IS NULL AND metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL`));
    const affected = Number(await scalar(client,
      `SELECT count(*) FROM (
         SELECT id, "dedupKey",
                row_number() OVER (
                  PARTITION BY "userId", "source", metadata->>'dedupKey'
                  ORDER BY "createdAt", id
                ) AS rn
         FROM "${t}"
         WHERE metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL
       ) ranked WHERE rn = 1 AND "dedupKey" IS NULL`));
    if (affected > 0) {
      console.error(`::error::preflight REFUSED: install-prod-drift would backfill dedupKey on ${affected} existing ${t} row(s) (${pending} pending total). Existing-row backfills require explicit review; the schema-only convergence must not run them implicitly.`);
      refused = true;
    } else {
      console.log(`backfill check ${t}: 0 rows affected (${pending} pending).`);
    }
  }
  return !refused;
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

      // ---- side-effect gates (fail closed before anything is applied) ----
      const e2eeOk = await e2eeGate(client);
      const orphanOk = await orphanGate(client);
      const backfillOk = await backfillGate(client);
      if (!e2eeOk || !orphanOk || !backfillOk) {
        console.error('::error::preflight failed closed on a side-effect gate: review the reported effect(s) before authorizing convergence.');
        process.exitCode = 1;
        return;
      }

      // ---- expected-initialization state (documented, allowed) ----
      const defi = await defiInfo(client);
      console.log(`expected initialization DeFiYieldStrategy: ${defi.count < 0 ? 'table absent' : `${defi.count} rows (${defi.seeds} of the seeded names)`} — the sequence seeds AAVE/COMPOUND/INTERNAL_LP additively where absent.`);
      const fiat = await fiatInfo(client);
      console.log(`expected initialization FiatLiquidityState: ${fiat.count < 0 ? 'table absent' : `${fiat.count} row(s), ${fiat.zeroValued} zero-valued`} — the sequence inserts the zero-valued singleton once (ON CONFLICT DO NOTHING).`);

      for (const t of AUDITED_TABLES) {
        const absent = isAbsent(await scalar(client, `SELECT to_regclass('"${t}"') IS NULL`));
        console.log(`audited additive target ${t}: ${absent ? 'absent (will be created)' : 'already present (idempotent replay)'}`);
      }
      return;
    }

    if (mode === 'counts') {
      const defi = await defiInfo(client);
      const fiat = await fiatInfo(client);
      const out = {
        ...await coreCounts(client),
        ...await contentBaselines(client),
        defi_yield_strategy_count: defi.count,
        defi_yield_strategy_seed_count: defi.seeds,
        defi_yield_strategy_aave_count: defi.aaveCount,
        defi_yield_strategy_aave_checksum: await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'AAVE'`),
        defi_yield_strategy_compound_count: defi.compoundCount,
        defi_yield_strategy_compound_checksum: await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'COMPOUND'`),
        defi_yield_strategy_internal_lp_count: defi.internalLpCount,
        defi_yield_strategy_internal_lp_checksum: await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'INTERNAL_LP'`),
        defi_yield_strategy_nonseed_checksum: await filteredChecksum(client, 'DeFiYieldStrategy', `"name" NOT IN ('AAVE','COMPOUND','INTERNAL_LP')`),
        fiat_liquidity_state_count: fiat.count,
        fiat_liquidity_state_checksum: await checksum(client, 'FiatLiquidityState'),
      };
      for (const [key, val] of Object.entries(out)) {
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
      for (const [table, constraint] of AUDITED_CONSTRAINTS) {
        const n = Number(await scalar(client,
          `SELECT count(*) FROM pg_constraint WHERE conname='${constraint}' AND conrelid = '"${table}"'::regclass`));
        if (n === 0) { console.error(`::error::verify failed: audited constraint ${table}.${constraint} missing after apply.`); failed++; }
        else console.log(`constraint ${table}.${constraint}: present`);
      }
      for (const [typeName, value] of AUDITED_ENUM_VALUES) {
        const n = Number(await scalar(client,
          `SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' AND t.typname='${typeName}' AND e.enumlabel='${value}'`));
        if (n === 0) { console.error(`::error::verify failed: audited enum value ${typeName}.${value} missing after apply.`); failed++; }
        else console.log(`enum value ${typeName}.${value}: present`);
      }
      const ikAbsent = isAbsent(await scalar(client, 'SELECT to_regclass(\'"IdempotencyKey"\') IS NULL'));
      if (!ikAbsent) {
        const ikRows = Number(await scalar(client, 'SELECT count(*) FROM "IdempotencyKey"'));
        if (ikRows !== 0) { console.error(`::error::verify failed: IdempotencyKey still exists and is not empty (${ikRows} rows).`); failed++; }
        else console.log('IdempotencyKey: present, 0 rows.');
      } else {
        console.log('IdempotencyKey: absent (retired cleanly by the r42 installer).');
      }

      // baseline preservation: core tables
      const after = await coreCounts(client);
      for (const [key, val] of Object.entries(after)) {
        const rawBefore = process.env[key.toUpperCase()];
        if (rawBefore == null || rawBefore === '' || Number.isNaN(Number(rawBefore))) {
          console.error(`::error::verify failed: baseline missing or invalid for ${key}; refusing to claim preservation.`);
          failed++;
          continue;
        }
        const before = Number(rawBefore);
        if (val !== before) {
          console.error(`::error::verify failed: ${key} changed ${before} -> ${val}; core table state must remain unchanged.`);
          failed++;
        } else {
          console.log(`${key}: ${val === -1 ? 'table remained absent' : `${val} (unchanged)`}`);
        }
      }

      // content preservation: count AND order-stable checksum per table —
      // row-count equality alone is never accepted as proof.
      const contentAfter = await contentBaselines(client);
      for (const [key, val] of Object.entries(contentAfter)) {
        const rawBefore = process.env[key.toUpperCase()];
        if (rawBefore == null || rawBefore === '') {
          console.error(`::error::verify failed: baseline missing for ${key}; refusing to claim content preservation.`);
          failed++;
          continue;
        }
        const before = String(rawBefore);
        if (String(val) !== before) {
          console.error(`::error::verify failed: ${key} changed (${before} -> ${String(val)}) — content must be byte-identical after the guarded path.`);
          failed++;
        } else {
          console.log(`${key}: unchanged${key.endsWith('checksum') ? ' (checksum match)' : ''}`);
        }
      }


      // expected-initialization rules: DeFiYieldStrategy + FiatLiquidityState.
      const defi = await defiInfo(client);
      const defiBeforeRaw = process.env.DEFI_YIELD_STRATEGY_COUNT;
      const defiSeedBeforeRaw = process.env.DEFI_YIELD_STRATEGY_SEED_COUNT;
      if (defiBeforeRaw == null || defiBeforeRaw === '' || defiSeedBeforeRaw == null || defiSeedBeforeRaw === '' ||
          Number.isNaN(Number(defiBeforeRaw)) || Number.isNaN(Number(defiSeedBeforeRaw))) {
        console.error('::error::verify failed: DeFiYieldStrategy baseline missing or invalid.'); failed++;
      } else {
        // A -1 baseline means the whole table was absent before this approved
        // initializer. Treat it as zero pre-existing rows, permitting only
        // the documented AAVE/COMPOUND/INTERNAL_LP inserts and no non-seed records.
        const defiBefore = Math.max(0, Number(defiBeforeRaw));
        const defiSeedBefore = Math.max(0, Number(defiSeedBeforeRaw));
        if (defi.count < 0 || defi.count < defiBefore) {
          console.error(`::error::verify failed: DeFiYieldStrategy disappeared or lost rows (${defiBeforeRaw} -> ${defi.count}).`); failed++;
        } else if ((defi.count - defiBefore) !== (defi.seeds - defiSeedBefore)) {
          console.error(`::error::verify failed: DeFiYieldStrategy changed beyond expected AAVE/COMPOUND/INTERNAL_LP initialization (${defiBeforeRaw}/${defiSeedBeforeRaw} seeds -> ${defi.count}/${defi.seeds}).`); failed++;
        } else if ((defi.count - defi.seeds) !== (defiBefore - defiSeedBefore)) {
          console.error('::error::verify failed: DeFiYieldStrategy non-seed row count changed.'); failed++;
        } else {
          const baselineWasAbsent = Number(defiBeforeRaw) < 0;
          const nonseedBefore = process.env.DEFI_YIELD_STRATEGY_NONSEED_CHECKSUM;
          const nonseedAfter = await filteredChecksum(client, 'DeFiYieldStrategy', `"name" NOT IN ('AAVE','COMPOUND','INTERNAL_LP')`);
          if (!baselineWasAbsent && (nonseedBefore == null || nonseedBefore === '' || nonseedBefore !== nonseedAfter)) {
            console.error('::error::verify failed: pre-existing non-seed DeFiYieldStrategy content changed or its baseline is missing.'); failed++;
          } else if (baselineWasAbsent && (defi.count - defi.seeds) !== 0) {
            console.error('::error::verify failed: newly created DeFiYieldStrategy table contains unexpected non-seed records.'); failed++;
          }
          for (const [name, currentCount, currentChecksum, countKey, checksumKey] of [
            ['AAVE', defi.aaveCount, await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'AAVE'`), 'DEFI_YIELD_STRATEGY_AAVE_COUNT', 'DEFI_YIELD_STRATEGY_AAVE_CHECKSUM'],
            ['COMPOUND', defi.compoundCount, await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'COMPOUND'`), 'DEFI_YIELD_STRATEGY_COMPOUND_COUNT', 'DEFI_YIELD_STRATEGY_COMPOUND_CHECKSUM'],
            ['INTERNAL_LP', defi.internalLpCount, await filteredChecksum(client, 'DeFiYieldStrategy', `"name" = 'INTERNAL_LP'`), 'DEFI_YIELD_STRATEGY_INTERNAL_LP_COUNT', 'DEFI_YIELD_STRATEGY_INTERNAL_LP_CHECKSUM'],
          ]) {
            const rawCount = process.env[countKey];
            const rawChecksum = process.env[checksumKey];
            if (rawCount == null || rawCount === '' || Number.isNaN(Number(rawCount)) || rawChecksum == null || rawChecksum === '') {
              console.error(`::error::verify failed: pre-initialization baseline missing for DeFiYieldStrategy ${name}.`); failed++;
            } else if (Number(rawCount) > 0) {
              if (currentCount !== Number(rawCount) || currentChecksum !== rawChecksum) {
                console.error(`::error::verify failed: pre-existing DeFiYieldStrategy ${name} records changed.`); failed++;
              }
            } else if (currentCount !== 1) {
              console.error(`::error::verify failed: expected exactly one new DeFiYieldStrategy ${name} seed, found ${currentCount}.`); failed++;
            }
          }
          if (failed === 0) {
            console.log(`DeFiYieldStrategy: ${defi.count} rows (${defi.seeds} AAVE/COMPOUND/INTERNAL_LP seeds); existing records preserved and only documented seed initialization permitted.`);
          }
        }
      }

      const fiat = await fiatInfo(client);
      const fiatBeforeRaw = process.env.FIAT_LIQUIDITY_STATE_COUNT;
      const fiatChecksumBefore = process.env.FIAT_LIQUIDITY_STATE_CHECKSUM;
      if (fiatBeforeRaw == null || fiatBeforeRaw === '' || Number.isNaN(Number(fiatBeforeRaw))) {
        console.error('::error::verify failed: FiatLiquidityState baseline missing or invalid.'); failed++;
      } else {
        const fiatBefore = Number(fiatBeforeRaw);
        if (fiatBefore <= 0) {
          // -1 means table absent; 0 means present-but-empty. Both may be
          // initialized by the approved zero-valued singleton insert.
          if (fiat.count === 1 && fiat.zeroValued === 1) {
            console.log('FiatLiquidityState: initialized to the documented zero-valued singleton.');
          } else {
            console.error(`::error::verify failed: FiatLiquidityState expected exactly one zero-valued row after initialization, found count=${fiat.count}, zeroValued=${fiat.zeroValued}.`); failed++;
          }
        } else if (fiat.count !== fiatBefore) {
          console.error(`::error::verify failed: FiatLiquidityState count changed (${fiatBefore} -> ${fiat.count}).`); failed++;
        } else if (fiatChecksumBefore == null || fiatChecksumBefore === '' ||
                   await checksum(client, 'FiatLiquidityState') !== fiatChecksumBefore) {
          console.error('::error::verify failed: pre-existing FiatLiquidityState content changed or its baseline is missing.'); failed++;
        } else {
          console.log(`FiatLiquidityState: ${fiat.count} row(s), content checksum unchanged.`);
        }
      }

      if (failed > 0) { console.error(`::error::verification failed with ${failed} error(s).`); process.exitCode = 1; return; }
      console.log('verification complete: all audited targets converged, core rows and content intact, expected initializations only.');
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
