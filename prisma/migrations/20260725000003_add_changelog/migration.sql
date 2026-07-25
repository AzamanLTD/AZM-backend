-- CreateTable
CREATE TABLE "Changelog" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'feature',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "imageUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Changelog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangelogView" (
    "id" SERIAL NOT NULL,
    "changelogId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangelogView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Changelog_publishedAt_idx" ON "Changelog"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ChangelogView_userId_idx" ON "ChangelogView"("userId");

-- CreateUnique
CREATE UNIQUE INDEX "ChangelogView_changelogId_userId_key" ON "ChangelogView"("changelogId", "userId");

-- AddForeignKey
ALTER TABLE "ChangelogView" ADD CONSTRAINT "ChangelogView_changelogId_fkey" FOREIGN KEY ("changelogId") REFERENCES "Changelog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelogView" ADD CONSTRAINT "ChangelogView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
