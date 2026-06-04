-- =============================================================================
-- AZAMAN — Phase K (Auth + security hardening)
--
-- Adds:
--   1. User.tokenVersion — incremented whenever the user's privileges change
--      (today: USER -> VENDOR via KYC approval). Embedded in the access JWT.
--      `protect` middleware can compare the JWT claim to the live row to
--      reject stale tokens. The current cutover is opt-in: tokens issued
--      before this migration carry no tokenVersion claim and are accepted
--      as v0 to avoid logging every existing user out.
--
--   2. RefreshToken — long-lived refresh-token table. Each token is a
--      uuid, opaque on the wire. POST /api/auth/refresh exchanges a valid
--      refresh token for a fresh 15-minute access token + a rotated
--      refresh token. Logout / role change revokes the active token.
-- =============================================================================

-- Add tokenVersion column. Existing rows default to 0 — same as the missing
-- claim treated as 0 in the protect middleware.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- New refresh-token table.
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- Lookup index: refresh-by-user (for revoke-all on role change).
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- Lookup index: a periodic worker can sweep expired tokens cheaply.
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- Foreign key — cascade on user deletion so we don't leak orphan tokens.
ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
