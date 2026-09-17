# Redis Operating Modes — Contract

Status: **ACTIVE** — Redis-off single-instance fallback is the intended
production operating mode as of 2026-09-17 (Upstash free-tier quota
exhaustion; `REDIS_URL` deliberately unset on the Render service).

PostgreSQL is the authoritative financial/state database in BOTH modes.
No money path reads or writes Redis — financial safety comes from
conditional updates, advisory locks, and ledger dedup keys in Postgres.

## Mode selection

The mode is decided once at boot by `src/lib/bullScheduler.js` `init()`:

| Condition | Mode |
|---|---|
| `REDIS_URL` unset | `single_instance_fallback` |
| `REDIS_URL` set, boot PING fails (5s gate) | `single_instance_fallback` |
| `REDIS_URL` set, boot PING succeeds | `distributed` |

The current mode is logged as ONE authoritative line at boot
(`[Scheduling] Mode: …`) and exposed via `GET /health` → `scheduler`.

## REDIS OFF — single-instance contract

Supported for **exactly one backend instance**.

- Scheduler: in-process node-cron / setInterval (all workers, same cadence).
- Socket.IO: in-memory adapter — realtime events work, but do not cross
  processes.
- Rate limiting (HTTP + socket events): in-memory counters, per-instance.
- No distributed queue state exists at all.
- PostgreSQL remains authoritative for all financial state.
- A Render restart/spin-down **may delay** periodic work — it must never
  duplicate committed economic operations, and it does not: every worker
  re-derives due work from PG state on its next tick (conditional claims,
  upserts, or recompute-from-scratch patterns).

**What breaks with two instances (Redis OFF):**

- Every scheduled job fires once PER instance — economically safe (PG
  claims) but operationally noisy.
- Socket.IO realtime silently fails across instances.
- Rate-limit counters split per instance (effective limits double).
- Payment-failover health windows are per-process.

This mode is safe today because the Render service is single-instance
(`numInstances: 1`) on the free tier. If a second instance is ever added,
Redis must be enabled first.

## REDIS ON — distributed contract

Intended for **multiple backend instances**.

- BullMQ owns all scheduling: each tick fires on exactly one instance.
- Socket.IO Redis adapter fans events across instances.
- Shared rate-limit counters across instances.
- Redis outage behavior (hardened 2026-09-17):
  - ioredis reconnect backoff is bounded: 500ms floor, exponential,
    10s cap (the old ~100ms default floor produced the command storm).
  - Fatal error classes (Upstash `max requests limit`, OOM, auth) trip
    the scheduler circuit breaker immediately; 20 consecutive
    connection-class errors trip it on sustained failure.
  - On trip: ALL Bull workers/queues close, Redis hard-disconnects, and
    every job re-registers on the in-process fallback exactly once —
    no job is ever scheduled through both mechanisms simultaneously.
  - While tripped, one recovery PING every 5 minutes; on success the
    scheduler restores distributed mode with the same exactly-once
    discipline. A quota-dead Upstash rejects commands, and rejected
    commands are not billed — probing costs nothing.

## Worker notes (Redis OFF)

The fallback wraps each tick in try/catch and never retries — worker
failures log once and wait for the next tick, so no in-process hot loop
is possible. Per-worker overlap safety is enforced by DB-level
idempotency for financial workers (advisory locks / conditional claims /
single-transaction settlements) and by explicit `_running` guards on the
workers whose ticks are read-then-act rather than claim-based
(`vaultWorker` — auto-rule deposits are a stale-read TOCTOU without the
guard; `savingsWorker` — duplicate reminder notifications). Workers that
are fully DB-idempotent (susu, auctions, escrow, payout, recon,
storefront-stake, trade) intentionally do NOT carry redundant guards.

## Cost context (why Redis is off on free tier)

BullMQ's idle overhead (per-worker polling, repeatable-job maintenance,
plus full fleet re-registration on every hibernation wake) exhausted the
Upstash free tier's 500,000 command/month quota in ~2.5 weeks with zero
real traffic. On a single instance the distributed-locking benefit is
moot, so Redis stays off until the deployment scales past one instance.
