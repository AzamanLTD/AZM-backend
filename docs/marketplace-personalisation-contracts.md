# Marketplace Personalisation API Contracts (Backend workstream)

Backend contracts for the marketplace personalisation features (saved
businesses, story-ring state, social proof, "show less" feedback,
notification dismissal, transaction continuation support).

**Status legend:** ✅ implemented and tested · 🚧 in progress · ⏳ planned.
Contracts marked ✅ are the reviewed authority — the frontend should
consume exactly these shapes and never infer success or state locally.

Current main at authoring: `0edefa1dbe056343080f2d762d89a1b0936c109c`.
Financial PRs #367/#368/#369 are unrelated to this workstream and are NOT
dependencies of it; all personalisation PRs branch from current `main`.

---

## Backend A — Business bookmarks ("saved businesses") ✅

**PR:** AzamanLTD/AZM-backend — `feat/marketplace-bookmarks`
**Model:** `BusinessBookmark` (additive; provisioned by
`infra/install-business-bookmark-overlay.js` in the release chain, boot-time
autoRelease, and CI — the repo's established provisioning convention).
Distinct from follows BY CONTRACT: following is a public relationship that
drives the story/ad feed; bookmarking is a private per-user collection with
no feed or notification effect.

All four routes require a valid Bearer access token (`protect` middleware).
Ownership is absolute: the caller is always resolved from the token, never
from the request body, so cross-user reads/removals are structurally
impossible. All IDs are canonical `BusinessProfile.id` values — never
product, location or display-name identifiers.

### `POST /api/bookmarks`

Request body: `{ "businessProfileId": "<uuid>" }`

| Case | Status | Body |
|---|---|---|
| Newly saved | `201` | `{ success: true, state: "BOOKMARKED", alreadyBookmarked: false, bookmark: { businessProfileId, savedAt } }` |
| Already saved (idempotent repeat) | `200` | `{ success: true, state: "BOOKMARKED", alreadyBookmarked: true, bookmark: { businessProfileId, savedAt } }` |
| Missing/invalid `businessProfileId` | `400` | `{ success: false, code: "VALIDATION_ERROR", message }` |
| Unknown business ID | `404` | `{ success: false, code: "BUSINESS_NOT_FOUND", message }` |
| Caller's own business | `400` | `{ success: false, code: "OWN_BUSINESS", message }` |
| No/expired token | `401` | protect response |

Idempotency: the database enforces `UNIQUE (businessProfileId, customerId)`
— repeated saves can never create a duplicate relationship. `state` is the
stable client-facing signal; `alreadyBookmarked` lets the UI distinguish a
new save from a repeat.

### `DELETE /api/bookmarks/:businessProfileId`

| Case | Status | Body |
|---|---|---|
| Removed an existing bookmark | `200` | `{ success: true, state: "NOT_BOOKMARKED", removed: true }` |
| Was not bookmarked (idempotent repeat) | `200` | `{ success: true, state: "NOT_BOOKMARKED", removed: false }` |
| Unknown business ID | `404` | `{ success: false, code: "BUSINESS_NOT_FOUND", message }` |

### `GET /api/bookmarks/check/:businessProfileId`

`200` → `{ success: true, bookmarked: boolean }`

### `GET /api/bookmarks?limit=&offset=`

`200` →
```json
{
  "success": true,
  "total": 12,
  "bookmarks": [
    {
      "businessProfileId": "uuid",
      "bizId": "string",
      "businessName": "string",
      "logoUrl": "string|null",
      "category": "BusinessCategory",
      "isVerified": "boolean",
      "averageRating": "number|null",
      "savedAt": "ISO-8601"
    }
  ]
}
```
Newest saved first (`savedAt` DESC). `limit` default 50, capped at 100;
`offset` for pagination; `total` is the caller's full count before
pagination. The list contains ONLY the caller's bookmarks.

`bizId` is the public deep-link identifier for the app's business profile
route (`GET /api/business/:bizId`). Both identifiers ship on every row:
`businessProfileId` remains the CANONICAL key for bookmark writes, checks
and deletes — never substitute one for the other. `bizId` is a read-side
navigation convenience only and is never accepted as a write key.

### Referential integrity

`ON DELETE CASCADE` on both sides: deleting a business profile removes its
bookmarks; deleting a user account removes their bookmarks. Bookmarks are
never deleted for other reasons.

### Semantics the frontend must NOT assume

- Bookmarking does not follow the business and does not affect the story
  feed, ad feed or follower counts.
- `isBookmarked` is not derivable from any other field in any DTO; use
  `GET /check/:id` or the list.
- A 404 on save/delete means the business ID is wrong — do not retry and
  do not simulate a local save.

### Test authority

`__tests__/business-bookmarks.test.js` — 13 real-PostgreSQL integration
tests over the exact mounted route stack (real `protect`, real
`prismaInjector`, canonical JWTs from `services/authTokenService`):
idempotent save, idempotent remove, re-add, cross-user isolation both
directions, honest 404s, own-business refusal, list isolation +
pagination, business-delete cascade, and route-boundary 401s. No global
truncation: the suite cleans up only the rows it seeds.
