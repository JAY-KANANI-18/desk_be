ALTER TABLE "Tag"
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "emoji" TEXT NOT NULL DEFAULT '🏷️',
ADD COLUMN "description" TEXT,
ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "createdById" UUID,
ADD COLUMN "updatedById" UUID;

ALTER TABLE "Tag"
ALTER COLUMN "color" SET DEFAULT 'tag-indigo';

UPDATE "Tag"
SET
  "updatedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "emoji" = COALESCE(NULLIF("emoji", ''), '🏷️'),
  "createdBy" = COALESCE(NULLIF("createdBy", ''), 'user');
