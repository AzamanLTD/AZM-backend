-- Migration: Remove QR Code Forge fields from unrelated models
-- Generated: 2026-07-24
-- QR Code Forge config is correctly stored in GlobalSettings only.

ALTER TABLE "TradeAccount" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "TradeAccount" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "AdminFeeProfile" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "AdminFeeProfile" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SystemMasterCrypto" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SystemMasterCrypto" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SystemHotWallet" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SystemHotWallet" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SystemFiatPool" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SystemFiatPool" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SystemProfitFees" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SystemProfitFees" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "Friendship" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "Friendship" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "PeerTransfer" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "PeerTransfer" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SavingsGoal" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SavingsGoal" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "VendorApplication" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "VendorApplication" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SmartEscrow" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SmartEscrow" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "EscrowDispute" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "EscrowDispute" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "CatalogSection" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "CatalogSection" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "BusinessOrder" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "BusinessOrder" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "BusinessVerificationDocument" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "BusinessVerificationDocument" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "Vault" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "Vault" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "GroupChat" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "GroupChat" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "VouchRecord" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "VouchRecord" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SusuGroup" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SusuGroup" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "SmartRoute" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "SmartRoute" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "AzmAuction" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "AzmAuction" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "AzmAuctionBid" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "AzmAuctionBid" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "TransitSeatMap" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "TransitSeatMap" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "BusinessEmployee" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "BusinessEmployee" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "Shift" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "Shift" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "ShiftSwap" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "ShiftSwap" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "TimeOffRequest" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "TimeOffRequest" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "PayrollRecord" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "PayrollRecord" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "HotelRoom" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "HotelRoom" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "HotelHousekeepingTask" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "HotelHousekeepingTask" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "KitchenOrder" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "KitchenOrder" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "DriverAssignment" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "DriverAssignment" DROP COLUMN IF EXISTS "qrLabel";

ALTER TABLE "VehicleMaintenance" DROP COLUMN IF EXISTS "qrRedirectUrl";
ALTER TABLE "VehicleMaintenance" DROP COLUMN IF EXISTS "qrLabel";
