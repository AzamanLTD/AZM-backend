-- Backlog/hotfix (2026-07-06): transitReminderWorker.js reads/writes
-- TransitBooking.reminderSentAt to track whether the pre-departure push
-- reminder has already been sent for a booking. The column never actually
-- existed on the model, which crashed the deploy the moment the worker
-- module was required (a stray uncommented TODO note in the worker file
-- was the proximate SyntaxError, but the real gap was this missing column).
ALTER TABLE "TransitBooking" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
