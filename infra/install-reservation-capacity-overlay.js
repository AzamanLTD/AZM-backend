#!/usr/bin/env node
// Reservation-capacity authority: PostgreSQL owns all active interval claims.
// Idempotent installer for db-push managed production. Install before traffic.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ddl = [
`ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "clientRequestKey" VARCHAR(128);`,
`ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "requestFingerprint" VARCHAR(64);`,
`CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_businessProfileId_customerId_clientRequestKey_key" ON "Reservation"("businessProfileId", "customerId", "clientRequestKey");`,
`CREATE OR REPLACE FUNCTION azm_reservation_capacity_claim() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  room_status text;
  room_location text;
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'CONFIRMED', 'CHECKED_IN') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
     AND OLD."businessProfileId" IS NOT DISTINCT FROM NEW."businessProfileId"
     AND OLD."locationId" IS NOT DISTINCT FROM NEW."locationId"
     AND OLD."serviceItemId" IS NOT DISTINCT FROM NEW."serviceItemId"
     AND OLD."startDatetime" IS NOT DISTINCT FROM NEW."startDatetime"
     AND OLD."endDatetime" IS NOT DISTINCT FROM NEW."endDatetime" THEN RETURN NEW; END IF;
  IF NEW."startDatetime" IS NULL OR NEW."endDatetime" IS NULL OR NEW."startDatetime" >= NEW."endDatetime" THEN
    RAISE EXCEPTION 'Invalid reservation interval' USING ERRCODE = '23514', CONSTRAINT = 'reservation_interval_valid';
  END IF;
  -- Every writer (including direct Prisma writes and multiple Node containers) takes
  -- one transaction-scoped business lock before evaluating committed availability.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."businessProfileId", 91731));
  IF EXISTS (
    SELECT 1 FROM "Reservation" r
    WHERE r."businessProfileId" = NEW."businessProfileId"
      AND r."id" IS DISTINCT FROM NEW."id"
      AND r."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
      AND r."startDatetime" < NEW."endDatetime" AND r."endDatetime" > NEW."startDatetime"
      AND (NEW."locationId" IS NULL OR r."locationId" IS NULL OR r."locationId" = NEW."locationId"
           OR (NEW."serviceItemId" = r."serviceItemId" AND EXISTS (
             SELECT 1 FROM "HotelRoom" h WHERE h."id" = NEW."serviceItemId"
               AND h."businessProfileId" = NEW."businessProfileId")))
      AND (NEW."serviceItemId" IS NULL OR r."serviceItemId" IS NULL OR r."serviceItemId" = NEW."serviceItemId")
  ) THEN
    RAISE EXCEPTION 'Reservation interval already claimed' USING ERRCODE = '23505', CONSTRAINT = 'reservation_capacity_claim';
  END IF;
  SELECT hr."status"::text, hr."locationId" INTO room_status, room_location FROM "HotelRoom" hr
    WHERE hr."id" = NEW."serviceItemId" AND hr."businessProfileId" = NEW."businessProfileId";
  IF room_status IS NOT NULL THEN
    IF NEW."locationId" IS NOT NULL AND NEW."locationId" IS DISTINCT FROM room_location THEN
      RAISE EXCEPTION 'Room is not at the requested location' USING ERRCODE = '23505', CONSTRAINT = 'reservation_room_location';
    END IF;
    IF room_status <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'Hotel room is unavailable' USING ERRCODE = '23505', CONSTRAINT = 'reservation_room_unavailable';
    END IF;
    IF EXISTS (SELECT 1 FROM "HotelRoomBlock" b WHERE b."roomId" = NEW."serviceItemId"
               AND b."startDate" < NEW."endDatetime" AND b."endDate" > NEW."startDatetime") THEN
      RAISE EXCEPTION 'Hotel room is blocked' USING ERRCODE = '23505', CONSTRAINT = 'reservation_room_blocked';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;`,
`CREATE OR REPLACE FUNCTION azm_room_block_claim() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE biz text;
BEGIN
  SELECT hr."businessProfileId" INTO biz FROM "HotelRoom" hr WHERE hr."id" = NEW."roomId";
  IF biz IS NULL THEN RETURN NEW; END IF;
  IF NEW."startDate" >= NEW."endDate" THEN
    RAISE EXCEPTION 'Invalid room block interval' USING ERRCODE = '23514', CONSTRAINT = 'room_block_interval_valid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(biz, 91731));
  IF EXISTS (SELECT 1 FROM "Reservation" r WHERE r."businessProfileId" = biz
             AND r."serviceItemId" = NEW."roomId"
             AND r."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
             AND r."startDatetime" < NEW."endDate" AND r."endDatetime" > NEW."startDate") THEN
    RAISE EXCEPTION 'Room block conflicts with a booking' USING ERRCODE = '23505', CONSTRAINT = 'room_block_booking_conflict';
  END IF;
  RETURN NEW;
END $fn$;`,
`CREATE OR REPLACE FUNCTION azm_room_status_claim() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Housekeeping/occupancy are transient states and may coexist with future bookings.
  -- MAINTENANCE is indefinite, so it cannot supersede any committed future booking.
  IF NEW."status" <> 'MAINTENANCE' OR NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."businessProfileId", 91731));
  IF EXISTS (SELECT 1 FROM "Reservation" r WHERE r."businessProfileId" = NEW."businessProfileId"
             AND r."serviceItemId" = NEW."id"
             AND r."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
             AND r."endDatetime" > CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'Room has active bookings' USING ERRCODE = '23505', CONSTRAINT = 'room_status_booking_conflict';
  END IF;
  RETURN NEW;
END $fn$;`,
`DROP TRIGGER IF EXISTS azm_reservation_capacity_trigger ON "Reservation";`,
`CREATE TRIGGER azm_reservation_capacity_trigger BEFORE INSERT OR UPDATE OF "status", "businessProfileId", "locationId", "serviceItemId", "startDatetime", "endDatetime" ON "Reservation" FOR EACH ROW EXECUTE FUNCTION azm_reservation_capacity_claim();`,
`DROP TRIGGER IF EXISTS azm_room_block_trigger ON "HotelRoomBlock";`,
`CREATE TRIGGER azm_room_block_trigger BEFORE INSERT OR UPDATE OF "roomId", "startDate", "endDate" ON "HotelRoomBlock" FOR EACH ROW EXECUTE FUNCTION azm_room_block_claim();`,
`DROP TRIGGER IF EXISTS azm_room_status_trigger ON "HotelRoom";`,
`CREATE TRIGGER azm_room_status_trigger BEFORE UPDATE OF "status" ON "HotelRoom" FOR EACH ROW EXECUTE FUNCTION azm_room_status_claim();`,
];

async function install() {
  // DDL and trigger replacement are one atomic change. A release must never
  // expose a brief interval with the old triggers dropped but new ones absent.
  await prisma.$transaction(async tx => {
    // Freeze legacy writers during preflight and trigger replacement. Existing
    // overlaps must be resolved explicitly; installing a trigger only guards
    // future writes and must not masquerade as a historical invariant.
    await tx.$executeRawUnsafe('LOCK TABLE "Reservation", "HotelRoom", "HotelRoomBlock" IN SHARE ROW EXCLUSIVE MODE');
    const priorConflicts = await tx.$queryRawUnsafe(`SELECT a."id" AS first_id, b."id" AS second_id
      FROM "Reservation" a JOIN "Reservation" b
        ON a."id" < b."id" AND a."businessProfileId" = b."businessProfileId"
       AND a."startDatetime" < b."endDatetime" AND a."endDatetime" > b."startDatetime"
       AND (a."serviceItemId" IS NULL OR b."serviceItemId" IS NULL OR a."serviceItemId" = b."serviceItemId")
       AND (a."locationId" IS NULL OR b."locationId" IS NULL OR a."locationId" = b."locationId"
            OR (a."serviceItemId" = b."serviceItemId" AND EXISTS (
              SELECT 1 FROM "HotelRoom" h WHERE h."id" = a."serviceItemId"
                AND h."businessProfileId" = a."businessProfileId")))
      WHERE a."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN') LIMIT 1`);
    if (priorConflicts.length) {
      const { first_id, second_id } = priorConflicts[0];
      throw new Error(`Existing overlapping active reservations ${first_id} / ${second_id}; reconcile them before enabling capacity authority.`);
    }
    for (const statement of ddl) await tx.$executeRawUnsafe(statement);
  }, { timeout: 120000 });
  console.log('Reservation capacity authority installed.');
}
if (require.main === module) install().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => prisma.$disconnect());
module.exports = { install };
