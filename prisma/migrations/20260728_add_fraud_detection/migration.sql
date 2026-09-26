-- FraudAssessment table for the fraud detection rules engine
CREATE TABLE "FraudAssessment" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"          INTEGER      NOT NULL,
    "transactionType" VARCHAR(50)  NOT NULL,
    "amountUsdc"      DECIMAL(20,8) NOT NULL DEFAULT 0,
    "riskScore"       INTEGER      NOT NULL DEFAULT 0,
    "triggeredRules"  VARCHAR(500) NOT NULL,
    "action"          VARCHAR(20)  NOT NULL DEFAULT 'FLAGGED',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FraudAssessment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FraudAssessment_userId_createdAt_idx" ON "FraudAssessment"("userId", "createdAt" DESC);
CREATE INDEX "FraudAssessment_action_createdAt_idx" ON "FraudAssessment"("action", "createdAt" DESC);
CREATE INDEX "FraudAssessment_riskScore_idx" ON "FraudAssessment"("riskScore" DESC);

ALTER TABLE "FraudAssessment" ADD CONSTRAINT "FraudAssessment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
