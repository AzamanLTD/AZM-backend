# Business Story-State Contract (Backend B)

**PR:** AzamanLTD/AZM-backend — `feat/marketplace-story-state`
**Base:** current `main` (`0edefa1`) — independent of Backend A (#370) and of
the financial PRs #367/#368/#369.

The frontend must draw a marketplace story ring from REAL story state. This
contract attaches an additive, authoritative `storyState` block to business
card DTOs, computed from the single story authority (`Story`/`StoryView` via
`services/storyService.js`). No second story authority exists or was created.

## The `storyState` block

Every business card in `GET /api/business/search` and
`GET /api/follows/following` now carries:

```json
"storyState": {
  "hasActiveStory": true,          // a Story for this business with expiresAt > now exists
  "hasUnseenStory": true,          // null for anonymous viewers; true iff an
                                  // ACTIVE story has no StoryView row for the viewer
  "latestStoryAt": "2026-10-25T..." // ISO createdAt of the newest ACTIVE story —
                                   // the ring-ordering timestamp; null when none
}
```

Semantics (all verified by tests):

- **No active stories** → `{ hasActiveStory: false, hasUnseenStory: false|null, latestStoryAt: null }`. Expired stories contribute nothing.
- **Active + unseen** → ring with "new" emphasis.
- **Active + all seen** → ring without unseen emphasis.
- **Anonymous viewer** (`GET /api/business/search` without a token): `hasActiveStory` and `latestStoryAt` are still real; `hasUnseenStory` is `null` — the client must NOT treat null as true or false.
- **Privacy:** only booleans and one timestamp leave the server. No story contents, media, viewer identities or lists. Unseen is computed from the existing `StoryView` model, so existing view semantics apply unchanged.

## Route changes (additive)

- `GET /api/business/search` — now runs `optionalAuth`: a valid Bearer token
  personalises `storyState.hasUnseenStory`; no token, invalid token, banned or
  deleted callers simply proceed anonymously (the route never rejects).
- `GET /api/follows/following` — authenticated as before; cards now carry
  `storyState` for the caller.

`optionalAuth` mirrors `protect`'s verification exactly (JWT verify,
live-user check, ban/deleted/tokenVersion rules) — the only difference is
the failure mode (proceed anonymously instead of 401).

No existing response fields were changed or removed — old clients are
unaffected (test-pinned).

## Performance

Exactly TWO queries per page regardless of page size (N+1-free, proven by
test): one batched active-story fetch for all businesses on the page, one
viewer StoryView fetch for authenticated callers. The service is read-only —
it never writes Story/StoryView rows (test-pinned).

## Source of truth

`Story.expiresAt` (active window), `Story.businessProfileId` (business
linkage), `StoryView(storyId, viewerId)` (seen state), `Story.createdAt`
(ordering). Story availability must never be inferred client-side from
logo/description/review/follow fields.

## Test authority

`__tests__/business-story-state.test.js` — 9/9 real-PostgreSQL tests: no
stories / active-unseen / active-all-seen / expired / anonymous-null /
mixed-page independence / N+1 constant query count / read-only +
backward-compatible card fields / optionalAuth behaviour (anonymous, valid
token, garbage token). Seed-scoped cleanup, no global truncation.
