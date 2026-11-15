-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertPrefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneAlertState" TEXT;

-- CreateTable
CREATE TABLE "PhoneAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "userId" TEXT,
    "phone" TEXT,
    "kind" TEXT NOT NULL,
    "customId" TEXT NOT NULL,
    "refId" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "m91Id" TEXT,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT,
    "note" TEXT,
    "answeredBy" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PhoneAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhoneAlert_status_kind_idx" ON "PhoneAlert"("status", "kind");

-- CreateIndex
CREATE INDEX "PhoneAlert_userId_createdAt_idx" ON "PhoneAlert"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneAlert_customId_status_idx" ON "PhoneAlert"("customId", "status");

