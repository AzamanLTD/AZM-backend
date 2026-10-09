-- r272 finding 3 (audit #271 residual): make the declared RBAC approval
-- tiers authoritative at the withdrawal-approval boundary.
--
-- approveWithdrawal now CONSUMES an APPROVED AdminApprovalRequest
-- (type = 'WITHDRAWAL', entityId = the withdrawal id) atomically with the
-- PENDING -> APPROVED flip whenever the amount's tier requires more than
-- one approval. The APPROVED -> EXECUTED transition is the single-use
-- consumption proof (exactly-once enforcement); executedAt records when
-- the enforcement point consumed the quorum, for the audit trail.
ALTER TABLE "AdminApprovalRequest" ADD COLUMN "executedAt" TIMESTAMP(3);
