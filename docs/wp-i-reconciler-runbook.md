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
| `WITNESS_ACCOUNT_MISMATCH` | the provider settled a different wallet than the opening's; the answer is not evidence about this opening |

A transport failure is **not** retried with a different reference. Re-run the same opening when
the provider is reachable; the response is refetched and re-digested.

## 6. Adversarial matrix

Every row is a case this boundary must survive. "Proven by" names the suite and case that
fails if the property is removed; **no row is claimed on inspection alone**.

| # | Case | Proven by | Verdict |
|---|------|-----------|---------|
| 1 | Transport timeout | `wp-i-provider-settlement-reconciler` — a provider call that times out never becomes a witness | refused, no witness, opening untouched |
| 2 | Transport HTTP failure | same — a provider HTTP failure never becomes a witness | refused |
| 3 | Non-JSON / non-object body | `wp-i-moolre-status-adapter` — non-200, non-JSON and non-object bodies never reach settlement | refused |
| 4 | 200 envelope with failed wrapper | adapter — a 200 with a failed wrapper status is not transport success | refused |
| 5 | Pending state | adapter (nested pending); reconciler — a non-final provider state never becomes a witness | refused |
| 6 | Failed state | adapter — failed transaction status is not settled | refused |
| 7 | Unknown / missing status | adapter — missing txstatus is UNKNOWN, never settled | refused |
| 8 | String vs numeric status, unknown enum | adapter — numeric and string numerics map identically; unknown values are UNKNOWN | refused |
| 9 | Wrong wallet in the answer | reconciler — a provider answer for a DIFFERENT wallet cannot vouch for this opening (`WITNESS_ACCOUNT_MISMATCH`) | refused |
| 10 | Wrong reference in the answer | reconciler — a provider answer naming a DIFFERENT reference cannot vouch for this opening (`WITNESS_REFERENCE_MISMATCH`) | refused |
| 11 | Off-by-one pesewa | `wp-i-provider-trust-boundary` 12 — an off-by-one-pesewa settlement is refused | refused |
| 12 | Gross credited instead of net | trust-boundary 21 / 21b — only net may be credited; a payload with no net value is refused | refused |
| 13 | Unmapped wallet account | trust-boundary 13a; reconciler — an account absent from the currency mapping is refused, never defaulted to GHS | refused |
| 14 | Currency inferred instead of mapped | trust-boundary 13 / 13b — currency is the mapped one, not a constant | refused |
| 15 | Untrusted funding provider | trust-boundary 13c — an untrusted funding provider cannot witness treasury money | refused |
| 16 | Future-dated fetch | trust-boundary 13d — a witness cannot be dated in the future | refused |
| 17 | Fetch predating the opening | trust-boundary 13e — a fetch that predates the opening cannot evidence it | refused |
| 18 | Reference with no pre-existing opening | trust-boundary 24; reconciler — an opening key that does not exist is refused and nothing is fetched | refused |
| 19 | Reference fabricated inside evidence JSON | reconciler — a reference that exists only inside evidence JSON cannot drive a lookup | refused |
| 20 | Same observation, second opening | trust-boundary 26; reconciler — one provider observation cannot witness a second opening | refused (DB unique) |
| 21 | Digest tampering after the fact | trust-boundary 25; reconciler 25 — retained bytes no longer hash to the digest | refused at promotion |
| 22 | Callback replay | `wp-i-callback-authentication` 7 — replaying an identical callback produces exactly ONE economic effect | single effect |
| 23 | Concurrent promotion | `wp-i-treasury-promotion-race` — five concurrent confirmations credit the pool exactly once | single credit |
| 24 | Runtime DB identity writes a witness | `wp-i-witness-db-provenance`; `wp-i-witness-installer-real` — runtime cannot append | denied by PostgreSQL |
| 25 | Runtime rewrites / deletes / truncates | `wp-i-witness-installer-real` — runtime cannot rewrite or remove a witness | denied |
| 26 | Reconciler rewrites / deletes / truncates | installer-real — can append, cannot rewrite | denied |
| 27 | Reconciler promotes a receipt or moves the aggregate | installer-real — cannot promote liquidity or touch the aggregate | denied |
| 28 | One identity assumes the other | installer-real — neither role can become the other; inherited authority is refused | denied |
| 29 | Identifier injection into the installer | installer-real — a role name that is not a plain identifier is refused before any grant | refused |
| 30 | Runtime process holding full DB rights | `wp-i-witness-db-provenance` — the runtime process cannot write a witness even holding full DB rights | refused in process, and by PostgreSQL |
| 31 | Reconciler started without its own credentials | `wp-i-deployment-provisioning` — each variable is refused independently; a mode that is present but not 1 does not open the writer guard | refused, exit 1 |
| 32 | Reconciler started with no usage argument | provisioning — refused before any credential is read | refused, exit 1 |

Rows 1-23 are the boundary; 24-30 are database-role attacks; 31-32 are operator-surface failures.
Two of these were **real defects found by writing the row**, not by inspection: the entrypoint
could never start (row 31) and the release chain had no table to backfill from.

## 7. What is still unproven

- **No live Moolre wallet has been queried.** Every fixture comes from published documentation.
  Treasury funding stays NOT READY.
- **Two reconciler processes racing on the same observation** is protected by DB uniqueness but
  has not been executed as two concurrent processes; only sequential re-use is tested.
- **Provider reversal / chargeback after a witness exists** has no adapter and no test.
- **Fee allocation per pricing band** is unanswered, so `value < amount` is expected but its size
  is unconfirmed.
- Promotion of a receipt to `AVAILABLE` is unchanged by this service and remains gated by the
  existing treasury path plus whatever owner confirmation the platform requires.

## 8. Scope of this adapter, stated precisely

Operational today: **Moolre collection funding, status API `type=1`**, one wallet per reconciler
credential, GHS only, witness per opening.

**Not operational, and not claimed:** bank virtual-account credits (needs `type=2` keyed on the
account-creation reference plus accountnumber), Payment ID funding (the backend defines
`createPaymentId` with zero call sites), and wallet-statement reconciliation for unsolicited
credits (`/open/account/status`, which needs the private key and is the only witness for money
nobody initiated). Each needs its own documented adapter, fixtures and matrix rows before any of
them is described as working. MTN has no witness path at all.
