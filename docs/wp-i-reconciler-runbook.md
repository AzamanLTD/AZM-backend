# WP-I reconciliation service — deployment runbook

The reconciliation service is the only component permitted to write a provider settlement
witness. It runs as its **own** process with its **own** database login and its **own** provider
credentials. It must never be started as a side effect of the API deployment.

Status: **not activated**. Treasury funding remains NOT READY until a live Moolre wallet is
verified against these fixtures.

## 1. What it does

For one treasury opening (identified by its `dedupKey`), it:

1. reads the opening from PostgreSQL — reference, amount, wallet account and status;
2. asks Moolre for that payment's status over HTTPS with a bounded timeout;
3. parses the response through the documented adapter (`data.txstatus`, not `status`);
4. refuses unless the transaction is settled, the account matches, and the net value equals the
   opening amount in exact pesewas;
5. appends an immutable witness row: raw bytes, digest, retrieval timestamp, adapter rule.

It never accepts an amount or a reference from a caller, and it never writes liquidity state.

## 2. Environment (names only — values are the owner's)

| Variable | Purpose |
|---|---|
| `AZM_RECONCILER_MODE=1` | enables the writer guard inside the service |
| `AZM_RECONCILER_PROVIDER_USER` | Moolre `X-API-USER` for the wallet's API Service |
| `AZM_RECONCILER_PROVIDER_PUBKEY` | Moolre `X-API-PUBKEY` (the **public** key) for type-1 status |
| `WITNESS_DATABASE_URL` | reconciler database login, distinct from the API's |
| `WITNESS_ACCOUNT_CURRENCY_MAP` | JSON `{ "<moolre account number>": "GHS" }` |
| `AZM_RECONCILER_ACCOUNT_NUMBER` | optional pin; if set and it differs from the opening's wallet, the run is refused with `RECONCILER_WALLET_MISMATCH` |
| `AZM_RECONCILER_TIMEOUT_MS` | provider timeout, default 10000 |

Per Moolre's wallet-specific credentials, an API Service belongs to one wallet. Serve several
wallets with one service per wallet, each with its own credentials.

## 3. Database preparation (in this order)

1. **Schema** — apply the migration tree and the release overlays:
   `prisma migrate deploy` (or `npm run release` in an environment that uses overlays).
   This creates `ProviderSettlementWitness` and adds `FiatLiquidityReceipt.walletAccount`.
2. **Roles** — create two logins: the API runtime role and the reconciler role. They must be
   different roles and neither may be the table owner.
3. **Grants** — run the provenance installer as an owner/superuser:
   ```
   AZM_WITNESS_RUNTIME_ROLE=<api role> \
   AZM_WITNESS_RECONCILER_ROLE=<reconciler role> \
   node infra/wp-i/install-witness-provenance.js
   ```
   It is idempotent and verifies what it granted. Expected effective privileges:

   | | witness table | `FiatLiquidityReceipt` |
   |---|---|---|
   | runtime | `SELECT` | existing application grants |
   | reconciler | `SELECT`, `INSERT` | `SELECT` only |

   Neither role may `UPDATE`, `DELETE`, `TRUNCATE`, alter, or assume the other.
4. **Openings** — every opening that will be reconciled needs `walletAccount` set. Openings
   already witnessed are backfilled by the overlay from witness evidence. Anything still null is
   refused with `OPENING_HAS_NO_WALLET_ACCOUNT` — deliberately, because guessing the wallet is the
   defect this column removes.

## 4. Render service shape

- **Type:** background worker / one-off job, not a web service.
- **Start command:** `node workers/run-provider-settlement-reconciler.js`
- **Replicas:** 1. Concurrency is settled by the database, but there is no reason to run two.
- **Auto-deploy:** off. Deploy deliberately, after the API's schema is applied.
- **Health:** the process exits non-zero when it refuses; there is no long-running daemon.

## 5. Operating it

Invoke with one or more opening keys:

```
node workers/run-provider-settlement-reconciler.js --opening <dedupKey> [--opening <dedupKey>]
```

Each opening reports `witnessed` or a stable refusal reason. Refusal reasons worth alerting on:

| Reason | Meaning |
|---|---|
| `OPENING_NOT_FOUND` | the key is not a treasury opening |
| `OPENING_NOT_ELIGIBLE_<status>` | already available, reversed or terminally rejected |
| `OPENING_HAS_NO_PROVIDER_REFERENCE` | nothing to ask the provider about |
| `OPENING_HAS_NO_WALLET_ACCOUNT` | opening has no stored wallet; set it before reconciling |
| `RECONCILER_WALLET_MISMATCH` | pinned wallet differs from the opening's |
| `PROVIDER_NOT_SETTLED_*` | pending, failed, unknown or malformed provider state |
| `PROVIDER_TRANSPORT_*` | timeout, HTTP error, non-JSON |
| `WITNESS_OBSERVATION_ALREADY_USED` | that payment already funds another opening |

A transport failure is **not** retried with a different reference. Re-run the same opening when
the provider is reachable; the response is refetched and re-digested.

## 6. What is still unproven

- No live Moolre wallet has been queried. Every fixture comes from the published documentation.
- Fee allocation per pricing band is unanswered, so `value < amount` is expected but its size is
  not confirmed.
- Promotion of a receipt to `AVAILABLE` is unchanged by this service and remains gated by the
  existing treasury path plus whatever owner confirmation the platform requires.
