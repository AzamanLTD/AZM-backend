# r40.1 — E2EE Server-Blind Hardening & Exact-Money Decision Record

**Scope:** second-pass audit of the r40 changes (E2EE server-blind architecture
+ exact restock fingerprints), every P0/P1 finding dispositioned, and the
float decision that governs restock economics.

## 1. The float decision (P1-J) — DECIDED

**Decision:** *Binary floats are forbidden as an economic type. The only
permitted float in the restock path is the LEGACY catalog projection
(`InventoryItem.costPerUnit Float`), and it is interpreted — never computed in —
via its shortest round-trip string before any arithmetic.*

The rules, in order of authority:

1. **All economics are computed in exact decimals** (Prisma.Decimal /
   decimal.js). Products, totals, ledger postings — never `parseFloat`,
   never JS number arithmetic on money.
2. **The ledger is the numeric authority**: `BusinessLedgerEntry.amountGhs` is
   `Decimal(20,8)`; anything below `GHS 0.00000001` that is non-zero is
   **rejected** (`RESTOCK_TOTAL_UNREPRESENTABLE`), never silently rounded to a
   zero posting (§r34 posting-unit contract).
3. **The legacy Float catalog column is read-only evidence**: the restock
   service converts it through `parseExactDecimal(..., { strictString: false })`,
   i.e. `String(item.costPerUnit)` — the shortest round-trip representation of
   the stored double — and does all subsequent math in Decimal. It is the ONE
   place a binary float is tolerated, because the column pre-dates the exact
   regime and a value stored as a double has no additional precision to
   recover: its shortest round-trip string is lossless *for that stored
   value*. New columns/tables must use `Decimal`.
4. **Fingerprints digest exact decimal STRINGS** (v2): `qty.toString()` /
   `suppliedCost.toString()` — never `Number(...)`. The v1 float-normalized
   digest collided distinct purchases ("1.10" vs "1.1", or any difference
   beyond double precision) and would silently return the first operation's
   result on "replay". `fingerprintVersion` on every committed row is what
   makes the migration non-breaking: v1 rows replay against the v1 digest they
   were committed under, v2 against v2, and no pre-r40 operation can strand
   behind a 409.
5. **The wire contract is a strict decimal string** (`/^-?\d+(?:\.\d+)?$/`,
   `strictString: true`): JSON numbers are accepted only through
   `String(value)` shortest round-trip for legacy clients; the business portal
   (P1-I fix) now sends the operator's raw input string so the typed decimal
   reaches the fingerprint intact.
6. **Catalog migration is deliberately NOT done in r40.1**: rewriting
   `InventoryItem.costPerUnit` Float → Decimal is a data migration over live
   catalogs; it is deferred to a dedicated release. Until then the
   interpretation rule in §3 is the documented interface, enforced in
   `parseExactDecimal` and verified by
   `__tests__/r40-restock-fingerprint-v2.pg.test.js`.

**Why not "round everything to 2dp"?** GHS is quoted to 2dp at retail, but
supplier costs and unit economics routinely carry 3–8dp (per-gram, per-ml).
Rounding at ingest destroys exactly the small-magnitude economics the
posting-unit contract exists to protect. Exact Decimal with an 8dp ledger and
explicit (recorded) rounding at the posting boundary is the only configuration
where no economic event can vanish.

## 2. r40 E2EE audit findings — dispositions

| Finding | Fix |
|---|---|
| P0-A E2EE must be disabled by default | 503 unless `AZM_E2EE_ENABLED=true`; exact-string gate, audited in CI (P1-L) |
| P0-B registration signature covers key attribution | Proof: header/key tampering rejected |
| P0-C one ACTIVE device per user | Unique partial index + retire-and-rebind transactional rotation; race-proof (convergence proof) |
| P1-D one-time prekey immutability | keyId unique per (userId), claims are atomic `SKIP LOCKED`, never upserted |
| P1-E E2EE is pairwise-only | Non-PERSONAL conversations rejected (`E2EE_NOT_PAIRWISE`) |
| P1-F envelope sender must be caller's active device | Ownership + active-state proof (403) |
| P1-G all failure paths fail closed | Failure-injection proof suite |
| P1-H prekey bundle freshness bound | Cache-bound proof |
| P1-I portal restock destroyed exact strings | Raw string on wire + per-purchase idempotency key (r40.1) |
| P1-J float usage undocumented | This record (§1) |
| P1-L CI never audited the invariants | `infra/audit-e2ee-invariants.js` CI step |

**Proof authority:** `__tests__/e2ee-protocol.test.js` (20/20) and
`__tests__/e2ee-authority.pg.test.js` (11/11, real PostgreSQL) — both green.
