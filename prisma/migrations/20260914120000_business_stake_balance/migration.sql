-- Business stake balance: reserveable security deposit businesses can post.
-- Purely additive, safe for populated tables. Business no-show penalties
-- claim against this column with a conditional guarded decrement
-- (WHERE stakeBalance >= penalty), so it can never go negative.
ALTER TABLE "BusinessProfile" ADD COLUMN "stakeBalance" DECIMAL(20,8) NOT NULL DEFAULT 0;
