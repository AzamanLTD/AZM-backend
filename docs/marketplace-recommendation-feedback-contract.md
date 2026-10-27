# "Show Less Like This" Contract (Backend D)

**PR:** AzamanLTD/AZM-backend — `feat/marketplace-show-less`
**Base:** current `main` (`0edefa1`) — independent of #370/#371/#372 and #367–#369.

A persistent, user-scoped recommendation-suppression signal for business
discovery. No suitable existing mechanism exists (AccountFeedback is
general text feedback; nothing feeds ranking), so this adds a distinct
`BusinessRecommendationFeedback` model and wires a REAL ranking effect
into `businessService.searchBusinesses`.

## Routes (all Bearer-token authenticated; private to the caller)

### `POST /api/recommendation-feedback` — apply "Show less"

Request: `{ "businessProfileId": "<uuid>" }`

| Case | Status | Body |
|---|---|---|
| Newly applied | `201` | `{ success: true, state: "SHOW_LESS", alreadyApplied: false, appliedAt }` |
| Repeat (idempotent) | `200` | `{ success: true, state: "SHOW_LESS", alreadyApplied: true, appliedAt }` |
| Missing/invalid ID | `400` | `{ success: false, code: "VALIDATION_ERROR" }` |
| Unknown business | `404` | `{ success: false, code: "BUSINESS_NOT_FOUND" }` |
| No token | `401` | protect response |

### `DELETE /api/recommendation-feedback/:businessProfileId` — undo

`200` → `{ success: true, state: "NONE", removed: true|false }` (idempotent;
`removed: false` on repeat). Undo is RELIABLE: the row was the only
personalisation signal for the pair, so deletion restores the prior
ranking (test-pinned).

### `GET /api/recommendation-feedback/check/:businessProfileId`

`200` → `{ success: true, applied: boolean }`

### `GET /api/recommendation-feedback?limit=&offset=`

`200` → `{ success: true, total, suppressed: [{ businessProfileId, feedbackType, appliedAt }] }`
— the caller's own rows only, newest first, limit cap 100.

## Ranking effect (real, test-pinned)

`searchBusinesses` accepts an optional `viewerId`:

- Suppressed businesses are DEMOTED to the end of the page (one batched
  query; stable order within kept and demoted groups; nothing removed).
- Anonymous callers and OTHER users see the unmodified ranking.
- Feedback never overrides hard eligibility/availability/safety rules:
  suspended/pause filters run before demotion; the business profile,
  follow, bookmark and review states are untouched.
- Ordinary search behaviour is preserved (query/category/rating filters
  unchanged).

**Wiring note:** `GET /api/business/search` currently runs
unauthenticated; it resolves `viewerId` from `req.user` when present. The
optional viewer resolution on that public route lands with #371's
`optionalAuth` (merge order: #371 before/with this PR; the demotion is
already live for any authenticated caller of the service and for the
followed/discovery surfaces once they pass a viewer).

## Persistence/provisioning

Additive `BusinessRecommendationFeedback` model, provisioned per repo
convention by `infra/install-business-recommendation-feedback-overlay.js`
(idempotent, fail-closed pg_catalog validation) wired into `npm run
release`, boot-time autoRelease, CI, and DEPLOY_RUNBOOK.md.

## Test authority

`__tests__/business-recommendation-feedback.test.js` — 9/9 real-PostgreSQL
tests: persistence + idempotency (single row proven by direct count),
re-apply after undo, honest 400/404s, route-boundary 401, caller privacy,
follow/bookmark independence, RANKING EFFECT (demotion for the caller
only, order-relative and stable, demoted-not-removed), undo restores prior
ranking, list pagination. Seed-scoped cleanup; no global truncation.
