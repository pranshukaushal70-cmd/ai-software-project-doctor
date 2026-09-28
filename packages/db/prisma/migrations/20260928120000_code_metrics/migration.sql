-- Phase 2: code metrics and code-quality findings.

-- "sloc" was never populated; it becomes logical lines of code.
ALTER TABLE "File" RENAME COLUMN "sloc" TO "lloc";

ALTER TABLE "File"
ADD COLUMN     "avgComplexity" DOUBLE PRECISION,
ADD COLUMN     "blankLines" INTEGER,
ADD COLUMN     "duplicatedLines" INTEGER,
ADD COLUMN     "exports" TEXT[],
ADD COLUMN     "imports" TEXT[],
ADD COLUMN     "parseErrors" INTEGER;

-- Existing rows (if any) are attributed to an unknown analyzer, then the defaults are dropped
-- so new rows must always state which analyzer produced them.
ALTER TABLE "Finding"
ADD COLUMN     "analyzer" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "analyzerVersion" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "data" JSONB;
ALTER TABLE "Finding" ALTER COLUMN "analyzer" DROP DEFAULT,
ALTER COLUMN "analyzerVersion" DROP DEFAULT;

CREATE INDEX "Finding_analysisId_fileId_idx" ON "Finding"("analysisId", "fileId");
