# Azaman Backend

Node.js / Express 5 API server for the Azaman P2P crypto exchange platform.

## Stack

- **Runtime**: Node.js 24, Express 5

  Runtime contract: Node 24 is pinned in `.nvmrc`, `package.json` (`engines.node:
  24.x`), `render.yaml` (`NODE_VERSION`) and CI. The full serial test battery
  is verified against Node 24 only; do not bump major Node versions casually —
  verify the entire suite and dependencies first.
- **Database**: PostgreSQL via Prisma 6 + `@prisma/adapter-pg`
- **Real-time**: Socket.IO 4.8 (optional Redis pub/sub adapter for multi-instance)
- **Auth**: JWT (15-min access + 30-day opaque refresh tokens, `tokenVersion` cascade)
- **Storage**: Cloudinary (chat media, avatars, vendor docs, proofs)
- **Push notifications**: Firebase Admin SDK (FCM)

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment template and fill in values
cp .env.example .env

# Generate Prisma client
npx prisma generate

# Apply the schema (dev/test databases)
npx prisma db push
npm run release

# NOTE — schema authority: disposable dev/test databases use `db push` + the
# additive overlay installers above (exactly what CI runs). `prisma migrate
# deploy` is NOT a deploy path anywhere in this project: production DDL is
# owned exclusively by the `infra/install-*-overlay.js` installers, and the
# historical `prisma/migrations` chain is development history only.

# Start server
npm start
```

## Testing

```bash
# Run the test suite (math tests run without DB; integration tests require TEST_DATABASE_URL)
npm test

# With a real DB
cp .env.test.example .env.test
TEST_DATABASE_URL=postgres://... npm test
```

## Environment

See `.env.example` for the full list. Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | ≥ 32-character random string (enforced at boot) |
| `JWT_ACCESS_EXPIRY` | Access token lifetime (default `15m`) |
| `JWT_REFRESH_EXPIRY_DAYS` | Refresh token lifetime in days (default `30`) |

All external services (MTN MoMo, Tatum, Kotani Pay, Email, SMS, KYC) default to `MOCK` mode. Set their `*_PROVIDER` env vars to enable real integrations.

## Key Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register a new user |
| `POST` | `/api/auth/login` | Login, returns access + refresh tokens |
| `POST` | `/api/auth/refresh` | Rotate refresh token |
| `POST` | `/api/auth/logout` | Revoke refresh token |
| `GET` | `/health` | System health (DB, Redis, workers, version gate) |
| `GET` | `/api/public/stats` | Public platform stats (no auth) |
| `GET` | `/api/ads` | P2P marketplace ads |
| `POST` | `/api/trades/initiate` | Initiate a trade |
| `POST` | `/api/kyc/initialize` | Start KYC verification session |

## Architecture Highlights

- **Money correctness**: all financial mutations inside `prisma.$transaction`. `runDoubleCheck` validates ledger before withdrawals.
- **TOCTOU protection**: `updateMany({ where: { id, status: expected } })` pattern on all concurrent-sensitive flows (`completeTrade`, `markAsPaid`, `forceRelease`, etc.).
- **Token security**: `tokenVersion` on `User` — bumped on password change, role change, ban, and account delete. Every authenticated request validates the version claim.
- **Admin alerts**: `adminAlertService` broadcasts critical events (large withdrawals, low fiat pool, disputes, KYC manual review) to the admin portal socket room and optionally by email.
- **KYC**: Dojah widget-based verification with HMAC-secured webhooks and confidence-based auto-approve/reject. MOCK mode by default.

## Workers

| Worker | Purpose |
|---|---|
| `tradeWorker` | Auto-cancels expired trades, refunds escrow |
| `withdrawalReconciliationWorker` | Polls MTN MoMo for pending withdrawal status |
| `payoutBatchWorker` | Auto-dispatches small fiat withdrawals when pool has liquidity |
| `savingsWorker` | Streak tracking, reminders, goal maturity |
| `cfoWorker` | AI CFO monitoring of reserve balances |
| `leaderboardWorker` | Periodic vendor leaderboard snapshots |
| `analyticsWorker` | Vendor analytics aggregation |
