-- CreateEnum
CREATE TYPE "SymbolKind" AS ENUM ('FUNCTION', 'CLASS', 'METHOD', 'INTERFACE', 'TYPE', 'ENUM', 'CONSTANT', 'VARIABLE');

-- CreateEnum
CREATE TYPE "DependencyKind" AS ENUM ('INTERNAL', 'EXTERNAL', 'BUILTIN', 'UNRESOLVED');

-- AlterEnum
ALTER TYPE "AnalysisStage" ADD VALUE 'INDEXING' BEFORE 'GIT';

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "contentHash" TEXT;

-- CreateTable
CREATE TABLE "CodeSymbol" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SymbolKind" NOT NULL,
    "parent" TEXT,
    "exported" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "line" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "signature" TEXT,

    CONSTRAINT "CodeSymbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolReference" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fromSymbolId" TEXT,
    "targetSymbolId" TEXT,
    "name" TEXT NOT NULL,
    "receiver" TEXT,
    "line" INTEGER NOT NULL,

    CONSTRAINT "SymbolReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileDependency" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fromFileId" TEXT NOT NULL,
    "toFileId" TEXT,
    "specifier" TEXT NOT NULL,
    "kind" "DependencyKind" NOT NULL,
    "packageName" TEXT,

    CONSTRAINT "FileDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSymbol_analysisId_name_idx" ON "CodeSymbol"("analysisId", "name");

-- CreateIndex
CREATE INDEX "CodeSymbol_fileId_idx" ON "CodeSymbol"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSymbol_analysisId_key_key" ON "CodeSymbol"("analysisId", "key");

-- CreateIndex
CREATE INDEX "SymbolReference_analysisId_name_idx" ON "SymbolReference"("analysisId", "name");

-- CreateIndex
CREATE INDEX "SymbolReference_targetSymbolId_idx" ON "SymbolReference"("targetSymbolId");

-- CreateIndex
CREATE INDEX "SymbolReference_fromSymbolId_idx" ON "SymbolReference"("fromSymbolId");

-- CreateIndex
CREATE INDEX "SymbolReference_fileId_idx" ON "SymbolReference"("fileId");

-- CreateIndex
CREATE INDEX "FileDependency_fromFileId_idx" ON "FileDependency"("fromFileId");

-- CreateIndex
CREATE INDEX "FileDependency_toFileId_idx" ON "FileDependency"("toFileId");

-- CreateIndex
CREATE INDEX "FileDependency_analysisId_kind_idx" ON "FileDependency"("analysisId", "kind");

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolReference" ADD CONSTRAINT "SymbolReference_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolReference" ADD CONSTRAINT "SymbolReference_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolReference" ADD CONSTRAINT "SymbolReference_fromSymbolId_fkey" FOREIGN KEY ("fromSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolReference" ADD CONSTRAINT "SymbolReference_targetSymbolId_fkey" FOREIGN KEY ("targetSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileDependency" ADD CONSTRAINT "FileDependency_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileDependency" ADD CONSTRAINT "FileDependency_fromFileId_fkey" FOREIGN KEY ("fromFileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileDependency" ADD CONSTRAINT "FileDependency_toFileId_fkey" FOREIGN KEY ("toFileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
