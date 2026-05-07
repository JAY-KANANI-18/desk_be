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
-- DropForeignKey
ALTER TABLE "OutboundQueue" DROP CONSTRAINT "OutboundQueue_channelId_fkey";

-- DropForeignKey
ALTER TABLE "OutboundQueue" DROP CONSTRAINT "OutboundQueue_messageId_fkey";

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

-- AddForeignKey
ALTER TABLE "OutboundQueue" ADD CONSTRAINT "OutboundQueue_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundQueue" ADD CONSTRAINT "OutboundQueue_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
