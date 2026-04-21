/*
  Warnings:

  - You are about to drop the `ai_actions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_agent_versions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_agents` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_escalations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_feedback` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_guardrails` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_knowledge_chunks` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_knowledge_sources` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_memories` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_messages` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_runs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_tool_logs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ai_usage_billing` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AuthCredentialType" AS ENUM ('PASSWORD');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE', 'GITHUB', 'MICROSOFT', 'APPLE');

-- CreateEnum
CREATE TYPE "AuthSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'COMPROMISED');

-- CreateEnum
CREATE TYPE "RefreshTokenStatus" AS ENUM ('ACTIVE', 'USED', 'REVOKED', 'REUSED');

-- CreateEnum
CREATE TYPE "AuthTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'MAGIC_LINK_LOGIN', 'TEAM_INVITE', 'EMAIL_OTP_LOGIN', 'EMAIL_OTP_VERIFY', 'EMAIL_OTP_RESET', 'TWO_FACTOR_SETUP', 'TWO_FACTOR_CHALLENGE');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "LoginAttemptResult" AS ENUM ('SUCCESS', 'FAILURE', 'LOCKED', 'CHALLENGE_REQUIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AuthAuditEvent" AS ENUM ('SIGN_UP', 'SIGN_IN', 'SIGN_OUT', 'SESSION_REFRESH', 'SESSION_REVOKED', 'SESSION_REVOKED_ALL', 'TOKEN_REUSE_DETECTED', 'EMAIL_VERIFICATION_SENT', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'MAGIC_LINK_SENT', 'MAGIC_LINK_CONSUMED', 'OTP_SENT', 'OTP_VERIFIED', 'OAUTH_LINKED', 'OAUTH_SIGN_IN', 'TEAM_INVITE_SENT', 'TEAM_INVITE_ACCEPTED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'BACKUP_CODES_REGENERATED', 'SUSPICIOUS_LOGIN');

-- CreateEnum
CREATE TYPE "TwoFactorType" AS ENUM ('TOTP');

-- DropForeignKey
ALTER TABLE "ai_actions" DROP CONSTRAINT "ai_actions_approved_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_actions" DROP CONSTRAINT "ai_actions_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_actions" DROP CONSTRAINT "ai_actions_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agent_versions" DROP CONSTRAINT "ai_agent_versions_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agent_versions" DROP CONSTRAINT "ai_agent_versions_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agent_versions" DROP CONSTRAINT "ai_agent_versions_published_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agent_versions" DROP CONSTRAINT "ai_agent_versions_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agents" DROP CONSTRAINT "ai_agents_active_version_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agents" DROP CONSTRAINT "ai_agents_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_agents" DROP CONSTRAINT "ai_agents_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_assigned_team_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_assigned_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_escalations" DROP CONSTRAINT "ai_escalations_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_feedback" DROP CONSTRAINT "ai_feedback_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_feedback" DROP CONSTRAINT "ai_feedback_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_feedback" DROP CONSTRAINT "ai_feedback_message_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_feedback" DROP CONSTRAINT "ai_feedback_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_feedback" DROP CONSTRAINT "ai_feedback_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_guardrails" DROP CONSTRAINT "ai_guardrails_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_guardrails" DROP CONSTRAINT "ai_guardrails_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_guardrails" DROP CONSTRAINT "ai_guardrails_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_knowledge_chunks" DROP CONSTRAINT "ai_knowledge_chunks_source_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_knowledge_chunks" DROP CONSTRAINT "ai_knowledge_chunks_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_knowledge_sources" DROP CONSTRAINT "ai_knowledge_sources_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_knowledge_sources" DROP CONSTRAINT "ai_knowledge_sources_file_asset_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_knowledge_sources" DROP CONSTRAINT "ai_knowledge_sources_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_memories" DROP CONSTRAINT "ai_memories_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_memories" DROP CONSTRAINT "ai_memories_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_memories" DROP CONSTRAINT "ai_memories_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_message_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_agent_version_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_conversation_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_trigger_message_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_tool_logs" DROP CONSTRAINT "ai_tool_logs_action_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_tool_logs" DROP CONSTRAINT "ai_tool_logs_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_tool_logs" DROP CONSTRAINT "ai_tool_logs_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_usage_billing" DROP CONSTRAINT "ai_usage_billing_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_usage_billing" DROP CONSTRAINT "ai_usage_billing_workspace_id_fkey";

-- AlterTable
ALTER TABLE "ContactChannel" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationDeliveryAttempt" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationDevice" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationPreference" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Tag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserActivity" ALTER COLUMN "inactivitySessionId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAiPrompt" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAiSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- DropTable
DROP TABLE "ai_actions";

-- DropTable
DROP TABLE "ai_agent_versions";

-- DropTable
DROP TABLE "ai_agents";

-- DropTable
DROP TABLE "ai_escalations";

-- DropTable
DROP TABLE "ai_feedback";

-- DropTable
DROP TABLE "ai_guardrails";

-- DropTable
DROP TABLE "ai_knowledge_chunks";

-- DropTable
DROP TABLE "ai_knowledge_sources";

-- DropTable
DROP TABLE "ai_memories";

-- DropTable
DROP TABLE "ai_messages";

-- DropTable
DROP TABLE "ai_runs";

-- DropTable
DROP TABLE "ai_tool_logs";

-- DropTable
DROP TABLE "ai_usage_billing";

-- CreateTable
CREATE TABLE "AuthCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AuthCredentialType" NOT NULL DEFAULT 'PASSWORD',
    "passwordHash" TEXT,
    "passwordVersion" INTEGER NOT NULL DEFAULT 1,
    "passwordUpdatedAt" TIMESTAMP(3),
    "passwordMigratedAt" TIMESTAMP(3),
    "mustRotatePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedPasswordAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordPolicyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "rememberMe" BOOLEAN NOT NULL DEFAULT false,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "currentOrganizationId" UUID,
    "currentWorkspaceId" UUID,
    "ipAddress" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "deviceFingerprintHash" TEXT,
    "countryCode" TEXT,
    "region" TEXT,
    "city" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "compromisedAt" TIMESTAMP(3),
    "trustedDeviceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenFamilyId" UUID NOT NULL,
    "previousTokenId" UUID,
    "status" "RefreshTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdByIp" TEXT,
    "lastSeenIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "idTokenEncrypted" TEXT,
    "scope" TEXT,
    "tokenType" TEXT,
    "expiresAt" TIMESTAMP(3),
    "profile" JSONB,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL DEFAULT 'EMAIL_VERIFICATION',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedByIp" TEXT,
    "requestedByUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL DEFAULT 'PASSWORD_RESET',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedByIp" TEXT,
    "requestedByUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL DEFAULT 'MAGIC_LINK_LOGIN',
    "organizationId" UUID,
    "workspaceId" UUID,
    "roleSnapshot" JSONB,
    "redirectUri" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedByIp" TEXT,
    "requestedByUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL DEFAULT 'EMAIL',
    "purpose" "AuthTokenPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "requestedByIp" TEXT,
    "requestedByUserAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "deviceFingerprintHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "userAgent" TEXT,
    "firstIpAddress" TEXT,
    "lastIpAddress" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trustedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "ipAddress" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "result" "LoginAttemptResult" NOT NULL,
    "reason" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "requiresChallenge" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "sessionId" UUID,
    "event" "AuthAuditEvent" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "organizationId" UUID,
    "workspaceId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorSecret" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "TwoFactorType" NOT NULL DEFAULT 'TOTP',
    "secretEncrypted" TEXT NOT NULL,
    "secretVersion" INTEGER NOT NULL DEFAULT 1,
    "issuer" TEXT NOT NULL DEFAULT 'Axodesk',
    "label" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "twoFactorSecretId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthCredential_userId_type_idx" ON "AuthCredential"("userId", "type");

-- CreateIndex
CREATE INDEX "AuthCredential_lockedUntil_idx" ON "AuthCredential"("lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AuthCredential_userId_type_key" ON "AuthCredential"("userId", "type");

-- CreateIndex
CREATE INDEX "AuthSession_userId_status_expiresAt_idx" ON "AuthSession"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_currentWorkspaceId_idx" ON "AuthSession"("currentWorkspaceId");

-- CreateIndex
CREATE INDEX "AuthSession_trustedDeviceId_idx" ON "AuthSession"("trustedDeviceId");

-- CreateIndex
CREATE INDEX "AuthSession_deviceFingerprintHash_idx" ON "AuthSession"("deviceFingerprintHash");

-- CreateIndex
CREATE INDEX "AuthSession_lastSeenAt_idx" ON "AuthSession"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_status_expiresAt_idx" ON "RefreshToken"("sessionId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_tokenFamilyId_status_idx" ON "RefreshToken"("userId", "tokenFamilyId", "status");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_provider_idx" ON "OAuthAccount"("userId", "provider");

-- CreateIndex
CREATE INDEX "OAuthAccount_email_idx" ON "OAuthAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_email_expiresAt_idx" ON "EmailVerificationToken"("userId", "email", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_email_expiresAt_idx" ON "PasswordResetToken"("userId", "email", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLinkToken_email_purpose_expiresAt_idx" ON "MagicLinkToken"("email", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "MagicLinkToken_userId_purpose_expiresAt_idx" ON "MagicLinkToken"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "OtpCode_email_purpose_expiresAt_idx" ON "OtpCode"("email", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "OtpCode_userId_purpose_expiresAt_idx" ON "OtpCode"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "OtpCode_purpose_createdAt_idx" ON "OtpCode"("purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_deviceKey_key" ON "TrustedDevice"("deviceKey");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_lastSeenAt_idx" ON "TrustedDevice"("userId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "TrustedDevice_deviceFingerprintHash_idx" ON "TrustedDevice"("deviceFingerprintHash");

-- CreateIndex
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_userId_createdAt_idx" ON "LoginAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_result_createdAt_idx" ON "LoginAttempt"("result", "createdAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_userId_createdAt_idx" ON "AuthAuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_sessionId_createdAt_idx" ON "AuthAuditLog"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_event_createdAt_idx" ON "AuthAuditLog"("event", "createdAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_organizationId_workspaceId_createdAt_idx" ON "AuthAuditLog"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "TwoFactorSecret_userId_enabledAt_idx" ON "TwoFactorSecret"("userId", "enabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorSecret_userId_type_key" ON "TwoFactorSecret"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BackupCode_codeHash_key" ON "BackupCode"("codeHash");

-- CreateIndex
CREATE INDEX "BackupCode_userId_consumedAt_idx" ON "BackupCode"("userId", "consumedAt");

-- CreateIndex
CREATE INDEX "BackupCode_twoFactorSecretId_consumedAt_idx" ON "BackupCode"("twoFactorSecretId", "consumedAt");

-- AddForeignKey
ALTER TABLE "AuthCredential" ADD CONSTRAINT "AuthCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_previousTokenId_fkey" FOREIGN KEY ("previousTokenId") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpCode" ADD CONSTRAINT "OtpCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginAttempt" ADD CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAuditLog" ADD CONSTRAINT "AuthAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAuditLog" ADD CONSTRAINT "AuthAuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorSecret" ADD CONSTRAINT "TwoFactorSecret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupCode" ADD CONSTRAINT "BackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupCode" ADD CONSTRAINT "BackupCode_twoFactorSecretId_fkey" FOREIGN KEY ("twoFactorSecretId") REFERENCES "TwoFactorSecret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "NotificationDeliveryAttempt_notificationDeliveryId_targetIdenti" RENAME TO "NotificationDeliveryAttempt_notificationDeliveryId_targetId_key";

-- RenameIndex
ALTER INDEX "NotificationEmailHistory_contactId_userId_inactivitySessionId_i" RENAME TO "NotificationEmailHistory_contactId_userId_inactivitySession_idx";

-- RenameIndex
ALTER INDEX "NotificationEmailHistory_userId_contactId_type_inactivitySessio" RENAME TO "NotificationEmailHistory_userId_contactId_type_inactivitySe_key";
