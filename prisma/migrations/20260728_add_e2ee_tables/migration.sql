-- E2EE (Signal-style Protocol) tables

-- PreKey bundle: identity key + signed preKey (one per user)
CREATE TABLE "E2EEPreKeyBundle" (
    "id"                      TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"                  INTEGER      NOT NULL,
    "identityPublicKey"       VARCHAR(100) NOT NULL,
    "identityPrivateKey"      VARCHAR(100),
    "signedPreKeyId"          INTEGER      NOT NULL,
    "signedPreKeyPublicKey"   VARCHAR(100) NOT NULL,
    "signedPreKeyPrivateKey"  VARCHAR(100),
    "signedPreKeySignature"   VARCHAR(200) NOT NULL,
    "activeRootKey"           VARCHAR(200),
    "activeChainKey"          VARCHAR(200),
    "messageNumber"           INTEGER      NOT NULL DEFAULT 0,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2EEPreKeyBundle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "E2EEPreKeyBundle_userId_key" ON "E2EEPreKeyBundle"("userId");
CREATE INDEX "E2EEPreKeyBundle_userId_idx" ON "E2EEPreKeyBundle"("userId");

ALTER TABLE "E2EEPreKeyBundle" ADD CONSTRAINT "E2EEPreKeyBundle_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time preKeys (consumed on each session start)
CREATE TABLE "E2EEOneTimePreKey" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"     INTEGER      NOT NULL,
    "keyId"      INTEGER      NOT NULL,
    "publicKey"  VARCHAR(100) NOT NULL,
    "privateKey" VARCHAR(100) NOT NULL,
    "isUsed"     BOOLEAN       NOT NULL DEFAULT false,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt"     TIMESTAMP(3),

    CONSTRAINT "E2EEOneTimePreKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "E2EEOneTimePreKey_userId_isUsed_idx" ON "E2EEOneTimePreKey"("userId", "isUsed");
CREATE INDEX "E2EEOneTimePreKey_keyId_idx" ON "E2EEOneTimePreKey"("keyId");

ALTER TABLE "E2EEOneTimePreKey" ADD CONSTRAINT "E2EEOneTimePreKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- E2EE sessions (per user-peer pair)
CREATE TABLE "E2EESession" (
    "id"                      TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"                  INTEGER      NOT NULL,
    "peerUserId"              INTEGER      NOT NULL,
    "rootKey"                 VARCHAR(200) NOT NULL,
    "sendingChainKey"         VARCHAR(200),
    "receivingChainKey"       VARCHAR(200),
    "sendMessageNumber"       INTEGER      NOT NULL DEFAULT 0,
    "receiveMessageNumber"    INTEGER      NOT NULL DEFAULT 0,
    "peerEphemeralPublicKey"  VARCHAR(100),
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2EESession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "E2EESession_userId_peerUserId_key" ON "E2EESession"("userId", "peerUserId");
CREATE INDEX "E2EESession_userId_peerUserId_idx" ON "E2EESession"("userId", "peerUserId");

ALTER TABLE "E2EESession" ADD CONSTRAINT "E2EESession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
