-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RepositorySource" AS ENUM ('GITHUB', 'GITLAB', 'ZIP', 'DEMO');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisStage" AS ENUM ('QUEUED', 'CLONING', 'SCANNING', 'PARSING', 'SECURITY', 'DEPENDENCIES', 'ARCHITECTURE', 'GIT', 'AI', 'REPORT', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AnalysisMode" AS ENUM ('LOCAL_ONLY', 'AI');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('SOURCE', 'TEST', 'DOCUMENTATION', 'CONFIG', 'GENERATED', 'BINARY', 'OTHER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('CODE_QUALITY', 'SECURITY', 'SECRET', 'DEPENDENCY', 'ARCHITECTURE', 'API', 'DATABASE', 'TESTING', 'DOCUMENTATION', 'GIT', 'DEVOPS');

-- CreateEnum
CREATE TYPE "NodeKind" AS ENUM ('FILE', 'MODULE', 'LAYER', 'PACKAGE');

-- CreateEnum
CREATE TYPE "RecommendationSource" AS ENUM ('AI', 'RULE');

-- CreateEnum
CREATE TYPE "Effort" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'JSON', 'MARKDOWN', 'HTML');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "RepositorySource" NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "owner" TEXT,
    "branch" TEXT,
    "uploadKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "AnalysisStage" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "mode" "AnalysisMode" NOT NULL DEFAULT 'LOCAL_ONLY',
    "analyzerVersion" TEXT NOT NULL,
    "commitSha" TEXT,
    "summary" JSONB,
    "healthScore" INTEGER,
    "scoreBreakdown" JSONB,
    "weightsUsed" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "language" TEXT,
    "kind" "FileKind" NOT NULL,
    "size" INTEGER NOT NULL,
    "lines" INTEGER,
    "loc" INTEGER,
    "sloc" INTEGER,
    "commentLines" INTEGER,
    "functionCount" INTEGER,
    "classCount" INTEGER,
    "maxComplexity" INTEGER,
    "maxNesting" INTEGER,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT,
    "category" "FindingCategory" NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "line" INTEGER,
    "endLine" INTEGER,
    "evidence" TEXT,
    "impact" TEXT,
    "recommendation" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT,
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dependency" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "versionSpec" TEXT,
    "resolvedVersion" TEXT,
    "direct" BOOLEAN NOT NULL DEFAULT true,
    "dev" BOOLEAN NOT NULL DEFAULT false,
    "manifestPath" TEXT NOT NULL,
    "latestVersion" TEXT,
    "vulnIds" TEXT[],
    "dataSource" TEXT,
    "unusedCandidate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchitectureNode" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "NodeKind" NOT NULL,
    "label" TEXT NOT NULL,
    "layer" TEXT,
    "metrics" JSONB,

    CONSTRAINT "ArchitectureNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchitectureEdge" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'import',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "inCycle" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ArchitectureEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitInsight" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "GitInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "effort" "Effort",
    "evidenceFindingIds" TEXT[],
    "source" "RecommendationSource" NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixSuggestion" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "originalCode" TEXT NOT NULL,
    "suggestedCode" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Repository_userId_createdAt_idx" ON "Repository"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Analysis_repositoryId_createdAt_idx" ON "Analysis"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "Analysis_status_idx" ON "Analysis"("status");

-- CreateIndex
CREATE INDEX "File_analysisId_kind_idx" ON "File"("analysisId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "File_analysisId_path_key" ON "File"("analysisId", "path");

-- CreateIndex
CREATE INDEX "Finding_analysisId_severity_idx" ON "Finding"("analysisId", "severity");

-- CreateIndex
CREATE INDEX "Finding_analysisId_category_idx" ON "Finding"("analysisId", "category");

-- CreateIndex
CREATE INDEX "Finding_fingerprint_idx" ON "Finding"("fingerprint");

-- CreateIndex
CREATE INDEX "Metric_analysisId_key_idx" ON "Metric"("analysisId", "key");

-- CreateIndex
CREATE INDEX "Dependency_analysisId_ecosystem_idx" ON "Dependency"("analysisId", "ecosystem");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectureNode_analysisId_key_key" ON "ArchitectureNode"("analysisId", "key");

-- CreateIndex
CREATE INDEX "ArchitectureEdge_analysisId_idx" ON "ArchitectureEdge"("analysisId");

-- CreateIndex
CREATE INDEX "GitInsight_analysisId_kind_idx" ON "GitInsight"("analysisId", "kind");

-- CreateIndex
CREATE INDEX "Recommendation_analysisId_phase_idx" ON "Recommendation"("analysisId", "phase");

-- CreateIndex
CREATE INDEX "FixSuggestion_findingId_idx" ON "FixSuggestion"("findingId");

-- CreateIndex
CREATE INDEX "Report_analysisId_idx" ON "Report"("analysisId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureNode" ADD CONSTRAINT "ArchitectureNode_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureEdge" ADD CONSTRAINT "ArchitectureEdge_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureEdge" ADD CONSTRAINT "ArchitectureEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "ArchitectureNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureEdge" ADD CONSTRAINT "ArchitectureEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "ArchitectureNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitInsight" ADD CONSTRAINT "GitInsight_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixSuggestion" ADD CONSTRAINT "FixSuggestion_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

