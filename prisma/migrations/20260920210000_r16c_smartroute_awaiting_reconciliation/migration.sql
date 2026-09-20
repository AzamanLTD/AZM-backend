-- r16c P0-B: SmartRouteRun lifecycle honesty. SUCCESS may only mean the
-- provider accepted the dispatch. Runs whose dispatch reached a durable
-- state with an unprovable outcome park here instead of pretending.
ALTER TYPE "SmartRouteRunStatus" ADD VALUE 'AWAITING_RECONCILIATION';
