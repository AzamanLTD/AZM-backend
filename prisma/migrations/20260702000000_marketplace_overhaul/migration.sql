-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewSourceType" ADD VALUE 'RESERVATION';
ALTER TYPE "ReviewSourceType" ADD VALUE 'TRANSIT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BizNotifType" ADD VALUE 'RESERVATION_NEW';
ALTER TYPE "BizNotifType" ADD VALUE 'RESERVATION_CONFIRMED';
ALTER TYPE "BizNotifType" ADD VALUE 'RESERVATION_CHECKED_IN';
ALTER TYPE "BizNotifType" ADD VALUE 'RESERVATION_NO_SHOW';
ALTER TYPE "BizNotifType" ADD VALUE 'TRANSIT_BOOKING_NEW';
ALTER TYPE "BizNotifType" ADD VALUE 'TRANSIT_NO_SHOW';
ALTER TYPE "BizNotifType" ADD VALUE 'INVOICE_SENT';

-- AlterTable
ALTER TABLE "BusinessReview" ADD COLUMN     "photoUrls" JSONB,
ADD COLUMN     "reservationId" TEXT,
ADD COLUMN     "transitBookingId" TEXT;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "noShowPenaltyPct" DECIMAL(5,4),
ADD COLUMN     "noShowPenaltyUsdc" DECIMAL(20,8),
ADD COLUMN     "penaltyAmountUsdc" DECIMAL(20,8),
ADD COLUMN     "penaltyChargedAt" TIMESTAMP(3),
ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "TransitBooking" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "escrowId" TEXT,
ADD COLUMN     "noShowPenaltyPct" DECIMAL(5,4),
ADD COLUMN     "noShowPenaltyUsdc" DECIMAL(20,8),
ADD COLUMN     "penaltyAmountUsdc" DECIMAL(20,8),
ADD COLUMN     "penaltyChargedAt" TIMESTAMP(3),
ADD COLUMN     "ticketId" TEXT,
ADD COLUMN     "tripId" TEXT;

-- CreateTable
CREATE TABLE "TransitTrip" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "routeName" VARCHAR(200) NOT NULL,
    "origin" VARCHAR(255) NOT NULL,
    "destination" VARCHAR(255) NOT NULL,
    "departureAt" TIMESTAMP(3) NOT NULL,
    "arrivalAt" TIMESTAMP(3),
    "fareUsdc" DECIMAL(20,8) NOT NULL,
    "availableSeats" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransitTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransitSeatMap" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "layout" JSONB NOT NULL,
    "rows" INTEGER NOT NULL,
    "cols" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransitSeatMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransitBookingSeat" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "seatId" VARCHAR(10) NOT NULL,
    "passengerName" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransitBookingSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransitTrip_businessProfileId_departureAt_idx" ON "TransitTrip"("businessProfileId", "departureAt");

-- CreateIndex
CREATE INDEX "TransitTrip_vehicleId_departureAt_idx" ON "TransitTrip"("vehicleId", "departureAt");

-- CreateIndex
CREATE INDEX "TransitTrip_status_idx" ON "TransitTrip"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransitSeatMap_vehicleId_key" ON "TransitSeatMap"("vehicleId");

-- CreateIndex
CREATE INDEX "TransitBookingSeat_bookingId_idx" ON "TransitBookingSeat"("bookingId");

-- CreateIndex
CREATE INDEX "TransitBookingSeat_tripId_idx" ON "TransitBookingSeat"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitBookingSeat_tripId_seatId_key" ON "TransitBookingSeat"("tripId", "seatId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessReview_reservationId_key" ON "BusinessReview"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessReview_transitBookingId_key" ON "BusinessReview"("transitBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_ticketId_key" ON "Reservation"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitBooking_escrowId_key" ON "TransitBooking"("escrowId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitBooking_ticketId_key" ON "TransitBooking"("ticketId");

-- AddForeignKey
ALTER TABLE "BusinessReview" ADD CONSTRAINT "BusinessReview_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessReview" ADD CONSTRAINT "BusinessReview_transitBookingId_fkey" FOREIGN KEY ("transitBookingId") REFERENCES "TransitBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitTrip" ADD CONSTRAINT "TransitTrip_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitTrip" ADD CONSTRAINT "TransitTrip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransitVehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitSeatMap" ADD CONSTRAINT "TransitSeatMap_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransitVehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitBookingSeat" ADD CONSTRAINT "TransitBookingSeat_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "TransitBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitBookingSeat" ADD CONSTRAINT "TransitBookingSeat_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransitTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitBooking" ADD CONSTRAINT "TransitBooking_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "SmartEscrow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitBooking" ADD CONSTRAINT "TransitBooking_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitBooking" ADD CONSTRAINT "TransitBooking_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransitTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
