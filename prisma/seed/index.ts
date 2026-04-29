import * as dotenv from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import * as path from 'node:path';
import { seedActivities } from './activities';
import { seedConfig } from './config';
import { seedContacts } from './contacts';
import { seedConversations } from './conversations';
import { seedMessages } from './messages';
import { seedUsers } from './users';
import { loadFaker } from './helpers';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const RESET_TABLES = [
  'Invoice',
  'Usage',
  'Payment',
  'Subscription',
  'lifecycle_stages',
  'ConversationActivity',
  'NotificationEmailHistory',
  'NotificationDeliveryAttempt',
  'NotificationDevice',
  'NotificationDelivery',
  'NotificationPreference',
  'Notification',
  'MessageAttachment',
  'BroadcastRun',
  'MessageTemplate',
  'MetaPageTemplate',
  'WhatsAppTemplate',
  'WorkflowRunStep',
  'WorkflowRun',
  'Workflow',
  'TeamMember',
  'Team',
  'ImportExportJob',
  'OutboundQueue',
  'ContactChannel',
  'MediaAsset',
  'Channel',
  'Message',
  'Conversation',
  'ContactTag',
  'Tag',
  'ContactMergeRun',
  'Contact',
  'WorkspaceMember',
  'WorkspaceAiPrompt',
  'WorkspaceAiSettings',
  'Workspace',
  'OrganizationMember',
  'Organization',
  'BackupCode',
  'TwoFactorSecret',
  'AuthAuditLog',
  'LoginAttempt',
  'TrustedDevice',
  'OtpCode',
  'MagicLinkToken',
  'PasswordResetToken',
  'EmailVerificationToken',
  'OAuthAccount',
  'RefreshToken',
  'AuthSession',
  'AuthCredential',
  'UserActivity',
  'User',
];

type RowCounter<T> = (result: T) => number;

async function runStep<T>(
  label: string,
  task: () => Promise<T>,
  rowCounter: RowCounter<T>,
): Promise<T> {
  const startedAt = Date.now();
  process.stdout.write(`${label}... `);

  const result = await task();
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`done (${rowCounter(result)} rows, ${elapsedSeconds}s)`);
  return result;
}

async function resetDatabase(prisma: PrismaClient): Promise<number> {
  const tableList = RESET_TABLES.map((table) => `"${table}"`).join(', ');

  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE ${Prisma.raw(tableList)} RESTART IDENTITY CASCADE`,
  );

  return RESET_TABLES.length;
}

async function runCleanup(prisma: PrismaClient): Promise<number> {
  await prisma.$executeRaw`
    UPDATE "Conversation" AS c
    SET "lastMessageId" = latest.id
    FROM (
      SELECT DISTINCT ON ("conversationId") id, "conversationId"
      FROM "Message"
      ORDER BY "conversationId", "createdAt" DESC, id DESC
    ) AS latest
    WHERE c.id = latest."conversationId"
  `;

  await prisma.$executeRaw`
    UPDATE "Conversation"
    SET "unreadCount" = floor(random() * 6)::int
    WHERE status = 'open'
  `;

  return 2;
}

async function main(): Promise<void> {
  const faker = await loadFaker();
  faker.seed(20260429);

  const prisma = new PrismaClient();
  const shouldReset = process.argv.includes('--reset');

  try {
    if (shouldReset) {
      await runStep(
        'Resetting database',
        () => resetDatabase(prisma),
        (count) => count,
      );
    }

    const users = await runStep(
      'Seeding users',
      () => seedUsers({ prisma }),
      (result) => result.agentIds.length,
    );
    console.log(`Login credentials written to ${users.loginCredentialsPath}`);
    const config = await runStep(
      'Seeding config',
      () => seedConfig({ prisma, ...users }),
      (result) =>
        result.channels.length +
        result.teamIds.length +
        result.tagIds.length +
        result.lifecycleStageIds.length,
    );
    const contacts = await runStep(
      'Seeding contacts',
      () => seedContacts({ prisma, ...users, ...config }),
      (result) => result.contacts.length,
    );
    const conversations = await runStep(
      'Seeding conversations',
      () => seedConversations({ prisma, ...users, ...contacts }),
      (result) => result.conversations.length,
    );
    const messages = await runStep(
      'Seeding messages',
      () => seedMessages({ prisma, ...users, ...conversations }),
      (result) => result.messageCount,
    );
    await runStep(
      'Seeding activities',
      () => seedActivities({ prisma, ...users, ...conversations }),
      (result) => result.activityCount + result.notificationIds.length,
    );
    await runStep(
      'Running cleanup SQL',
      () => runCleanup(prisma),
      (count) => count,
    );

    console.log(
      `Seed complete: ${users.agentIds.length} agents, ${contacts.contacts.length} contacts, ${conversations.conversations.length} conversations, ${messages.messageCount} messages.`,
    );
  } catch (error) {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
