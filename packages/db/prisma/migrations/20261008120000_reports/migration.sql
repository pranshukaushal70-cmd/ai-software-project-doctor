-- Phase 9: reports. The previous "Report" table (format/storagePath, enum ReportFormat) was a placeholder that no
-- code path ever wrote to, so it is always empty; it is reshaped in place into report snapshots. The NOT NULL
-- columns without defaults below rely on that.

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('ANALYSIS', 'PLAN', 'RUN');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('COMPLETE', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ReportOutcome" AS ENUM ('COMPLETED', 'TESTS_PASSED', 'TESTS_FAILED', 'NOT_TESTED', 'DISCARDED', 'FAILED', 'CANCELLED', 'IN_PROGRESS', 'AWAITING_APPROVAL');

-- DropIndex
DROP INDEX "Report_analysisId_idx";

-- AlterTable
ALTER TABLE "Report" DROP COLUMN "createdAt",
DROP COLUMN "format",
DROP COLUMN "storagePath",
ADD COLUMN     "data" JSONB NOT NULL,
ADD COLUMN     "errorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fingerprint" TEXT NOT NULL,
ADD COLUMN     "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "outcome" "ReportOutcome" NOT NULL,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "repositoryId" TEXT NOT NULL,
ADD COLUMN     "runId" TEXT,
ADD COLUMN     "status" "ReportStatus" NOT NULL,
ADD COLUMN     "subjectKey" TEXT NOT NULL,
ADD COLUMN     "summary" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "type" "ReportType" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL,
ADD COLUMN     "version" INTEGER NOT NULL,
ADD COLUMN     "warningCount" INTEGER NOT NULL DEFAULT 0;

-- DropEnum
DROP TYPE "ReportFormat";

-- CreateIndex
CREATE INDEX "Report_userId_generatedAt_idx" ON "Report"("userId", "generatedAt");

-- CreateIndex
CREATE INDEX "Report_repositoryId_generatedAt_idx" ON "Report"("repositoryId", "generatedAt");

-- CreateIndex
CREATE INDEX "Report_analysisId_generatedAt_idx" ON "Report"("analysisId", "generatedAt");

-- CreateIndex
CREATE INDEX "Report_planId_generatedAt_idx" ON "Report"("planId", "generatedAt");

-- CreateIndex
CREATE INDEX "Report_runId_generatedAt_idx" ON "Report"("runId", "generatedAt");

-- CreateIndex
CREATE INDEX "Report_subjectKey_generatedAt_idx" ON "Report"("subjectKey", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_subjectKey_fingerprint_key" ON "Report"("subjectKey", "fingerprint");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_planId_fkey" FOREIGN KEY ("planId") REFERENCES "EngineeringPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineeringRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
