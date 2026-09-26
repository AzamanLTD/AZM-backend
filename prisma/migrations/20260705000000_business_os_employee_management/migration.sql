-- CreateTable: BusinessEmployee
CREATE TABLE "BusinessEmployee" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "EmployeeRole" NOT NULL DEFAULT 'STAFF',
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" VARCHAR(100),
    "department" VARCHAR(100),
    "payrollType" "PayrollType" NOT NULL DEFAULT 'SALARY',
    "salaryAmount" DECIMAL(20,8),
    "hourlyRate" DECIMAL(20,8),
    "paymentPreference" "EmployeePaymentPreference" NOT NULL DEFAULT 'AZAMAN_BALANCE',
    "smartRouteId" TEXT,
    "permissions" TEXT[],
    "totalShifts" INTEGER NOT NULL DEFAULT 0,
    "totalHours" DECIMAL(10,2) NOT NULL DEFAULT 0.0,
    "lateCount" INTEGER NOT NULL DEFAULT 0,
    "noShowCount" INTEGER NOT NULL DEFAULT 0,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "accruedWages" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "withdrawnEarly" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "ewaEligible" BOOLEAN NOT NULL DEFAULT true,
    "hireDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminationDate" TIMESTAMP(3),
    "emergencyContact" JSONB,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Shift
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "locationId" TEXT,
    "shiftDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 30,
    "status" "ShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
    "clockInTime" TIMESTAMP(3),
    "clockOutTime" TIMESTAMP(3),
    "actualMinutes" INTEGER,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "rotationId" TEXT,
    "shiftLabel" VARCHAR(50),
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ShiftSwap
CREATE TABLE "ShiftSwap" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "requestingShiftId" TEXT NOT NULL,
    "claimingShiftId" TEXT,
    "requestingEmployeeId" TEXT NOT NULL,
    "claimingEmployeeId" TEXT,
    "requestingUserId" INTEGER NOT NULL,
    "claimingUserId" INTEGER,
    "status" "ShiftSwapStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(500),
    "managerNote" VARCHAR(500),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShiftSwap_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TimeOffRequest
CREATE TABLE "TimeOffRequest" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "TimeOffType" NOT NULL,
    "status" "TimeOffStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(500),
    "managerNote" VARCHAR(500),
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TimeOffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PayrollRecord
CREATE TABLE "PayrollRecord" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "payrollType" "PayrollType" NOT NULL,
    "grossAmount" DECIMAL(20,8) NOT NULL,
    "netAmount" DECIMAL(20,8) NOT NULL,
    "baseAmount" DECIMAL(20,8) NOT NULL,
    "overtimeAmount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "bonusAmount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "tipsAmount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "deductionAmount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "ewaDeduction" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "taxAmount" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "totalHours" DECIMAL(10,2) NOT NULL DEFAULT 0.0,
    "overtimeHours" DECIMAL(10,2) NOT NULL DEFAULT 0.0,
    "status" "PayrollStatus" NOT NULL DEFAULT 'PENDING',
    "smartRouteId" TEXT,
    "transactionHash" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" VARCHAR(500),
    "breakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BusinessLedgerEntry
CREATE TABLE "BusinessLedgerEntry" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "amountGhs" DECIMAL(20,8),
    "sourceType" VARCHAR(50),
    "sourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EmployeeFeedback
CREATE TABLE "EmployeeFeedback" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "giverEmployeeId" TEXT NOT NULL,
    "receiverEmployeeId" TEXT NOT NULL,
    "givenByUserId" INTEGER NOT NULL,
    "receivedByUserId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "tags" "FeedbackTag"[],
    "comment" VARCHAR(500),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HotelRoom
CREATE TABLE "HotelRoom" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "locationId" TEXT,
    "roomNumber" VARCHAR(20) NOT NULL,
    "roomType" VARCHAR(50) NOT NULL,
    "floor" INTEGER,
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "bedConfig" VARCHAR(50),
    "status" "RoomStatus" NOT NULL DEFAULT 'AVAILABLE',
    "basePriceUsdc" DECIMAL(20,8) NOT NULL,
    "weekendPriceUsdc" DECIMAL(20,8),
    "amenities" TEXT[],
    "imageUrls" TEXT[],
    "currentReservationId" TEXT,
    "checkedInAt" TIMESTAMP(3),
    "checkoutDueAt" TIMESTAMP(3),
    "lastInspectedAt" TIMESTAMP(3),
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HotelRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HotelHousekeepingTask
CREATE TABLE "HotelHousekeepingTask" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "employeeId" TEXT,
    "userId" INTEGER,
    "status" "HousekeepingStatus" NOT NULL DEFAULT 'PENDING',
    "taskType" VARCHAR(50) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "description" VARCHAR(500),
    "beforePhotoUrl" TEXT,
    "afterPhotoUrl" TEXT,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "inspectedAt" TIMESTAMP(3),
    "inspectionPassed" BOOLEAN,
    "inspectionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HotelHousekeepingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable: KitchenOrder
CREATE TABLE "KitchenOrder" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "locationId" TEXT,
    "businessOrderId" TEXT,
    "ticketNumber" INTEGER NOT NULL,
    "tableNumber" VARCHAR(20),
    "serverName" VARCHAR(100),
    "status" "KitchenOrderStatus" NOT NULL DEFAULT 'NEW',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "station" VARCHAR(50),
    "prepTimeMinutes" INTEGER,
    "allergyAlerts" TEXT[],
    "specialInstructions" VARCHAR(500),
    "isRush" BOOLEAN NOT NULL DEFAULT false,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KitchenOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable: KitchenOrderItem
CREATE TABLE "KitchenOrderItem" (
    "id" TEXT NOT NULL,
    "kitchenOrderId" TEXT NOT NULL,
    "productId" TEXT,
    "name" VARCHAR(200) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "modifiers" TEXT[],
    "station" VARCHAR(50),
    "status" "KitchenOrderStatus" NOT NULL DEFAULT 'NEW',
    "bumpedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KitchenOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DriverAssignment
CREATE TABLE "DriverAssignment" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "tripId" TEXT,
    "vehicleId" TEXT,
    "employeeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "assignmentDate" TIMESTAMP(3) NOT NULL,
    "role" VARCHAR(50) NOT NULL,
    "shiftLabel" VARCHAR(50),
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "checkedInAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "routeName" VARCHAR(200),
    "departureTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DriverAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: VehicleMaintenance
CREATE TABLE "VehicleMaintenance" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" "MaintenanceType" NOT NULL DEFAULT 'SCHEDULED',
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "completedDate" TIMESTAMP(3),
    "description" VARCHAR(500) NOT NULL,
    "cost" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "costGhs" DECIMAL(20,8),
    "serviceProvider" VARCHAR(200),
    "odometerAtService" INTEGER,
    "nextServiceDue" INTEGER,
    "partsCost" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "laborCost" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VehicleMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateEnums
CREATE TYPE "EmployeeRole" AS ENUM ('OWNER', 'MANAGER', 'SUPERVISOR', 'STAFF', 'DRIVER', 'HOUSEKEEPER', 'WAITER', 'CHEF', 'RECEPTIONIST', 'CONCIERGE', 'SECURITY');
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED', 'ON_LEAVE');
CREATE TYPE "EmployeePaymentPreference" AS ENUM ('AZAMAN_BALANCE', 'MOMO', 'WALLET', 'SPLIT');
CREATE TYPE "ShiftStatus" AS ENUM ('SCHEDULED', 'CLOCKED_IN', 'CLOCKED_OUT', 'NO_SHOW', 'LATE');
CREATE TYPE "ShiftSwapStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "TimeOffType" AS ENUM ('SICK', 'VACATION', 'PERSONAL', 'EMERGENCY', 'UNPAID');
CREATE TYPE "TimeOffStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "PayrollStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'PARTIAL');
CREATE TYPE "PayrollType" AS ENUM ('SALARY', 'HOURLY', 'PIECE_RATE');
CREATE TYPE "LedgerEntryType" AS ENUM ('INCOME', 'EXPENSE', 'PAYROLL', 'TAX', 'REFUND', 'PENALTY', 'AD_SPEND', 'MAINTENANCE', 'SUPPLIES', 'UTILITIES', 'RENT', 'OTHER');
CREATE TYPE "FeedbackTag" AS ENUM ('PUNCTUAL', 'TEAM_PLAYER', 'HARD_WORKING', 'RELIABLE', 'LEADERSHIP', 'NEEDS_IMPROVEMENT', 'LATE', 'UNRELIABLE');
CREATE TYPE "HousekeepingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'INSPECTED', 'FAILED');
CREATE TYPE "RoomStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'DIRTY', 'CLEANING', 'MAINTENANCE', 'RESERVED');
CREATE TYPE "KitchenOrderStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
CREATE TYPE "MaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE');
CREATE TYPE "MaintenanceType" AS ENUM ('SCHEDULED', 'UNSCHEDULED', 'EMERGENCY');

-- CreateIndexes
CREATE UNIQUE INDEX "BusinessEmployee_businessProfileId_userId_key" ON "BusinessEmployee"("businessProfileId", "userId");
CREATE INDEX "BusinessEmployee_businessProfileId_status_idx" ON "BusinessEmployee"("businessProfileId", "status");
CREATE INDEX "BusinessEmployee_userId_idx" ON "BusinessEmployee"("userId");
CREATE INDEX "BusinessEmployee_businessProfileId_role_idx" ON "BusinessEmployee"("businessProfileId", "role");

CREATE INDEX "Shift_businessProfileId_shiftDate_idx" ON "Shift"("businessProfileId", "shiftDate");
CREATE INDEX "Shift_employeeId_shiftDate_idx" ON "Shift"("employeeId", "shiftDate");
CREATE INDEX "Shift_userId_shiftDate_idx" ON "Shift"("userId", "shiftDate");
CREATE INDEX "Shift_status_idx" ON "Shift"("status");
CREATE INDEX "Shift_businessProfileId_status_shiftDate_idx" ON "Shift"("businessProfileId", "status", "shiftDate");

CREATE INDEX "ShiftSwap_businessProfileId_status_idx" ON "ShiftSwap"("businessProfileId", "status");
CREATE INDEX "ShiftSwap_requestingEmployeeId_idx" ON "ShiftSwap"("requestingEmployeeId");
CREATE INDEX "ShiftSwap_claimingEmployeeId_idx" ON "ShiftSwap"("claimingEmployeeId");

CREATE INDEX "TimeOffRequest_businessProfileId_status_idx" ON "TimeOffRequest"("businessProfileId", "status");
CREATE INDEX "TimeOffRequest_employeeId_idx" ON "TimeOffRequest"("employeeId");
CREATE INDEX "TimeOffRequest_userId_status_idx" ON "TimeOffRequest"("userId", "status");

CREATE UNIQUE INDEX "PayrollRecord_employeeId_period_key" ON "PayrollRecord"("employeeId", "period");
CREATE INDEX "PayrollRecord_businessProfileId_period_idx" ON "PayrollRecord"("businessProfileId", "period");
CREATE INDEX "PayrollRecord_employeeId_period_idx" ON "PayrollRecord"("employeeId", "period");
CREATE INDEX "PayrollRecord_status_idx" ON "PayrollRecord"("status");

CREATE INDEX "BusinessLedgerEntry_businessProfileId_type_idx" ON "BusinessLedgerEntry"("businessProfileId", "type");
CREATE INDEX "BusinessLedgerEntry_businessProfileId_createdAt_idx" ON "BusinessLedgerEntry"("businessProfileId", "createdAt");
CREATE INDEX "BusinessLedgerEntry_businessProfileId_type_createdAt_idx" ON "BusinessLedgerEntry"("businessProfileId", "type", "createdAt");
CREATE INDEX "BusinessLedgerEntry_sourceType_sourceId_idx" ON "BusinessLedgerEntry"("sourceType", "sourceId");

CREATE INDEX "EmployeeFeedback_receiverEmployeeId_idx" ON "EmployeeFeedback"("receiverEmployeeId");
CREATE INDEX "EmployeeFeedback_businessProfileId_createdAt_idx" ON "EmployeeFeedback"("businessProfileId", "createdAt");

CREATE UNIQUE INDEX "HotelRoom_businessProfileId_roomNumber_key" ON "HotelRoom"("businessProfileId", "roomNumber");
CREATE INDEX "HotelRoom_businessProfileId_status_idx" ON "HotelRoom"("businessProfileId", "status");
CREATE INDEX "HotelRoom_businessProfileId_roomType_idx" ON "HotelRoom"("businessProfileId", "roomType");
CREATE INDEX "HotelRoom_locationId_status_idx" ON "HotelRoom"("locationId", "status");

CREATE INDEX "HotelHousekeepingTask_businessProfileId_status_idx" ON "HotelHousekeepingTask"("businessProfileId", "status");
CREATE INDEX "HotelHousekeepingTask_roomId_status_idx" ON "HotelHousekeepingTask"("roomId", "status");
CREATE INDEX "HotelHousekeepingTask_employeeId_status_idx" ON "HotelHousekeepingTask"("employeeId", "status");

CREATE INDEX "KitchenOrder_businessProfileId_status_idx" ON "KitchenOrder"("businessProfileId", "status");
CREATE INDEX "KitchenOrder_locationId_status_idx" ON "KitchenOrder"("locationId", "status");
CREATE INDEX "KitchenOrder_station_status_idx" ON "KitchenOrder"("station", "status");
CREATE UNIQUE INDEX "KitchenOrder_businessOrderId_key" ON "KitchenOrder"("businessOrderId");

CREATE INDEX "KitchenOrderItem_kitchenOrderId_idx" ON "KitchenOrderItem"("kitchenOrderId");
CREATE INDEX "KitchenOrderItem_station_status_idx" ON "KitchenOrderItem"("station", "status");

CREATE INDEX "DriverAssignment_businessProfileId_assignmentDate_idx" ON "DriverAssignment"("businessProfileId", "assignmentDate");
CREATE INDEX "DriverAssignment_employeeId_assignmentDate_idx" ON "DriverAssignment"("employeeId", "assignmentDate");
CREATE INDEX "DriverAssignment_userId_assignmentDate_idx" ON "DriverAssignment"("userId", "assignmentDate");
CREATE INDEX "DriverAssignment_vehicleId_idx" ON "DriverAssignment"("vehicleId");

CREATE INDEX "VehicleMaintenance_businessProfileId_status_idx" ON "VehicleMaintenance"("businessProfileId", "status");
CREATE INDEX "VehicleMaintenance_vehicleId_status_idx" ON "VehicleMaintenance"("vehicleId", "status");
CREATE INDEX "VehicleMaintenance_vehicleId_scheduledDate_idx" ON "VehicleMaintenance"("vehicleId", "scheduledDate");

-- AddForeignKey
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_requestingShiftId_fkey" FOREIGN KEY ("requestingShiftId") REFERENCES "Shift"("id") ON DELETE CASCADE;
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_claimingShiftId_fkey" FOREIGN KEY ("claimingShiftId") REFERENCES "Shift"("id");
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_requestingEmployeeId_fkey" FOREIGN KEY ("requestingEmployeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_claimingEmployeeId_fkey" FOREIGN KEY ("claimingEmployeeId") REFERENCES "BusinessEmployee"("id");
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_requestingUserId_fkey" FOREIGN KEY ("requestingUserId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "ShiftSwap" ADD CONSTRAINT "ShiftSwap_claimingUserId_fkey" FOREIGN KEY ("claimingUserId") REFERENCES "User"("id");

ALTER TABLE "TimeOffRequest" ADD CONSTRAINT "TimeOffRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "TimeOffRequest" ADD CONSTRAINT "TimeOffRequest_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "TimeOffRequest" ADD CONSTRAINT "TimeOffRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT "BusinessLedgerEntry_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;

ALTER TABLE "EmployeeFeedback" ADD CONSTRAINT "EmployeeFeedback_giverEmployeeId_fkey" FOREIGN KEY ("giverEmployeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "EmployeeFeedback" ADD CONSTRAINT "EmployeeFeedback_receiverEmployeeId_fkey" FOREIGN KEY ("receiverEmployeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "EmployeeFeedback" ADD CONSTRAINT "EmployeeFeedback_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "EmployeeFeedback" ADD CONSTRAINT "EmployeeFeedback_givenByUserId_fkey" FOREIGN KEY ("givenByUserId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "HotelRoom" ADD CONSTRAINT "HotelRoom_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "HotelRoom" ADD CONSTRAINT "HotelRoom_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id");

ALTER TABLE "HotelHousekeepingTask" ADD CONSTRAINT "HotelHousekeepingTask_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "HotelHousekeepingTask" ADD CONSTRAINT "HotelHousekeepingTask_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HotelRoom"("id") ON DELETE CASCADE;
ALTER TABLE "HotelHousekeepingTask" ADD CONSTRAINT "HotelHousekeepingTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id");
ALTER TABLE "HotelHousekeepingTask" ADD CONSTRAINT "HotelHousekeepingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id");

ALTER TABLE "KitchenOrder" ADD CONSTRAINT "KitchenOrder_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "KitchenOrder" ADD CONSTRAINT "KitchenOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id");
ALTER TABLE "KitchenOrder" ADD CONSTRAINT "KitchenOrder_businessOrderId_fkey" FOREIGN KEY ("businessOrderId") REFERENCES "BusinessOrder"("id");
ALTER TABLE "KitchenOrder" ADD CONSTRAINT "KitchenOrder_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id");

ALTER TABLE "KitchenOrderItem" ADD CONSTRAINT "KitchenOrderItem_kitchenOrderId_fkey" FOREIGN KEY ("kitchenOrderId") REFERENCES "KitchenOrder"("id") ON DELETE CASCADE;
ALTER TABLE "KitchenOrderItem" ADD CONSTRAINT "KitchenOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BusinessProduct"("id");

ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransitTrip"("id");
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransitVehicle"("id");
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "BusinessEmployee"("id") ON DELETE CASCADE;
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "VehicleMaintenance" ADD CONSTRAINT "VehicleMaintenance_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;
ALTER TABLE "VehicleMaintenance" ADD CONSTRAINT "VehicleMaintenance_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "TransitVehicle"("id") ON DELETE CASCADE;
