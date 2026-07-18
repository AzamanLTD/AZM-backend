# AZM Business Portal — Enterprise Production-Readiness Checklist

This is a living document. Items marked ✅ are implemented; items marked 🔲 are
remaining work. Treat this as an ongoing standing checklist, not a one-time pass.

## Reliability & Observability

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Request ID logging | `middleware/requestId.js` — assigns `req.id` + `X-Request-Id` header on every request |
| ✅ | Structured logging | Pino with request ID, business ID, user ID on every log line |
| ✅ | Health endpoint | `/health` returns DB + Redis status |
| 🔲 | Centralized error tracking | Sentry (or equivalent) not yet wired — high priority |
| 🔲 | Uptime/health monitoring | External ping monitor on `/health` with alerting |
| 🔲 | Public status page | Simple page for businesses to check during incidents |

## Security

| Status | Item | Notes |
|--------|------|-------|
| ✅ | `requirePermission` middleware | Applied on all sensitive mutating routes; audit completed July 2026 |
| ✅ | Rate limiting | `authLimiter` on `/api/auth`, `financialLimiter` on trades, `generalLimiter` on public routes |
| ✅ | JWT auth with refresh tokens | `protect` + `protectActive` middleware on all business routes |
| 🔲 | Two-factor authentication | Not yet implemented — needed for payout changes + API key generation |
| 🔲 | Session management screen | List active sessions/devices, "sign out everywhere" action |
| 🔲 | Dependency & secret scanning | Add to CI pipeline; spot-check `messagingChannels` + `webhookDispatcher` |
| ✅ | Secret encryption | API keys encrypted with SHA-256 + base64 in `BusinessMessagingConfig` |

## Data Integrity & Compliance

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Soft-delete consistency | `BusinessPromotion` converted to soft-delete (isActive=false); hours exceptions + tax presets are safe to hard-delete (no FK references) |
| ✅ | Row-level security | Prisma queries always filter by `businessProfileId` |
| 🔲 | Automated DB backups | Need tested restore procedure (not just "backups exist") |
| 🔲 | Data-export flow | GDPR/data-portability export in Danger Zone — scoped but not built |
| ✅ | Audit log | `ActivityLog` entity tracks all mutating actions with actor + diff |

## Testing

| Status | Item | Notes |
|--------|------|-------|
| ✅ | API foundation tests | `__tests__/api-foundation.test.js` — request ID, error handling, pagination |
| ✅ | Business OS tests | `__tests__/business-os.test.js` — employees, scheduling, time-off, EWA |
| 🔲 | Financial calculation tests | Payroll computation, invoice tax-line math, promotion discount math, escrow reconciliation — highest priority for test coverage |
| 🔲 | E2E smoke tests | Core flows per vertical (reservation→check-in→checkout→invoice; dine-in→kitchen→bump→close; trip→book→check-in) |

## Performance

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Route-level code splitting | All 41 pages lazy-loaded via `React.lazy` + `Suspense` — 109 chunks, main bundle is shared vendor only |
| ✅ | Query caching | TanStack Query with staleTime + retry on all data fetches |
| 🔲 | List virtualization | Orders, employees, inventory, notifications need virtualization at real volume (400+ rooms, 6+ months of orders) |

## Polish (Enterprise Tier)

| Status | Item | Notes |
|--------|------|-------|
| 🔲 | In-app "What's New" / changelog | Pairs with notification center |
| 🔲 | Guided product tour | `react-joyride` for first-time users of major sections |
| 🔲 | Sandbox/demo mode | Realistic seeded data for full-platform demos |
| ✅ | Dark/light theme consistency | Pre-paint script, CSS vars throughout, toast theme wired |
| ✅ | Onboarding checklist | `OnboardingChecklist.jsx` component with progress tracking |

## Messaging Channels (Section 5)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | WhatsApp connect/disconnect | Real API endpoint with encrypted credential storage |
| ✅ | SMS connect/disconnect | Real API endpoint with provider config |
| ✅ | Test message send | Logs to `BusinessMessageLog` with cost tracking |
| ✅ | Notification routing preferences | Per-event channel selection, persisted to DB |
| ✅ | Messaging cost stats | Real `BusinessMessageLog` data instead of estimates |
| 🔲 | Real WhatsApp Cloud API | Replace placeholder in `messagingChannels/index.js` |
| 🔲 | Real SMS gateway (Africa's Talking / Twilio) | Replace placeholder in `messagingChannels/index.js` |

## Webhook Reliability (Section 4)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | WebhookDelivery model | Tracks each delivery attempt with status, retry count, next retry time |
| ✅ | Delivery stats endpoint | Success rate, avg latency, failure breakdown |
| ✅ | Manual retry endpoint | Force retry of failed deliveries |
| ✅ | Cron retry queue | Every 2 min, picks up RETRYING/FAILED deliveries with backoff |
| ✅ | Webhook secret signing | HMAC-SHA256 signature on every payload |
| 🔲 | Webhook delivery to be wired into actual order/booking events | Dispatcher function exists, needs integration with event emitters |
