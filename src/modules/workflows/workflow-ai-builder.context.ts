export type WorkflowAiFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'object'
  | 'object[]'
  | 'enum';

export interface WorkflowAiFieldDefinition {
  key: string;
  type: WorkflowAiFieldType;
  required?: boolean;
  description: string;
  allowedValues?: readonly string[];
  example?: unknown;
}

export interface WorkflowAiTriggerDefinition {
  type: string;
  label: string;
  description: string;
  dataFields: readonly WorkflowAiFieldDefinition[];
  conditionFields?: readonly string[];
}

export interface WorkflowAiStepDefinition {
  type: string;
  label: string;
  description: string;
  dataFields: readonly WorkflowAiFieldDefinition[];
  branches?: readonly string[];
  executionNotes?: readonly string[];
  userGuidance?: readonly string[];
}

export interface WorkflowAiBuilderResponse {
  mode: 'answer' | 'draft' | 'patch' | 'clarify';
  assistantMessage: string;
  questions: string[];
  draft?: {
    name?: string;
    description?: string;
    config?: Record<string, unknown>;
  };
  patch?: Array<{
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
  }>;
  suggestions: string[];
  warnings: string[];
  confidence: number;
}

export interface WorkflowAiBuilderContext {
  version: string;
  feature: string;
  contract: {
    workflowConfigShape: Record<string, unknown>;
    stepShape: Record<string, unknown>;
    graphRules: readonly string[];
    aiOutputRules: readonly string[];
    securityRules: readonly string[];
  };
  triggers: readonly WorkflowAiTriggerDefinition[];
  steps: readonly WorkflowAiStepDefinition[];
  branchConditions: {
    categories: readonly {
      value: string;
      label: string;
      description: string;
      valueSource: string;
    }[];
    operators: readonly string[];
  };
  workspaceValueSources: readonly {
    key: string;
    description: string;
  }[];
}

const commonOperators = [
  'is_equal_to',
  'is_not_equal_to',
  'contains',
  'does_not_contain',
  'starts_with',
  'ends_with',
  'exists',
  'does_not_exist',
  'is_greater_than',
  'is_less_than',
  'is_between',
  'has_any_of',
  'has_all_of',
  'has_none_of',
] as const;

export const WORKFLOW_AI_BUILDER_CONTEXT = {
  version: '2026-05-14.1',
  feature: 'workflow_build_with_ai',
  contract: {
    workflowConfigShape: {
      trigger: 'TriggerConfig | null',
      steps: 'StepConfig[]',
      settings: {
        allowStopForContact: 'boolean',
        exitOnOutgoingMessage: 'boolean',
        exitOnIncomingMessage: 'boolean',
        exitOnManualAssignment: 'boolean',
      },
    },
    stepShape: {
      id: 'stable unique string',
      type: 'one of steps[].type',
      name: 'human readable step name',
      parentId: 'trigger or another step/branch connector id',
      data: 'step-specific object',
      position: { x: 0, y: 0 },
    },
    graphRules: [
      'Every non-trigger workflow starts with one or more steps whose parentId is "trigger".',
      'Use parentId to connect linear steps. The next step after a normal step has parentId equal to that step id.',
      'Branch-like steps create branch_connector steps as children; branch path steps are children of those connectors.',
      'branch, ask_question, date_time, and send_message with message failure branching can own branch_connector children.',
      'Do not create orphan steps. Every parentId must reference "trigger" or an existing step id.',
      'Do not generate ids from real user data. Use opaque ids such as step-1, conn-success-1 in drafts.',
      'Trigger Another Workflow waits for the triggered child workflow to end, then the parent continues to the next step.',
    ],
    aiOutputRules: [
      'Return strict JSON only for builder responses.',
      'In draft.config, use the runtime workflow schema exactly: trigger has { type, data, conditions, advancedSettings } and each step has { id, type, name, parentId, data, position }.',
      'Never put metadata keys such as label or dataFields inside draft.config. dataFields only describes available config fields in this context file.',
      'Never auto-publish or claim a workflow is saved. The UI must show a preview and the user confirms.',
      'Prefer small patches for existing workflows and full drafts only for new workflows.',
      'Ask a short clarifying question when the requested trigger, channel, tag, user, or goal is ambiguous.',
      'Use only ids supplied by workspaceValueSources or the current workflow context.',
      'Include warnings for missing channels, missing tags, unsupported fields, or risky automation behavior.',
    ],
    securityRules: [
      'Never request or expose API keys, provider tokens, auth cookies, or secrets.',
      'Do not invent workspace ids, channel ids, user ids, team ids, tag ids, workflow ids, or lifecycle ids.',
      'Do not include customer personal data unless it is already present in the provided current workflow context.',
      'Treat AI output as a suggestion. Backend validation must still run before saving or publishing.',
      'For HTTP request steps, warn before sending contact data to external URLs.',
    ],
  },
  triggers: [
    {
      type: 'manual_trigger',
      label: 'Manual Trigger',
      description: 'Runs when started manually or from a Trigger Another Workflow step.',
      dataFields: [],
    },
    {
      type: 'conversation_opened',
      label: 'Conversation Opened',
      description: 'Runs when a contact opens or starts a conversation.',
      dataFields: [
        {
          key: 'sources',
          type: 'string[]',
          description: 'Optional source/channel filters such as instagram, whatsapp, facebook, webchat.',
        },
      ],
      conditionFields: ['source', 'channel'],
    },
    {
      type: 'conversation_closed',
      label: 'Conversation Closed',
      description: 'Runs when a conversation closes.',
      dataFields: [
        { key: 'sources', type: 'string[]', description: 'Optional source filters.' },
        { key: 'categories', type: 'string[]', description: 'Optional close category filters.' },
      ],
      conditionFields: ['source', 'category'],
    },
    {
      type: 'contact_tag_updated',
      label: 'Contact Tag Updated',
      description: 'Runs when a tag is added to or removed from a contact.',
      dataFields: [
        { key: 'tags', type: 'string[]', description: 'Tag ids to watch. Empty means any tag.' },
        {
          key: 'action',
          type: 'enum',
          allowedValues: ['added', 'removed'],
          description: 'Optional tag action filter.',
        },
      ],
      conditionFields: ['tagId', 'action', 'tags'],
    },
    {
      type: 'contact_field_updated',
      label: 'Contact Field Updated',
      description: 'Runs when a supported contact field changes.',
      dataFields: [
        {
          key: 'fieldId',
          type: 'enum',
          allowedValues: ['first_name', 'last_name', 'email', 'phone', 'company', 'status'],
          description: 'Optional contact field id to watch.',
        },
      ],
      conditionFields: ['fields'],
    },
    {
      type: 'lifecycle_updated',
      label: 'Lifecycle Updated',
      description: 'Runs when a contact lifecycle stage changes.',
      dataFields: [
        {
          key: 'stageSelection',
          type: 'enum',
          allowedValues: ['any', 'specific'],
          description: 'Whether to match any stage or selected stages.',
        },
        { key: 'stages', type: 'string[]', description: 'Lifecycle stage ids.' },
        { key: 'triggerWhenCleared', type: 'boolean', description: 'Allow trigger when lifecycle is cleared.' },
      ],
      conditionFields: ['lifecycleId'],
    },
    {
      type: 'contact_assigned',
      label: 'Contact Assigned',
      description: 'Runs when a contact assignment changes.',
      dataFields: [],
      conditionFields: ['assigneeId', 'teamId'],
    },
    {
      type: 'meta_ad_click',
      label: 'Meta Ad Click',
      description: 'Runs when a Meta Ads integration emits a normalized ad click or lead event.',
      dataFields: [],
      conditionFields: ['provider', 'adId', 'adName', 'campaignId', 'campaignName'],
    },
    {
      type: 'commerce.cart_abandoned',
      label: 'Abandoned Cart',
      description: 'Runs when a normalized commerce cart becomes abandoned.',
      dataFields: [],
      conditionFields: ['provider', 'cartTotalAmount', 'cartItemCount', 'checkoutUrl', 'currency'],
    },
    {
      type: 'commerce.order_created',
      label: 'Order Created',
      description: 'Runs when a normalized commerce order is created.',
      dataFields: [],
      conditionFields: ['provider', 'orderNumber', 'orderTotalAmount', 'financialStatus', 'currency'],
    },
    {
      type: 'commerce.order_paid',
      label: 'Order Paid',
      description: 'Runs when a normalized commerce order is paid.',
      dataFields: [],
      conditionFields: ['provider', 'orderNumber', 'orderTotalAmount', 'currency', 'customerEmail'],
    },
    {
      type: 'commerce.order_fulfilled',
      label: 'Order Fulfilled',
      description: 'Runs when a normalized commerce order is fulfilled.',
      dataFields: [],
      conditionFields: ['provider', 'orderNumber', 'fulfillmentStatus', 'orderPlacedAt'],
    },
    {
      type: 'commerce.order_cancelled',
      label: 'Order Cancelled',
      description: 'Runs when a normalized commerce order is cancelled.',
      dataFields: [],
      conditionFields: ['provider', 'orderNumber', 'orderStatus', 'financialStatus'],
    },
    {
      type: 'commerce.refund_created',
      label: 'Refund Created',
      description: 'Runs when a commerce adapter records a normalized refund event.',
      dataFields: [],
      conditionFields: ['provider', 'orderNumber', 'orderTotalAmount', 'currency'],
    },
  ],
  steps: [
    {
      type: 'send_message',
      label: 'Send a Message',
      description: 'Sends text or media to the contact on a selected channel.',
      dataFields: [
        {
          key: 'deliveryStrategy',
          type: 'enum',
          required: true,
          allowedValues: ['trigger_channel', 'specific_channel'],
          description: 'Use "trigger_channel" only for chat-based triggers. Use "specific_channel" for commerce, contact, and manual triggers.',
        },
        {
          key: 'channel',
          type: 'string',
          required: true,
          description: 'Use "trigger_channel" with deliveryStrategy trigger_channel, or a workspace channel id with deliveryStrategy specific_channel.',
        },
        {
          key: 'defaultMessage',
          type: 'object',
          required: true,
          description: 'Message content: { type: "text" | "media", text?: string, mediaUrl?: string }.',
        },
        {
          key: 'metadata.template',
          type: 'object',
          description: 'Approved template metadata for WhatsApp or Messenger initiated/template sends: { name, language, variables?, components? }.',
        },
        { key: 'attachments', type: 'object[]', description: 'Uploaded media/file descriptors.' },
        {
          key: 'addMessageFailureBranch',
          type: 'boolean',
          description: 'When true, create Success and Failure branch connectors.',
        },
      ],
      branches: ['Success', 'Failure'],
      executionNotes: [
        'If failure branching is off and sending fails, the step can fail the run.',
        'Variables use double braces, for example {{contact.first_name}}.',
        'Commerce triggers do not open WhatsApp/Messenger/Instagram reply windows. For first-touch WhatsApp order/cart messages, use an approved template; for Instagram/Messenger use this step only when the contact already has an open messaging window.',
      ],
      userGuidance: ['Suggest concise messages, name the channel, and call out template/window requirements for commerce-triggered sends.'],
    },
    {
      type: 'ask_question',
      label: 'Ask a Question',
      description: 'Sends a question and waits for a contact reply.',
      dataFields: [
        { key: 'questionText', type: 'string', required: true, description: 'Question sent to the contact.' },
        {
          key: 'questionType',
          type: 'enum',
          required: true,
          allowedValues: ['text', 'multiple_choice', 'number', 'email', 'phone', 'date', 'rating'],
          description: 'Validation type for the answer.',
        },
        { key: 'multipleChoiceOptions', type: 'object[]', description: 'Options for multiple choice questions.' },
        {
          key: 'deliveryStrategy',
          type: 'enum',
          allowedValues: ['trigger_channel', 'specific_channel'],
          description: 'Use "trigger_channel" only for chat-based triggers. Use "specific_channel" with Email/SMS, or with a chat channel only after an open reply window.',
        },
        { key: 'channel', type: 'string', description: 'Use "trigger_channel" or a workspace channel id.' },
        { key: 'saveAsContactField', type: 'boolean', description: 'Save answer to a contact field.' },
        { key: 'contactFieldId', type: 'string', description: 'Supported contact field id.' },
        { key: 'saveAsVariable', type: 'boolean', description: 'Save answer as a workflow variable.' },
        { key: 'variableName', type: 'string', description: 'Variable name when saveAsVariable is true.' },
        { key: 'saveAsTag', type: 'boolean', description: 'For multiple choice, save selected option as a contact tag.' },
        { key: 'addTimeoutBranch', type: 'boolean', description: 'Enable Timeout branch.' },
        { key: 'timeoutValue', type: 'number', description: 'Timeout amount, max 7 days.' },
        {
          key: 'timeoutUnit',
          type: 'enum',
          allowedValues: ['seconds', 'minutes', 'hours', 'days'],
          description: 'Timeout unit.',
        },
        { key: 'addMessageFailureBranch', type: 'boolean', description: 'Enable Message Failure branch.' },
      ],
      branches: ['Success', 'Failure', 'Timeout', 'Message Failure'],
      executionNotes: [
        'The workflow waits until a valid answer, invalid answer branch, timeout, or message failure.',
        'Rating questions send 1 to 5 star quick replies.',
      ],
    },
    {
      type: 'assign_to',
      label: 'Assign To',
      description: 'Assigns, routes, or unassigns the contact.',
      dataFields: [
        {
          key: 'action',
          type: 'enum',
          required: true,
          allowedValues: ['specific_user', 'user_in_workspace', 'unassign'],
          description: 'Assignment action.',
        },
        { key: 'userId', type: 'string', description: 'Workspace user id for specific_user.' },
        {
          key: 'assignmentLogic',
          type: 'enum',
          allowedValues: ['round_robin', 'least_open_contacts'],
          description: 'Routing logic for user_in_workspace.',
        },
        { key: 'onlyOnlineUsers', type: 'boolean', description: 'Limit workspace routing to online users.' },
        { key: 'maxOpenContacts', type: 'number', description: 'Optional max open assigned contacts per user.' },
      ],
      userGuidance: ['If no action is requested, ask who should own the contact instead of assuming.'],
    },
    {
      type: 'branch',
      label: 'Branch',
      description: 'Splits the workflow into conditional paths.',
      dataFields: [
        { key: 'connectors', type: 'string[]', description: 'Branch connector ids. Include an Else connector.' },
      ],
      branches: ['Branch 1', 'Else'],
      executionNotes: ['Contacts matching no condition go to Else when present.'],
    },
    {
      type: 'update_contact_tag',
      label: 'Update Contact Tag',
      description: 'Adds or removes tags from a contact.',
      dataFields: [
        { key: 'action', type: 'enum', allowedValues: ['add', 'remove'], required: true, description: 'Tag action.' },
        { key: 'tags', type: 'string[]', required: true, description: 'Tag ids supplied by the workspace.' },
      ],
    },
    {
      type: 'update_contact_field',
      label: 'Update Contact Field',
      description: 'Updates a supported contact field.',
      dataFields: [
        {
          key: 'fieldId',
          type: 'enum',
          required: true,
          allowedValues: ['first_name', 'last_name', 'email', 'phone', 'company', 'status'],
          description: 'Supported contact field.',
        },
        { key: 'value', type: 'string', required: true, description: 'New value, variables allowed.' },
      ],
    },
    {
      type: 'open_conversation',
      label: 'Open Conversation',
      description: 'Marks or keeps a conversation open.',
      dataFields: [],
    },
    {
      type: 'close_conversation',
      label: 'Close Conversation',
      description: 'Closes the conversation and can add notes/category.',
      dataFields: [
        { key: 'addClosingNotes', type: 'boolean', description: 'Whether to include closing details.' },
        { key: 'category', type: 'string', description: 'Closing category.' },
        { key: 'notes', type: 'string', description: 'Closing notes.' },
      ],
      executionNotes: ['The workflow can continue after closing the conversation.'],
    },
    {
      type: 'add_comment',
      label: 'Add Comment',
      description: 'Adds an internal conversation comment.',
      dataFields: [
        { key: 'comment', type: 'string', required: true, description: 'Internal note text. Mentions may be supported.' },
      ],
    },
    {
      type: 'jump_to',
      label: 'Jump To',
      description: 'Jumps to another workflow step.',
      dataFields: [
        { key: 'targetStepId', type: 'string', required: true, description: 'Target step id in the same workflow.' },
        { key: 'maxJumps', type: 'number', description: 'Loop protection. Default 3.' },
      ],
      executionNotes: ['Never jump to itself. Avoid loops unless the user explicitly asks.'],
    },
    {
      type: 'wait',
      label: 'Wait',
      description: 'Pauses the workflow for a duration.',
      dataFields: [
        { key: 'value', type: 'number', required: true, description: 'Duration amount.' },
        {
          key: 'unit',
          type: 'enum',
          required: true,
          allowedValues: ['seconds', 'minutes', 'hours', 'days'],
          description: 'Duration unit.',
        },
      ],
    },
    {
      type: 'trigger_another_workflow',
      label: 'Trigger Another Workflow',
      description: 'Starts a published manual workflow and waits until it ends before parent continues.',
      dataFields: [
        { key: 'targetWorkflowId', type: 'string', required: true, description: 'Published manual workflow id.' },
        {
          key: 'startFrom',
          type: 'enum',
          allowedValues: ['beginning', 'specific_step'],
          required: true,
          description: 'Starting point in target workflow.',
        },
        { key: 'targetStepId', type: 'string', description: 'Required when startFrom is specific_step.' },
      ],
      executionNotes: ['Target workflow must use Manual Trigger. Parent continues after child completes or fails.'],
    },
    {
      type: 'date_time',
      label: 'Date/Time',
      description: 'Routes by business hours or date range.',
      dataFields: [
        { key: 'timezone', type: 'string', required: true, description: 'IANA timezone. Use UTC if unknown.' },
        {
          key: 'mode',
          type: 'enum',
          allowedValues: ['business_hours', 'date_range'],
          required: true,
          description: 'Routing mode.',
        },
        { key: 'businessHours', type: 'object', description: 'Day keyed business hours.' },
        { key: 'dateRangeStart', type: 'string', description: 'YYYY-MM-DD start date.' },
        { key: 'dateRangeEnd', type: 'string', description: 'YYYY-MM-DD end date.' },
        { key: 'connectors', type: 'string[]', description: 'In Range and Out of Range connector ids.' },
      ],
      branches: ['In Range', 'Out of Range'],
    },
    {
      type: 'http_request',
      label: 'HTTP Request',
      description: 'Calls an external HTTP endpoint.',
      dataFields: [
        {
          key: 'method',
          type: 'enum',
          allowedValues: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          required: true,
          description: 'HTTP method.',
        },
        { key: 'url', type: 'string', required: true, description: 'External URL.' },
        { key: 'headers', type: 'object[]', description: 'Header key/value pairs. Never include secrets from chat.' },
        { key: 'body', type: 'object', description: 'Optional request body.' },
        { key: 'responseMappings', type: 'object[]', description: 'Variable mappings from response.' },
        { key: 'saveResponseStatus', type: 'boolean', description: 'Save HTTP status to a variable.' },
        { key: 'responseStatusVariableName', type: 'string', description: 'Variable name for response status.' },
      ],
      userGuidance: ['Warn about external data sharing and ask before adding customer data to the request.'],
    },
  ],
  branchConditions: {
    categories: [
      {
        value: 'variable',
        label: 'Variable',
        description: 'Compare a workflow variable set by ask_question or http_request.',
        valueSource: 'current workflow vars',
      },
      {
        value: 'contact_field',
        label: 'Contact Field',
        description: 'Compare supported contact fields.',
        valueSource: 'contact fields and injected lifecycle/users/teams ids',
      },
      {
        value: 'contact_tags',
        label: 'Contact Tags',
        description: 'Check whether a contact has selected tags.',
        valueSource: 'workspaceTags',
      },
      {
        value: 'last_interacted_channel',
        label: 'Last Interacted Channel',
        description: 'Compare the channel id or channel kind from the last interaction.',
        valueSource: 'workspaceChannels',
      },
      {
        value: 'assignee_status',
        label: 'Assignee Status',
        description: 'Compare assignee availability.',
        valueSource: 'online, away, busy, offline',
      },
      {
        value: 'time_since',
        label: 'Time Since',
        description: 'Compare elapsed time values where the UI supports it.',
        valueSource: 'duration input',
      },
    ],
    operators: commonOperators,
  },
  workspaceValueSources: [
    { key: 'workspaceChannels', description: 'Channel ids, provider kind, and display names available in the workspace.' },
    { key: 'workspaceTags', description: 'Tag ids, names, colors, and emoji available in the workspace.' },
    { key: 'workspaceUsers', description: 'Assignable workspace user ids, names, and availability.' },
    { key: 'workspaceTeams', description: 'Team ids and names available for branching or assignment.' },
    { key: 'lifecycleStages', description: 'Lifecycle stage ids and names for triggers and branches.' },
    { key: 'existingWorkflows', description: 'Published manual workflows usable by Trigger Another Workflow.' },
    { key: 'currentWorkflow', description: 'Current workflow id, name, status, config, selected step, and validation warnings.' },
  ],
} as const satisfies WorkflowAiBuilderContext;

export const WORKFLOW_AI_BUILDER_RESPONSE_SCHEMA = {
  mode: 'answer | draft | patch | clarify',
  assistantMessage: 'short user-facing explanation',
  questions: ['short clarification questions when needed'],
  draft: {
    name: 'optional workflow name',
    description: 'optional workflow description',
    config: 'optional full Workflow.config object',
  },
  patch: [
    {
      op: 'add | replace | remove',
      path: '/config/steps/0',
      value: 'JSON value for add/replace',
    },
  ],
  suggestions: ['next helpful user actions'],
  warnings: ['validation, security, or missing-data warnings'],
  confidence: 'number from 0 to 1',
} as const;

export const WORKFLOW_AI_BUILDER_SYSTEM_PROMPT = [
  'You are AxoDesk Workflow Builder AI.',
  'Help users learn, design, and safely modify workflow automations while they chat.',
  'Use the supplied workflow builder context as the source of truth for available triggers, steps, fields, branches, and graph rules.',
  'Be practical and user friendly: explain the next change in plain language, ask one or two clarifying questions when required, and suggest safe improvements.',
  'You may propose a full draft for a new workflow or a JSON patch for an existing workflow, but never claim that anything has been saved or published.',
  'When you return draft.config, use the runtime workflow keys exactly: trigger.data, step.name, and step.data. Do not use label or dataFields in draft.config.',
  'Only use workspace ids, channel ids, tag ids, user ids, team ids, lifecycle ids, and workflow ids that are supplied in the request context.',
  'Never request, reveal, or invent secrets, API keys, access tokens, cookies, or provider credentials.',
  'Return strict JSON matching the response schema. Do not wrap JSON in Markdown.',
].join('\n');

export function getWorkflowAiBuilderPromptPayload() {
  return {
    systemPrompt: WORKFLOW_AI_BUILDER_SYSTEM_PROMPT,
    context: WORKFLOW_AI_BUILDER_CONTEXT,
    responseSchema: WORKFLOW_AI_BUILDER_RESPONSE_SCHEMA,
  };
}

export function getWorkflowAiBuilderRuntimePromptPayload() {
  return {
    systemPrompt: [
      WORKFLOW_AI_BUILDER_SYSTEM_PROMPT,
      'When the user says to just build, make safe default assumptions and return a draft instead of asking follow-up questions.',
      'Keep drafts compact: use 3 to 7 useful steps unless the user asks for a larger flow.',
    ].join('\n'),
    context: {
      version: WORKFLOW_AI_BUILDER_CONTEXT.version,
      draftConfigShape: {
        trigger: '{ type, data, conditions, advancedSettings } | null',
        step: '{ id, type, name, parentId, data, position }',
        forbiddenDraftKeys: ['label', 'dataFields'],
      },
      graphRules: WORKFLOW_AI_BUILDER_CONTEXT.contract.graphRules,
      securityRules: WORKFLOW_AI_BUILDER_CONTEXT.contract.securityRules,
      triggers: WORKFLOW_AI_BUILDER_CONTEXT.triggers.map((trigger) => ({
        type: trigger.type,
        label: trigger.label,
        dataFields: trigger.dataFields.map((field) => ({
          key: field.key,
          type: field.type,
          required: field.required,
          allowedValues: field.allowedValues,
        })),
      })),
      steps: WORKFLOW_AI_BUILDER_CONTEXT.steps.map((stepDefinition) => {
        const step = stepDefinition as WorkflowAiStepDefinition;
        return {
          type: step.type,
          label: step.label,
          dataFields: step.dataFields.map((field) => ({
          key: field.key,
          type: field.type,
          required: field.required,
          allowedValues: field.allowedValues,
          })),
          branches: step.branches,
          executionNotes: step.executionNotes,
        };
      }),
      branchConditionCategories: WORKFLOW_AI_BUILDER_CONTEXT.branchConditions.categories.map((category) => ({
        value: category.value,
        valueSource: category.valueSource,
      })),
      branchOperators: WORKFLOW_AI_BUILDER_CONTEXT.branchConditions.operators,
    },
    responseSchema: WORKFLOW_AI_BUILDER_RESPONSE_SCHEMA,
  };
}
