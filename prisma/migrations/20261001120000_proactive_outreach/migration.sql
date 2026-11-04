-- CreateEnum
CREATE TYPE "ProactiveTriggerType" AS ENUM ('UPCOMING_EVENT', 'REMINDER', 'FOLLOW_UP', 'GOAL_CHECK_IN');

-- CreateEnum
CREATE TYPE "ProactiveTriggerStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProactiveInteractionStatus" AS ENUM ('SENT', 'OPENED', 'RESPONDED', 'DISMISSED', 'FAILED');

-- CreateTable
CREATE TABLE "OutreachDevice" (
    "id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "proactiveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "initiationFrequency" "InitiationFrequency" NOT NULL DEFAULT 'SOMETIMES',
    "quietHoursStart" INTEGER NOT NULL DEFAULT 1320,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 480,
    "maxDailyProactive" INTEGER NOT NULL DEFAULT 1,
    "allowedMuseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pushEndpoint" TEXT,
    "pushP256dh" TEXT,
    "pushAuth" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProactiveTrigger" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "museId" TEXT NOT NULL,
    "museName" TEXT NOT NULL,
    "type" "ProactiveTriggerType" NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceMemoryId" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ProactiveTriggerStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProactiveTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProactiveInteraction" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "museId" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "pushed" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProactiveInteractionStatus" NOT NULL DEFAULT 'SENT',

    CONSTRAINT "ProactiveInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProactiveTrigger_status_scheduledFor_idx" ON "ProactiveTrigger"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ProactiveTrigger_deviceId_museId_idx" ON "ProactiveTrigger"("deviceId", "museId");

-- CreateIndex
CREATE UNIQUE INDEX "ProactiveTrigger_deviceId_sourceMemoryId_key" ON "ProactiveTrigger"("deviceId", "sourceMemoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProactiveInteraction_triggerId_key" ON "ProactiveInteraction"("triggerId");

-- CreateIndex
CREATE INDEX "ProactiveInteraction_deviceId_sentAt_idx" ON "ProactiveInteraction"("deviceId", "sentAt");

-- AddForeignKey
ALTER TABLE "ProactiveTrigger" ADD CONSTRAINT "ProactiveTrigger_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "OutreachDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProactiveInteraction" ADD CONSTRAINT "ProactiveInteraction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "OutreachDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProactiveInteraction" ADD CONSTRAINT "ProactiveInteraction_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "ProactiveTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

