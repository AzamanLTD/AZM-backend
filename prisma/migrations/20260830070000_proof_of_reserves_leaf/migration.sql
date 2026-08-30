-- Immutable per-user commitments for ProofOfReservesSnapshot.
-- Stores the exact balance state represented by the Merkle root so historical
-- proofs remain verifiable after a user's live balance changes.
CREATE TABLE IF NOT EXISTS "ProofOfReservesLeaf" (
    "id" SERIAL NOT NULL,
    "snapshotId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "availableBalance" DECIMAL(20,8) NOT NULL,
    "escrowLockedBalance" DECIMAL(20,8) NOT NULL,
    "vendorUnallocatedBalance" DECIMAL(20,8) NOT NULL,
    "disputeEscrowBalance" DECIMAL(20,8) NOT NULL,
    "leafHash" VARCHAR(64) NOT NULL,
    CONSTRAINT "ProofOfReservesLeaf_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProofOfReservesLeaf_snapshotId_fkey"
      FOREIGN KEY ("snapshotId") REFERENCES "ProofOfReservesSnapshot"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProofOfReservesLeaf_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProofOfReservesLeaf_snapshotId_userId_key"
      UNIQUE ("snapshotId", "userId")
);

CREATE INDEX IF NOT EXISTS "ProofOfReservesLeaf_snapshotId_userId_idx"
  ON "ProofOfReservesLeaf"("snapshotId", "userId");
CREATE INDEX IF NOT EXISTS "ProofOfReservesLeaf_userId_idx"
  ON "ProofOfReservesLeaf"("userId");
