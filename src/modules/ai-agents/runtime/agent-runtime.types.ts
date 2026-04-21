export type AgentRunMode = 'auto' | 'sandbox' | 'approval' | 'manual';

export interface AgentRuntimeMessage {
  role: 'system' | 'customer' | 'assistant' | 'tool' | 'policy';
  content: string;
  metadata?: Record<string, any>;
}

export interface AgentRuntimeContext {
  workspaceId: string;
  agentId: string;
  agentVersionId: string;
  conversationId?: string;
  contactId?: string;
  triggerMessageId?: string;
  channelId?: string;
  channelType?: string;
  mode: AgentRunMode;
  idempotencyKey: string;
}

export interface AgentVersionConfig {
  id: string;
  agentId: string;
  name: string;
  tone: string;
  defaultLanguage: string;
  channelAllowlist: string[];
  businessHours: Record<string, any>;
  llmConfig: Record<string, any>;
  runtimeConfig: Record<string, any>;
  guardrails: Record<string, any>;
  toolsAllowed: string[];
  knowledgeSourceIds: string[];
  systemPrompt: string;
  approvalMode: 'off' | 'first_reply' | 'all_replies' | 'tools_only';
  sandboxMode: boolean;
}

export interface AgentDecision {
  intent: string;
  confidence: number;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'angry';
  needsHuman: boolean;
  responseStrategy: 'answer' | 'ask_clarifying_question' | 'run_tools' | 'handoff' | 'no_reply';
  tools: Array<{
    name: string;
    input: Record<string, any>;
    reason: string;
  }>;
  memoryUpdates: Array<{
    scope: 'conversation' | 'contact';
    key: string;
    value: Record<string, any>;
    confidence?: number;
  }>;
}

export interface KnowledgeHit {
  id: string;
  sourceId: string;
  title: string | null;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'waiting_approval' | 'escalated' | 'failed';
  reply: string | null;
  decision: AgentDecision | null;
  handoffReason?: string;
  actions: Array<{
    toolName: string;
    status: 'succeeded' | 'failed' | 'skipped' | 'waiting_approval';
    output?: Record<string, any>;
    error?: string;
  }>;
}
