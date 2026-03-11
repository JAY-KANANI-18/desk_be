-- CreateTable
CREATE TABLE "public"."NotificationPreference" (
    "userId" TEXT NOT NULL,
    "emailNewMessage" BOOLEAN NOT NULL DEFAULT true,
    "emailMention" BOOLEAN NOT NULL DEFAULT true,
    "emailAssignment" BOOLEAN NOT NULL DEFAULT true,
    "emailWorkflow" BOOLEAN NOT NULL DEFAULT true,
    "inappNewMessage" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);
