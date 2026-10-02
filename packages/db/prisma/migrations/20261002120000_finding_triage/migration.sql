-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('EXPECTED', 'IGNORED');

-- CreateTable
CREATE TABLE "FindingTriage" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "path" TEXT,
    "status" "TriageStatus" NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingTriage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FindingTriage_repositoryId_fingerprint_key" ON "FindingTriage"("repositoryId", "fingerprint");

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
