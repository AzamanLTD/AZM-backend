-- r16c P0-B: SmartRouteRun lifecycle honesty. SUCCESS may only mean the
-- provider accepted the dispatch. Runs whose dispatch reached a durable
-- state with an unprovable outcome park here instead of pretending.
ALTER TYPE "SmartRouteRunStatus" ADD VALUE 'AWAITING_RECONCILIATION';

-- r16c P0-B: single-winner EXECUTION lease — the MoMo executor claims the
-- run row before the canonical reservation so concurrent recoveries of the
-- same run defer to the lease owner instead of racing the reservation.
ALTER TYPE "SmartRouteRunStatus" ADD VALUE 'EXECUTING';
