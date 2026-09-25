-- r40 E2EE v2 (Signal X3DH + Double Ratchet, server-blind relay).
-- See docs/e2ee/PROTOCOL.md. Removes ALL private key material and session
-- state from the database (the server must not be a decryption authority);
-- adds the Message ciphertext envelope + replay anchor; versioned restock
-- fingerprint. Generated via prisma migrate diff (old schema -> new schema).

-- Pre-step: purge legacy E2EE registration data. Every row in these tables
-- was generated SERVER-SIDE by the pre-r40 code (private keys were generated
-- and stored by the server, in direct violation of the trust model). None of
-- it can be trusted under v2 — clients re-register device-generated keys.
-- This also lets the NOT NULL bundle columns below apply on any existing data.
DELETE FROM "E2EEOneTimePreKey";
DELETE FROM "E2EEPreKeyBundle";

-- DropForeignKey
ALTER TABLE "E2EESession" DROP CONSTRAINT "E2EESession_userId_fkey";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "e2eeCipherText" VARCHAR(6000),
ADD COLUMN     "e2eeEnvelopeId" VARCHAR(64),
ADD COLUMN     "e2eeHeader" JSONB,
ADD COLUMN     "e2eeVersion" INTEGER,
ADD COLUMN     "isEncrypted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InventoryRestockOperation" ADD COLUMN     "fingerprintVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "E2EEPreKeyBundle" DROP COLUMN "activeChainKey",
DROP COLUMN "activeRootKey",
DROP COLUMN "identityPrivateKey",
DROP COLUMN "messageNumber",
DROP COLUMN "signedPreKeyPrivateKey",
ADD COLUMN     "identityDhPublicKey" VARCHAR(100) NOT NULL,
ADD COLUMN     "identityKeySignature" VARCHAR(200) NOT NULL,
ADD COLUMN     "previousIdentityDhPublicKey" VARCHAR(100),
ADD COLUMN     "previousIdentityPublicKey" VARCHAR(100);

-- AlterTable
ALTER TABLE "E2EEOneTimePreKey" DROP COLUMN "privateKey";

-- DropTable
DROP TABLE "E2EESession";

-- CreateIndex
CREATE UNIQUE INDEX "Message_e2eeEnvelopeId_key" ON "Message"("e2eeEnvelopeId");

