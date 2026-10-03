-- AlterTable
ALTER TABLE "EngineeringRun" ADD COLUMN     "notes" JSONB,
ADD COLUMN     "patch" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "testSetup" JSONB;
