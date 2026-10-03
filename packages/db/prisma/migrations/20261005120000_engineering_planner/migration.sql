-- CreateEnum
CREATE TYPE "EngineeringPlanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "EngineeringTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "scope" TEXT,
    "constraints" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineeringTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineeringPlan" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" "EngineeringPlanStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "plan" JSONB,
    "validation" JSONB,
    "validationStatus" TEXT,
    "confidence" DOUBLE PRECISION,
    "contextStats" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER,
    "failureReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EngineeringPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineeringPlanEvidence" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "symbol" TEXT,
    "line" INTEGER,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "EngineeringPlanEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EngineeringTask_userId_createdAt_idx" ON "EngineeringTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EngineeringTask_analysisId_createdAt_idx" ON "EngineeringTask"("analysisId", "createdAt");

-- CreateIndex
CREATE INDEX "EngineeringPlan_taskId_createdAt_idx" ON "EngineeringPlan"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EngineeringPlanEvidence_planId_ref_key" ON "EngineeringPlanEvidence"("planId", "ref");

-- AddForeignKey
ALTER TABLE "EngineeringTask" ADD CONSTRAINT "EngineeringTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringTask" ADD CONSTRAINT "EngineeringTask_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringPlan" ADD CONSTRAINT "EngineeringPlan_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "EngineeringTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringPlanEvidence" ADD CONSTRAINT "EngineeringPlanEvidence_planId_fkey" FOREIGN KEY ("planId") REFERENCES "EngineeringPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
