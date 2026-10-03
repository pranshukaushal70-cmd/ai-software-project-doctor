-- CreateEnum
CREATE TYPE "EngineeringRunStatus" AS ENUM ('QUEUED', 'MATERIALIZING', 'GENERATING', 'VALIDATING', 'APPLYING', 'AWAITING_APPROVAL', 'INSTALLING', 'TESTING', 'REPAIRING', 'READY_FOR_REVIEW', 'DISCARDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EngineeringChangeOperation" AS ENUM ('CREATE', 'MODIFY', 'DELETE');

-- CreateEnum
CREATE TYPE "EngineeringChangeStatus" AS ENUM ('APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SandboxExecutionKind" AS ENUM ('INSTALL', 'TEST');

-- AlterTable
ALTER TABLE "EngineeringPlan" ADD COLUMN     "approvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EngineeringRun" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "EngineeringRunStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "commitSha" TEXT,
    "maxIterations" INTEGER NOT NULL,
    "tokenBudget" INTEGER NOT NULL,
    "maxDurationSeconds" INTEGER NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "testCommand" TEXT,
    "installApproved" BOOLEAN NOT NULL DEFAULT false,
    "executionApprovedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EngineeringRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineeringChange" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "operation" "EngineeringChangeOperation" NOT NULL,
    "status" "EngineeringChangeStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "beforeHash" TEXT,
    "afterHash" TEXT,
    "diff" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "flags" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineeringChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "kind" "SandboxExecutionKind" NOT NULL,
    "commandId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "network" BOOLEAN NOT NULL DEFAULT false,
    "exitCode" INTEGER,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "output" TEXT NOT NULL DEFAULT '',
    "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SandboxExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineeringRunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "fromStatus" "EngineeringRunStatus",
    "toStatus" "EngineeringRunStatus",
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineeringRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EngineeringRun_planId_createdAt_idx" ON "EngineeringRun"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "EngineeringRun_userId_createdAt_idx" ON "EngineeringRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EngineeringRun_status_idx" ON "EngineeringRun"("status");

-- CreateIndex
CREATE INDEX "EngineeringChange_runId_iteration_idx" ON "EngineeringChange"("runId", "iteration");

-- CreateIndex
CREATE INDEX "SandboxExecution_runId_startedAt_idx" ON "SandboxExecution"("runId", "startedAt");

-- CreateIndex
CREATE INDEX "EngineeringRunEvent_runId_createdAt_idx" ON "EngineeringRunEvent"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "EngineeringRun" ADD CONSTRAINT "EngineeringRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "EngineeringPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringRun" ADD CONSTRAINT "EngineeringRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringChange" ADD CONSTRAINT "EngineeringChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineeringRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxExecution" ADD CONSTRAINT "SandboxExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineeringRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineeringRunEvent" ADD CONSTRAINT "EngineeringRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineeringRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
