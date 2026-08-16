-- CreateTable: GovernanceProposal
CREATE TABLE "GovernanceProposal" (
    "id" SERIAL NOT NULL,
    "proposerId" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "targetContract" VARCHAR(100),
    "callData" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "forVotes" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "againstVotes" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "abstainVotes" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "totalVotingPower" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "votingStartsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "votingEndsAt" TIMESTAMP(3) NOT NULL,
    "executionReadyAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "executedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GovernanceProposal_status_createdAt_idx" ON "GovernanceProposal"("status", "createdAt" DESC);
CREATE INDEX "GovernanceProposal_proposerId_idx" ON "GovernanceProposal"("proposerId");

-- CreateTable: GovernanceVote
CREATE TABLE "GovernanceVote" (
    "id" SERIAL NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vote" VARCHAR(10) NOT NULL,
    "votingPower" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GovernanceVote_proposalId_userId_key" ON "GovernanceVote"("proposalId", "userId");
CREATE INDEX "GovernanceVote_proposalId_idx" ON "GovernanceVote"("proposalId");
CREATE INDEX "GovernanceVote_userId_idx" ON "GovernanceVote"("userId");

-- AddForeignKey
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_proposerId_fkey"
    FOREIGN KEY ("proposerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_executedById_fkey"
    FOREIGN KEY ("executedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GovernanceVote" ADD CONSTRAINT "GovernanceVote_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "GovernanceProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceVote" ADD CONSTRAINT "GovernanceVote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
