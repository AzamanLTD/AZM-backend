# Mobile API surface verification — investigation & design (r15 audit item 11)

Status: DESIGN — not yet implemented. This document is the investigation and
the proposed design for verifying the CONSUMER mobile app's API surface against
the backend route registry. It is explicitly separate from the existing
business-portal gate and does NOT replace or modify it.

## Why a separate lane for the mobile app

`npm run route-check` (scripts/route-checker.js) currently gates the React
BUSINESS PORTAL (AzamanLTD/AZM-businessPortal) against the backend route
registry: it scans the portal's centralized API layer
(`src/lib/api.js`, `src/lib/marketplaceApi.js`) for `request(...)` calls and
fails when a frontend call has no matching backend route. That gate is correct
for what it checks. It says nothing about the CONSUMER app.

AzamanLTD/AZM-frontend (the Flutter consumer app) is a different client with a
different API surface: the two clients do not call identical routes, and the
mobile app's usage patterns (offline retry, background workers, wallet passes)
will diverge further over time. A route removed or renamed for portal reasons
can silently break the mobile app even while the portal gate stays green.

## Differences that shape the design

1. **Source language.** Dart, not JavaScript. The mobile app does not have a
   single `api.js` equivalent: HTTP calls are spread across
   `lib/services/*.dart` (and some providers/widgets) using Dio/HTTP with
   string paths, some interpolated at runtime. Extraction must handle:
   - literal paths (`'/api/wallet/...'`)
   - path segments built by string interpolation (`'$kBaseUrl/...'`,
     `'${ApiRoutes.wallet}/$id'`) — constant folding over the app's route
     constants is needed before matching
   - WebSocket/Socket.IO event subscriptions, which the portal gate does not
     model at all (mobile uses Socket.IO channels for chat/balance updates)

2. **Repository visibility.** AZM-businessPortal is public, which is why the
   existing CI gate can check it out with the default `GITHUB_TOKEN`. AZM-
   frontend is PRIVATE: a CI cross-checkout requires a stored repository
   access token (a `FRONTEND_MOBILE_TOKEN` secret on the backend repo with
   read-only `contents` scope for the frontend repo). This is the primary
   operational blocker — an org owner decision, not a code problem.

3. **Volatility.** The mobile app ships on a release cadence; its pinned
   backend expectations lag the backend's main branch by days. The gate should
   therefore report MOBILE SURFACE DRIFT per commit rather than hard-fail
   every main-branch push: a route deletion should fail the gate only when the
   mobile app still calls it (the same contract as the portal gate), but new
   backend routes the mobile app does not yet use are fine.

## Proposed design

**Extractor: `scripts/mobile-route-checker.js`**

1. Parse backend mounts exactly as `route-checker.js` does (server.js +
   `src/routes/index.js` require map + per-router method/path scans) — one
   shared module, not a copy. Reuse `pathMatches()` semantics so the two
   gates cannot disagree about what a match is.
2. Scan the mobile app for the Dart request surface:
   - collect endpoint paths from `dio.` / `http.` calls and route constants
     (`static const ... = '/api/...'`) with constant folding
   - collect Socket.IO `socket.on(...)` event subscriptions into a separate
     "realtime surface" list; match those against the server's emitted events
     (from `src/sockets/connectionHandler.js` and friends) with a warning-only
     severity in v1 (the realtime contract is not yet formalized)
3. Compare: every mobile endpoint call must match a backend route. Any
   unmatched call exits non-zero. Matched-but-unused routes are reported
   informationally (no failure) — same asymmetry as the portal gate.
4. Gate mode mirrors the portal gate's fail-closed rule: `ROUTE_CHECK_-
   REQUIRE_MOBILE=1` makes an absent/empty frontend checkout a FAILURE, never
   a vacuous PASS.

**CI wiring (`scripts/route-checker.js` stays untouched):**

- A separate workflow step that checks out AZM-frontend at `main` with the
  stored read-only token, sets `ROUTE_CHECK_MOBILE_ROOT` and
  `ROUTE_CHECK_REQUIRE_MOBILE=1`, and runs `npm run route-check:mobile`.
- Runs on the same `pull_request`/`push` triggers as the main battery until
  the drift baseline is established; afterwards it can be restricted to
  `paths:` filters touching routes/, src/sockets/, or the mobile API notes.

**Prerequisites (in order):**

1. Org owner stores a read-only `FRONTEND_MOBILE_TOKEN` secret on AZM-backend.
2. Survey pass on AZM-frontend inventories the actual HTTP layer shape (which
   files, which client library, how paths are constructed, how many use
   interpolation). The extractor design above is written against the expected
   shape and must be adjusted to what the survey finds — it is deliberately
   written before cloning so the survey is driven by the gate's needs, not by
   an assumption that "the mobile app looks like the portal".
3. Realize the extractor with unit tests over a synthetic Dart corpus before
   ever pointing it at the real repo (same TDD posture as the portal gate).

## What this document deliberately does NOT do

- It does not modify the business-portal gate in any way.
- It does not yet clone or scan AZM-frontend (blocked on the token decision).
- It does not propose backend route freezing for mobile compatibility; the
   gate reports drift, the deprecation policy is an owner decision.
