// services/marketplace/businessSocialProofService.js
// =============================================================================
// AZAMAN — BUSINESS SOCIAL PROOF (marketplace personalisation, Backend C)
//
// Real "Followed by X friends / Y friends of friends" aggregates for the
// business avatar action menu. Uses the EXISTING authorities only:
//   - Friendship (status = ACCEPTED) is the friend graph.
//   - BusinessFollower is the canonical business-follow relationship
//     (FollowService is untouched; this service only READS).
//
// GRAPH DEFINITION (documented, stable):
//   direct friends of V   = users U where a Friendship row with
//                           status ACCEPTED exists between V and U
//                           (either direction), U != V.
//   friends of friends    = users U (U != V, U not a direct friend of V)
//                           where a Friendship row with status ACCEPTED
//                           exists between U and SOME direct friend of V.
//   eligible account      = banStatus = 'ACTIVE' and isDeleted = false
//                           — applied to EVERY graph node and intermediary
//                           (mf members, fof members, followers), never just
//                           the follower set (review reconciliation).
//                           (the same rules protect enforces).
//
// COUNTS (both unique-person counts, disjoint by construction):
//   friendsFollowingCount         = eligible direct friends of the viewer
//                                   who follow the business.
//   friendsOfFriendsFollowingCount= eligible friends-of-friends of the
//                                   viewer who follow the business, with
//                                   direct friends and the viewer excluded.
//
// A person reachable through multiple graph paths counts ONCE (DISTINCT).
// A follow is NOT a visit — this service never claims visits. Only
// aggregate NUMBERS are returned; no identities, no lists.
//
// N+1-FREE: exactly ONE raw SQL query per business (two when the business
// list is batched, see getSocialProofBatch), regardless of graph size.
// =============================================================================

// One statement computing both counts for one business. CTEs:
//   mf   — the viewer's eligible accepted-friend set (both directions)
//   fof  — two-hop set: eligible users accepted-friends with any mf member,
//          excluding the viewer and every mf member (disjointness)
//   foll — the business's eligible follower ids
const SOCIAL_PROOF_SQL = `
  WITH mf AS (
      -- Eligible direct friends only (review reconciliation): the ban/deleted
      -- filter applies to EVERY graph node, not just followers.
      SELECT CASE WHEN fr."requesterId" = $2::int THEN fr."addresseeId" ELSE fr."requesterId" END AS fid
      FROM "Friendship" fr
      JOIN "User" mu ON mu.id = (CASE WHEN fr."requesterId" = $2::int THEN fr."addresseeId" ELSE fr."requesterId" END)
      WHERE fr.status = 'ACCEPTED'
        AND (fr."requesterId" = $2::int OR fr."addresseeId" = $2::int)
        AND fr."requesterId" <> fr."addresseeId"
        AND mu."banStatus" = 'ACTIVE'
        AND mu."isDeleted" = false
  ),
  fof AS (
      -- Eligible friends-of-friends only: banned/deleted users can be neither
      -- fof NODES nor graph INTERMEDIARIES (intermediaries are already
      -- filtered inside mf; the fof endpoint itself is filtered here).
      SELECT DISTINCT CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END AS uid
      FROM "Friendship" f
      JOIN mf ON f."requesterId" = mf.fid OR f."addresseeId" = mf.fid
      JOIN "User" fu ON fu.id = (CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END)
      WHERE f.status = 'ACCEPTED'
        AND f."requesterId" <> f."addresseeId"
        AND fu."banStatus" = 'ACTIVE'
        AND fu."isDeleted" = false
        AND CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END <> $2::int
        AND CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END NOT IN (SELECT fid FROM mf)
  ),
  foll AS (
      SELECT bf."customerId" AS cid
      FROM "BusinessFollower" bf
      JOIN "User" u ON u.id = bf."customerId"
      WHERE bf."businessProfileId" = $1
        AND u."banStatus" = 'ACTIVE'
        AND u."isDeleted" = false
  )
  SELECT
      (SELECT COUNT(*) FROM foll WHERE cid IN (SELECT fid FROM mf))   AS "friendsFollowingCount",
      (SELECT COUNT(*) FROM foll WHERE cid IN (SELECT uid FROM fof))  AS "friendsOfFriendsFollowingCount"`;

async function getSocialProof(prisma, { viewerId, businessProfileId }) {
    const rows = await prisma.$queryRawUnsafe(SOCIAL_PROOF_SQL, businessProfileId, viewerId);
    const r = rows[0] || {};
    return {
        friendsFollowingCount: Number(r.friendsFollowingCount) || 0,
        friendsOfFriendsFollowingCount: Number(r.friendsOfFriendsFollowingCount) || 0,
    };
}

// Batch variant for multi-card rendering: one statement for many businesses.
// $1 = viewerId (int), $2 = text[] of business ids.
const BATCH_SQL = `
  WITH mf AS (
      SELECT CASE WHEN fr."requesterId" = $1::int THEN fr."addresseeId" ELSE fr."requesterId" END AS fid
      FROM "Friendship" fr
      JOIN "User" mu ON mu.id = (CASE WHEN fr."requesterId" = $1::int THEN fr."addresseeId" ELSE fr."requesterId" END)
      WHERE fr.status = 'ACCEPTED'
        AND (fr."requesterId" = $1::int OR fr."addresseeId" = $1::int)
        AND fr."requesterId" <> fr."addresseeId"
        AND mu."banStatus" = 'ACTIVE'
        AND mu."isDeleted" = false
  ),
  fof AS (
      SELECT DISTINCT CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END AS uid
      FROM "Friendship" f
      JOIN mf ON f."requesterId" = mf.fid OR f."addresseeId" = mf.fid
      JOIN "User" fu ON fu.id = (CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END)
      WHERE f.status = 'ACCEPTED'
        AND f."requesterId" <> f."addresseeId"
        AND fu."banStatus" = 'ACTIVE'
        AND fu."isDeleted" = false
        AND CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END <> $1
        AND CASE WHEN f."requesterId" = mf.fid THEN f."addresseeId" ELSE f."requesterId" END NOT IN (SELECT fid FROM mf)
  ),
  foll AS (
      SELECT bf."businessProfileId" AS bid, bf."customerId" AS cid
      FROM "BusinessFollower" bf
      JOIN "User" u ON u.id = bf."customerId"
      WHERE bf."businessProfileId" = ANY($2::text[])
        AND u."banStatus" = 'ACTIVE'
        AND u."isDeleted" = false
  )
  SELECT
      foll.bid AS "businessProfileId",
      COUNT(DISTINCT CASE WHEN foll.cid IN (SELECT fid FROM mf) THEN foll.cid END)   AS "friendsFollowingCount",
      COUNT(DISTINCT CASE WHEN foll.cid IN (SELECT uid FROM fof) THEN foll.cid END)  AS "friendsOfFriendsFollowingCount"
  FROM foll
  GROUP BY foll.bid`;

async function getSocialProofBatch(prisma, { viewerId, businessProfileIds }) {
    const rows = await prisma.$queryRawUnsafe(BATCH_SQL, viewerId, businessProfileIds);
    const map = {};
    for (const id of businessProfileIds) map[id] = { friendsFollowingCount: 0, friendsOfFriendsFollowingCount: 0 };
    for (const r of rows) {
        map[r.businessProfileId] = {
            friendsFollowingCount: Number(r.friendsFollowingCount) || 0,
            friendsOfFriendsFollowingCount: Number(r.friendsOfFriendsFollowingCount) || 0,
        };
    }
    return map;
}

module.exports = { getSocialProof, getSocialProofBatch };
