-- AlterTable: User — card skin inventory + equipped skin
ALTER TABLE "User" ADD COLUMN "equippedCardSkin" VARCHAR(20) NOT NULL DEFAULT 'classic';
ALTER TABLE "User" ADD COLUMN "ownedCardSkins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable: BusinessProfile — ad accent color override
ALTER TABLE "BusinessProfile" ADD COLUMN "adAccentColor" VARCHAR(7);
