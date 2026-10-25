# Business Social-Proof Contract (Backend C)

**PR:** AzamanLTD/AZM-backend — `feat/marketplace-social-proof`
**Base:** current `main` (`0edefa1`) — independent of #370/#371 and the
financial PRs #367–#369.

The business avatar action menu needs factual social proof ("Followed by X
friends", "Y friends of friends" — presentation labels chosen by the
frontend; the API returns only real aggregate numbers). Uses the EXISTING
authorities only: `Friendship` (accepted edges) and `BusinessFollower` (the
canonical follow relationship, written by FollowService, untouched here).
No second friend or follow authority is created.

## Graph definition (stable, documented)

- **Direct friends of V**: users `U` joined by a `Friendship` row with
  `status = 'ACCEPTED'` (either direction), `U ≠ V`.
- **Friends of friends of V**: users `U` (`U ≠ V`, `U` not a direct friend
  of `V`) joined by an `ACCEPTED` `Friendship` row with SOME direct friend of
  `V`. The two sets are DISJOINT by construction.
- **Eligible account**: `banStatus = 'ACTIVE'` and `isDeleted = false`
  (exactly the rules `protect` enforces).
- **Counts** (unique persons, counted once regardless of graph paths):
  - `friendsFollowingCount` — eligible direct friends of the viewer who
    follow the business.
  - `friendsOfFriendsFollowingCount` — eligible friends-of-friends of the
    viewer who follow the business, with direct friends and the viewer
    excluded.

A business follow is NOT a visit. No visit/check-in claim is made or
implied by this API. Only aggregate NUMBERS are returned — never identities
or lists of friends.

## Routes (both require a Bearer token; personalised per-viewer)

### `GET /api/social-proof/:businessProfileId`

| Case | Status | Body |
|---|---|---|
| OK | `200` | `{ success: true, businessProfileId, friendsFollowingCount, friendsOfFriendsFollowingCount }` |
| Missing/invalid ID | `400` | `{ success: false, code: "VALIDATION_ERROR", message }` |
| Unknown business | `404` | `{ success: false, code: "BUSINESS_NOT_FOUND", message }` |
| No token | `401` | protect response |

### `POST /api/social-proof` — batch (multi-card rendering, N+1-free)

Request: `{ "businessProfileIds": ["<id>", ...] }` (max 50, non-empty
string array).

`200` → `{ success: true, proofs: { "<id>": { friendsFollowingCount, friendsOfFriendsFollowingCount }, ... } }`
Unknown ids are absent-data honest zeros (the single route is the one that
distinguishes 404). Over 50 or malformed → `400 VALIDATION_ERROR`.

## Performance

Exactly ONE raw SQL statement per business (two for a whole batch page)
regardless of graph size — no N+1, verified by the batch test.

## Test authority

`__tests__/business-social-proof.test.js` — 13/13 real-PostgreSQL tests
over the mounted route stack with canonical JWTs:

- direct friend follows / non-friend does not inflate / FoF follows
- multi-path reachability counts once (two paths to the same person)
- direct friends never double-counted as FoF (disjoint sets)
- viewer exclusion (viewer's own follow never counts)
- honest zeros with no friendships/follows
- banned follower excluded under the real eligibility rules
- PENDING friendship is not a friend edge
- counts track real follow/unfollow changes
- 401/400/404 contract; batch honest zeros + cap
- sanity cross-check against a naive full-follower count (a
  count-everyone implementation fails the suite)
- seed-scoped, dependency-ordered cleanup — no global truncation
