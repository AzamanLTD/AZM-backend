# Language-Neutral Boundaries — Architecture Note

**Status:** architecture note only. No production Go implementation is to start
until the core financial hardening and operational foundation are stronger.
This note records where a second language may enter the system, and — more
importantly — where it must never enter.

Related analysis: `docs/audit/r42.1-idempotency-closure.md` §7 (Go boundary
analysis for the idempotency layer) and `docs/audit/r42-shared-idempotency-authority.md`.

## Principle

AZAMAN's financial truth lives in exactly one place: the PostgreSQL-backed
Node.js authority layer (balances, ledger, `FinancialOperation` identity,
escrow, withdrawals/deposits, Smart Route). Introducing Go must never create a
second financial authority or a distributed transaction model. Any Go
component must be a *pure worker* that:

1. reads committed state;
2. performs non-authoritative computation (polling, reconciliation math,
   scoring, transformation);
3. writes results back **through the existing Node.js authority endpoints**,
   which own identity, validation, and economic transactions.

Go owns work. Node owns money. There is no shared write path to a financial
table from Go, ever.

## First likely Go target

**Reconciliation / provider-worker / high-volume asynchronous processing.**
These are stateless-with-resume, embarrassingly parallel, read-mostly workloads
where Go's concurrency and deployment profile help, and where a crash can
always be recovered by rerunning against committed database state.

### Potential future candidates

- provider polling / adapters (Moolre, susu, and future payment providers);
- reconciliation jobs (comparing external provider statements against
  committed ledger state);
- risk / scoring pipelines;
- event processing (fan-out of committed events into read models/notifications);
- heavy background jobs (reporting, archival, media processing).

## Do NOT move into Go

- ledger authority;
- balances;
- `FinancialOperation` (canonical operation identity);
- core withdrawal / deposit financial authority;
- escrow financial authority;
- Smart Route financial authority.

These stay in the Node.js authority layer permanently.

## Boundary contract for any Go worker

A Go worker is admissible only if it satisfies all of the following:

- **No direct economic writes.** It never writes to financial tables
  (`User` balances, ledger entries, escrow, `TransactionHistory`,
  `FinancialOperation`). It acts on the database only through the Node.js
  API surface, or writes to its own scratch/reporting tables.
- **Idempotent, resumable units.** Every unit of work is keyed and resumable
  against committed state; a killed worker restarts and re-reads without
  double effects. Operation identity remains exclusively the
  `FinancialOperation` / `commitOperation()` authority in Node.js.
- **No second operation registry.** If a Go job needs identity, it mints a
  job-scoped ID and references the canonical Node.js operation ID; it never
  creates an alternative identity space.
- **Fail-closed handoff.** Where a Go computation feeds an economic decision,
  the final economic authorization boundary remains a Node.js transaction
  that independently validates authorization, bans, suspensions, and
  freshness — never trusting a Go-side verdict.
- **Observable.** Correlation IDs cross the language boundary on every call;
  worker runs emit durable progress rows so stuck work is detectable and
  reconcilable (see the recovery requirements in the hardening order:
  stuck-operation detection, worker crash/restart).

## Sequencing

Go enters only after: the R42.1 tranches are integrated (#317 + #318), and the
hardening order (oracle/rate authority, vault entitlement, Smart Route
fail-closed authorization, admin portal races, cross-client durable recovery,
production readiness) has landed on exact evidence. The first Go worker should
be carved from the cleanest measured boundary — reconciliation — behind a
documented contract test proving that killing the worker at any point yields a
convergent, non-duplicated state after restart.
