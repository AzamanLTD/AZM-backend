# Private Susu Ecosystem — Render Deploy Runbook

This runbook covers deploying the Private Susu Ecosystem overlay (Phases 1–3)
to the Render-hosted backend. It is the first deploy that ships the overlay
services, workers, and the schema migration, so it requires a one-time
migrate + seed step.

## What this deploy ships

- 6 overlay tables + 5 new enums + new User/SusuGroup/SusuCycle columns
  (migration `20260531201704_20260601_susu_ecosystem_overlay`)
- `DAILY` value added to the `SusuFrequency` enum
  (migration `20260601090000_susu_frequency_daily`)
- Overlay services, controllers, routes, and the three Phase-3 workers
- `azaman-treasury` wallet + v1.0 liability contract (seeded, not migrated)

## Ordering constraint (important)

`server.js` looks up the `azaman-treasury` User row at startup. As of the
Susu Sprint resilience change (2026-06-01) a missing row is **non-fatal** —
the backend boots, logs a warning, and disables only the Susu escrow/cycle
features. It also retries every 60s, and the cycle workers poll for up to
30 minutes, so once the seed lands the feature comes online without a
redeploy.

## Option 0 — Boot-time auto-release (free tier, zero config — DEFAULT)

As of 2026-06-01 the backend self-prepares the DB on boot via
`infra/autoRelease.js`. On startup, if the `azaman-treasury` row is absent,
it runs `prisma migrate deploy` then the seed — both idempotent, both in the
background, neither able to crash the process. This is what makes the feature
work on Render's **free tier**, which has no Shell and no Pre-Deploy hook.

`prisma` and `tsx` are in `dependencies` (not just devDependencies) so the
CLI and the TypeScript `prisma.config.ts` loader are available at runtime.

Nothing to do: just deploy. Watch the logs for:

```
[autoRelease] Treasury missing — running one-time migrate + seed…
[autoRelease] prisma migrate deploy completed.
[autoRelease] susu-foundation seed completed.
[Susu] Treasury wallet cached (userId=...)
```

On every subsequent boot you'll instead see
`[autoRelease] Treasury already present — skipping migrate + seed.`

The Options below remain valid for paid tiers or manual control.

Even so, the correct release sequence prepares the DB *before* traffic:

1. `prisma migrate deploy` — apply the two pending migrations
2. `node infra/seed-susu-foundation.js` — seed treasury + v1.0 contract

Both are idempotent. `npm run release` runs them in order.

## Option A — Render Pre-Deploy Command (recommended, automated)

In the Render dashboard for the `azaman-backend` service
(Settings → Build & Deploy), set:

- **Build Command:** `npm install && npm run build`
- **Pre-Deploy Command:** `npm run release`
- **Start Command:** `npm start`

`render.yaml` at the repo root encodes the same configuration. With the
Pre-Deploy Command set, every push to `main` migrates + seeds before the
new version receives traffic. Nothing else to do.

## Option B — manual one-time finish (if Pre-Deploy is not set)

After the push builds and the service is live, open the Render Shell for the
service and run:

```bash
npm run release
# equivalently:
#   npx prisma migrate deploy
#   node infra/seed-susu-foundation.js
```

Then verify:

```bash
# Treasury wallet exists
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.user.findUnique({where:{username:'azaman-treasury'},select:{id:true,role:true}}).then(r=>{console.log(r);process.exit(0)})"

# Active liability contract exists
curl -s https://azm-backend.onrender.com/api/liability-contract/active | head -c 200
```

A `200` with a contract body on the second command confirms the overlay is
live. The Flutter app's Susu hub + create flow will then work end-to-end.

## Post-deploy smoke test

Run the Phase-2 API checks against the live host (read-mostly; uses fresh
fixture accounts):

```bash
node test_phase2_apis.js https://azm-backend.onrender.com
```

## Rollback

The migrations are forward-only and additive (new tables/columns/enum
values). They do not alter or drop existing data, so a code rollback (revert
the deploy in Render) is safe and leaves the new tables harmlessly unused.
There is no need to roll back the migration itself.
