-- Phase 2.2: Prevent Ticket cascade-delete from destroying SmartEscrow
-- financial audit trail.
ALTER TABLE "SmartEscrow" DROP CONSTRAINT IF EXISTS "SmartEscrow_ticketId_fkey";
ALTER TABLE "SmartEscrow" ADD CONSTRAINT "SmartEscrow_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT;
