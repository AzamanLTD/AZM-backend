# Notification Dismissal Contract (Backend E)

**PR:** AzamanLTD/AZM-backend — `feat/notification-dismissal`
**Base:** current `main` (`0edefa1`) — independent of #367–#369 and #370–#373.

The frontend's current notification delete is local-only: the server has
only read-marking (`isRead`), so a removed item reappears on refetch and
the badge stays stale. This PR adds a genuine owner-scoped dismissal
contract.

## Semantics (stable)

- **Soft dismissal only.** The `Notification` record is NEVER deleted —
  financial, security, dispute and audit event history keeps its rows.
- `isRead` and `isDismissed` are **independent, explicit states**:
  dismissal never marks read and read never dismisses. Concurrent
  mark-read/dismiss in either order converges on the same end state.
- Dismissed notifications are **hidden** from the owner's list (all modes,
  including `unreadOnly`) and **excluded from the unread count** — badge
  and list stay consistent; no reappearing items.
- **Multi-device:** `notifications_updated { type: "DISMISSED",
  notificationId }` is emitted on the owner's socket room so other
  sessions drop the item and refresh the badge.
- `actionPayload` and the category taxonomy are untouched by dismissal.

## Routes (Bearer-token authenticated; owner-scoped)

### `DELETE /api/notifications/:id` — dismiss

| Case | Status | Body |
|---|---|---|
| Newly/already dismissed (idempotent) | `200` | `{ success: true, notification: { id, isRead, isDismissed, dismissedAt } }` |
| Unknown notification | `404` | `{ success: false, message: "Notification not found" }` |
| Another user's notification | `403` | `{ success: false, message: "Not authorized" }` |

Unchanged: `GET /api/notifications` (now filters `isDismissed: false`),
`GET /api/notifications/unread-count` (same filter), `PATCH /:id/read`,
`PATCH /read-all`.

## Persistence/provisioning

Additive columns `Notification.isDismissed` (BOOLEAN NOT NULL DEFAULT
false, backfilled) and `Notification.dismissedAt` (TIMESTAMP(3) NULL)
plus the `(userId, isDismissed)` index, provisioned per repo convention
by `infra/install-notification-dismissal-overlay.js` (idempotent,
fail-closed pg_catalog validation), wired into `npm run release`,
boot-time autoRelease, the CI workflow and DEPLOY_RUNBOOK.md. Verified
twice on a disposable database (create-from-empty + re-run no-op).

## Test authority

`__tests__/notification-dismissal.test.js` — 9/9 real-PostgreSQL tests
over the mounted route stack with canonical JWTs: ownership (403 on
foreign rows), honest 404, list/count consistency, idempotent repeat,
read/dismiss convergence both orders, socket event on the owner room,
record-and-payload preservation, markAllAsRead consistency,
unreadOnly hiding. Seed-scoped cleanup; no global truncation.
