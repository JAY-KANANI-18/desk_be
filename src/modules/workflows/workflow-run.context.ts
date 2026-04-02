// src/modules/workflows/workflow-run.context.ts
export interface WorkflowRunContext {
  runId: string;
  workflowId: string;
  workspaceId: string;
  contactId: string;
  conversationId?: string;

  // Live data loaded at start, refreshed on contact field updates
  contact: Record<string, any>;

  // Data from the trigger event (source, channel, messageText, etc.)
  trigger: Record<string, any>;

  // Output from each step keyed by stepId
  steps: Record<string, { output: any; status: string }>;

  // User-defined variables set by http_request, ask_question, etc.
  vars: Record<string, any>;
}