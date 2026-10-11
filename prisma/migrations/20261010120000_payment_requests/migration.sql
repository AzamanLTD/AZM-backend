-- Standalone payment requests — server-owned request resource.
--
-- The standalone "request money" resource behind POST /api/payment-requests
-- (Receive/Request UX). Deliberately separate from the chat-oriented
-- PeerTransfer REQUEST flow: no PeerTransfer row and no DirectMessage is
-- created on this path. The full contract lives on the PaymentRequest model
-- comment in prisma/schema.prisma; the deployment-converged DDL twin is
-- infra/install-payment-requests-overlay.js (idempotent, release chain).
--
-- NOTE on production application: the repository's established release
-- process is `db push` plus the idempotent overlay installers (npm run
-- release). This committed migration is the reviewed, reproducible record
-- of the exact DDL the overlay converges to, and can be applied by
-- `prisma migrate deploy` in environments that baseline on migrations.

CREATE TABLE "PaymentRequest" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "requesterId" INTEGER NOT NULL,
    "recipientId" INTEGER,
    "mode"        TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'PENDING',
    "amountExact" TEXT NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'GHS',
    "tokenHash"   TEXT,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- DIRECT requests address exactly one recipient; that recipient is a User.id
-- (never a Friendship.id). LINK requests carry no preselected payer.
ALTER TABLE "PaymentRequest"
    ADD CONSTRAINT "PaymentRequest_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentRequest"
    ADD CONSTRAINT "PaymentRequest_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Outgoing list: the cursor query filters requesterId and orders
-- createdAt DESC, id DESC with the (createdAt, id) cursor predicate —
-- status is never filtered in the list, so it is not part of the index.
CREATE INDEX "PaymentRequest_requesterId_createdAt_id_idx"
    ON "PaymentRequest"("requesterId", "createdAt", "id");

-- Incoming list (requests addressed to the authenticated user).
CREATE INDEX "PaymentRequest_recipientId_createdAt_id_idx"
    ON "PaymentRequest"("recipientId", "createdAt", "id");

-- Expiry sweep/audit target: EXPIRED is a server-projected terminal state.
CREATE INDEX "PaymentRequest_expiresAt_idx"
    ON "PaymentRequest"("expiresAt");

-- LINK share tokens are stored ONLY as their sha256 hash; the hash is the
-- public-link lookup key and must be unique.
CREATE UNIQUE INDEX "PaymentRequest_tokenHash_key"
    ON "PaymentRequest"("tokenHash");
