-- AlterTable
ALTER TABLE "public"."Contact" ADD COLUMN     "lifecycleId" UUID;

-- AddForeignKey
ALTER TABLE "public"."Contact" ADD CONSTRAINT "Contact_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "public"."lifecycle_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
