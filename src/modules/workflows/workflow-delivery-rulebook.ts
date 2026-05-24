import { BadRequestException } from '@nestjs/common';

export type WorkflowMessagingStepKind = 'send_message' | 'ask_question';
export type WorkflowChannelStrategy = 'trigger_channel' | 'specific_channel';
export type WorkflowChannelMessageMode = 'text' | 'media' | 'template';
export type WorkflowTriggerFamily =
  | 'chat'
  | 'commerce'
  | 'contact'
  | 'manual'
  | 'meta'
  | 'general';

export interface WorkflowChannelFacts {
  id: string;
  type: string;
  status?: string | null;
}

export interface WorkflowStepLike {
  id: string;
  type: string;
  parentId?: string;
  name?: string;
  data?: Record<string, unknown> | null;
}

export interface WorkflowConfigLike {
  trigger?: {
    type?: string | null;
  } | null;
  steps?: WorkflowStepLike[] | null;
}

export interface WorkflowDeliveryValidationIssue {
  stepId: string;
  message: string;
}

interface WorkflowChannelCapability {
  key: string;
  label: string;
  canSendMessage: boolean;
  canStartOutbound: boolean;
  needsExistingChatForOutbound: boolean;
  requiresTemplateForNewConversation: boolean;
  supportedModes: WorkflowChannelMessageMode[];
  composer: 'chat' | 'email' | 'sms';
  customerReplyWindowMinutes?: number;
}

interface OpenChannelWindow {
  channelId: string;
  channelType: string;
  elapsedMinutes: number;
  remainingMinutes: number;
  expiresAfterMinutes: number;
}

interface PathContext {
  openWindows: OpenChannelWindow[];
}

const CHAT_MESSAGE_MODES: WorkflowChannelMessageMode[] = ['text', 'media'];
const TEXT_ONLY_MODES: WorkflowChannelMessageMode[] = ['text'];
const TEMPLATE_MESSAGE_MODES: WorkflowChannelMessageMode[] = ['text', 'media', 'template'];

const WORKFLOW_CHANNEL_SENTINELS = new Set(['trigger_channel', 'last_interacted']);
const WORKFLOW_CHANNEL_STRATEGIES = new Set<WorkflowChannelStrategy>([
  'trigger_channel',
  'specific_channel',
]);

const CHAT_TRIGGER_TYPES = new Set([
  'conversation_opened',
  'conversation_closed',
  'menu_click',
  'story_reply',
  'template_send',
]);

const CONTACT_TRIGGER_TYPES = new Set([
  'contact_tag_updated',
  'contact_field_updated',
  'contact_assigned',
  'lifecycle_updated',
]);

const CHANNEL_CAPABILITIES_BY_KEY: Record<string, WorkflowChannelCapability> = {
  whatsapp: {
    key: 'whatsapp',
    label: 'WhatsApp',
    canSendMessage: true,
    canStartOutbound: true,
    needsExistingChatForOutbound: false,
    requiresTemplateForNewConversation: true,
    supportedModes: TEMPLATE_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  messenger: {
    key: 'messenger',
    label: 'Messenger',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: TEMPLATE_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  webchat: {
    key: 'webchat',
    label: 'Website chat',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
  },
  email: {
    key: 'email',
    label: 'Email',
    canSendMessage: true,
    canStartOutbound: true,
    needsExistingChatForOutbound: false,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'email',
  },
  gmail: {
    key: 'gmail',
    label: 'Gmail',
    canSendMessage: true,
    canStartOutbound: true,
    needsExistingChatForOutbound: false,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'email',
  },
  sms: {
    key: 'sms',
    label: 'SMS',
    canSendMessage: true,
    canStartOutbound: true,
    needsExistingChatForOutbound: false,
    requiresTemplateForNewConversation: false,
    supportedModes: TEXT_ONLY_MODES,
    composer: 'sms',
  },
  telegram: {
    key: 'telegram',
    label: 'Telegram',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  viber: {
    key: 'viber',
    label: 'Viber',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  line: {
    key: 'line',
    label: 'LINE',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  wechat: {
    key: 'wechat',
    label: 'WeChat',
    canSendMessage: true,
    canStartOutbound: false,
    needsExistingChatForOutbound: true,
    requiresTemplateForNewConversation: false,
    supportedModes: CHAT_MESSAGE_MODES,
    composer: 'chat',
    customerReplyWindowMinutes: 24 * 60,
  },
  exotel_call: {
    key: 'exotel_call',
    label: 'Call',
    canSendMessage: false,
    canStartOutbound: false,
    needsExistingChatForOutbound: false,
    requiresTemplateForNewConversation: false,
    supportedModes: [],
    composer: 'chat',
  },
};

const UNKNOWN_CHANNEL_CAPABILITY: WorkflowChannelCapability = {
  key: 'unknown',
  label: 'This channel',
  canSendMessage: false,
  canStartOutbound: false,
  needsExistingChatForOutbound: true,
  requiresTemplateForNewConversation: false,
  supportedModes: [],
  composer: 'chat',
};

export function normalizeWorkflowChannelType(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

export function getWorkflowChannelCapability(channelType: unknown) {
  const key = normalizeWorkflowChannelType(channelType);
  return CHANNEL_CAPABILITIES_BY_KEY[key] ?? UNKNOWN_CHANNEL_CAPABILITY;
}

export function getWorkflowTriggerFamily(triggerType: unknown): WorkflowTriggerFamily {
  const normalized = String(triggerType ?? '');
  if (normalized.startsWith('commerce.')) return 'commerce';
  if (normalized === 'meta_ad_click') return 'meta';
  if (CONTACT_TRIGGER_TYPES.has(normalized)) return 'contact';
  if (normalized === 'manual_trigger' || normalized === 'shortcut') return 'manual';
  if (CHAT_TRIGGER_TYPES.has(normalized)) return 'chat';
  return 'general';
}

export function workflowTriggerHasConversation(triggerType: unknown) {
  const family = getWorkflowTriggerFamily(triggerType);
  return family === 'chat' || family === 'meta';
}

export function isWorkflowChannelStrategy(value: unknown): value is WorkflowChannelStrategy {
  return typeof value === 'string' && WORKFLOW_CHANNEL_STRATEGIES.has(value as WorkflowChannelStrategy);
}

export function isSpecificWorkflowChannel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !WORKFLOW_CHANNEL_SENTINELS.has(value.trim())
  );
}

export function resolveWorkflowChannelStrategy(
  strategy: unknown,
  channel: unknown,
): WorkflowChannelStrategy {
  if (isWorkflowChannelStrategy(strategy)) return strategy;
  if (isSpecificWorkflowChannel(channel)) return 'specific_channel';
  if (channel === 'trigger_channel' || channel === 'last_interacted') return 'trigger_channel';
  return 'specific_channel';
}

export function isWorkflowStrategyAllowedForTrigger(
  triggerType: unknown,
  strategy: WorkflowChannelStrategy,
) {
  if (strategy === 'trigger_channel') {
    return workflowTriggerHasConversation(triggerType);
  }
  return strategy === 'specific_channel';
}

export function getWorkflowStrategyIssue(
  triggerType: unknown,
  strategy: WorkflowChannelStrategy,
) {
  if (isWorkflowStrategyAllowedForTrigger(triggerType, strategy)) return null;

  return 'This workflow does not start from a chat. Choose one channel.';
}

export function inferWorkflowMessageMode(data: Record<string, unknown> | null | undefined) {
  const metadata = asRecord(data?.metadata);
  if (asRecord(metadata?.template)?.name && asRecord(metadata?.template)?.language) {
    return 'template' satisfies WorkflowChannelMessageMode;
  }

  const attachments = data?.attachments;
  return Array.isArray(attachments) && attachments.length > 0
    ? ('media' satisfies WorkflowChannelMessageMode)
    : ('text' satisfies WorkflowChannelMessageMode);
}

export function workflowMessageHasTemplate(data: Record<string, unknown> | null | undefined) {
  return inferWorkflowMessageMode(data) === 'template';
}

export function validateWorkflowDeliveryForPublish(
  config: WorkflowConfigLike,
  channels: WorkflowChannelFacts[],
) {
  const issues: WorkflowDeliveryValidationIssue[] = [];
  const steps = Array.isArray(config.steps) ? config.steps : [];
  const triggerType = config.trigger?.type;
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const pathContextByStepId = buildPathContexts(steps, channelById);

  for (const step of steps) {
    if (step.type !== 'send_message' && step.type !== 'ask_question') continue;

    const stepData = asRecord(step.data) ?? {};
    const strategy = resolveStepStrategy(step.type, stepData);
    const strategyIssue = getWorkflowStrategyIssue(triggerType, strategy);
    if (strategyIssue) {
      issues.push({ stepId: step.id, message: strategyIssue });
      continue;
    }

    if (strategy === 'trigger_channel') {
      validateTriggerChannelStep(step, stepData, issues);
      continue;
    }

    validateSpecificChannelStep({
      step,
      stepData,
      channelById,
      pathContext: pathContextByStepId.get(step.id) ?? { openWindows: [] },
      issues,
    });
  }

  return issues;
}

export function assertWorkflowDeliveryForPublish(
  config: WorkflowConfigLike,
  channels: WorkflowChannelFacts[],
) {
  const issues = validateWorkflowDeliveryForPublish(config, channels);
  if (issues.length === 0) return;

  throw new BadRequestException(
    `Workflow delivery rules failed: ${issues
      .map((issue) => `${issue.stepId}: ${issue.message}`)
      .join('; ')}`,
  );
}

function resolveStepStrategy(
  stepType: string,
  stepData: Record<string, unknown>,
): WorkflowChannelStrategy {
  const fallbackChannel = stepType === 'ask_question'
    ? stepData.channel ?? 'trigger_channel'
    : stepData.channel;
  return resolveWorkflowChannelStrategy(stepData.deliveryStrategy, fallbackChannel);
}

function validateTriggerChannelStep(
  step: WorkflowStepLike,
  stepData: Record<string, unknown>,
  issues: WorkflowDeliveryValidationIssue[],
) {
  if (step.type === 'send_message') {
    validateMessageContent(step, stepData, issues);
  } else {
    validateQuestionContent(step, stepData, issues);
  }
}

function validateSpecificChannelStep(opts: {
  step: WorkflowStepLike;
  stepData: Record<string, unknown>;
  channelById: Map<string, WorkflowChannelFacts>;
  pathContext: PathContext;
  issues: WorkflowDeliveryValidationIssue[];
}) {
  const { step, stepData, channelById, pathContext, issues } = opts;
  const channelId = getSpecificChannelId(stepData.channel);
  if (!channelId) {
    issues.push({ stepId: step.id, message: 'Choose one channel.' });
    return;
  }

  const channel = channelById.get(channelId);
  if (!channel) {
    issues.push({ stepId: step.id, message: 'Selected channel was not found in this workspace.' });
    return;
  }

  if (channel.status && channel.status !== 'connected') {
    issues.push({ stepId: step.id, message: `${getWorkflowChannelCapability(channel.type).label} is disconnected.` });
    return;
  }

  const capability = getWorkflowChannelCapability(channel.type);
  const openWindow = pathContext.openWindows.find((window) => window.channelId === channelId);
  const hasOpenWindow = Boolean(openWindow);

  if (!capability.canSendMessage) {
    issues.push({ stepId: step.id, message: `${capability.label} cannot send workflow messages.` });
    return;
  }

  if (step.type === 'send_message') {
    validateMessageContent(step, stepData, issues);
    validateSendMessageChannelRules(step, stepData, capability, hasOpenWindow, issues);
    return;
  }

  validateQuestionContent(step, stepData, issues);
  validateAskQuestionChannelRules(step, capability, hasOpenWindow, issues);
}

function validateMessageContent(
  step: WorkflowStepLike,
  stepData: Record<string, unknown>,
  issues: WorkflowDeliveryValidationIssue[],
) {
  const defaultMessage = asRecord(stepData.defaultMessage);
  const text = typeof defaultMessage?.text === 'string' ? defaultMessage.text.trim() : '';
  const attachments = stepData.attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasTemplate = workflowMessageHasTemplate(stepData);

  if (!text && !hasAttachments && !hasTemplate) {
    issues.push({ stepId: step.id, message: 'Add message content.' });
  }

  if (stepData.templateButtonBranching && !hasTemplate) {
    issues.push({ stepId: step.id, message: 'Quick reply branching needs an approved template.' });
  }
}

function validateQuestionContent(
  step: WorkflowStepLike,
  stepData: Record<string, unknown>,
  issues: WorkflowDeliveryValidationIssue[],
) {
  const questionText = typeof stepData.questionText === 'string' ? stepData.questionText.trim() : '';
  if (!questionText) {
    issues.push({ stepId: step.id, message: 'Add question text.' });
  }
}

function validateSendMessageChannelRules(
  step: WorkflowStepLike,
  stepData: Record<string, unknown>,
  capability: WorkflowChannelCapability,
  hasOpenWindow: boolean,
  issues: WorkflowDeliveryValidationIssue[],
) {
  const messageMode = inferWorkflowMessageMode(stepData);
  if (!capability.supportedModes.includes(messageMode)) {
    issues.push({ stepId: step.id, message: `${capability.label} does not support ${messageMode} messages.` });
    return;
  }

  if (hasOpenWindow) return;

  if (capability.requiresTemplateForNewConversation && messageMode !== 'template') {
    issues.push({ stepId: step.id, message: `Use an approved ${capability.label} template for the first message.` });
    return;
  }

  if (!capability.canStartOutbound || capability.needsExistingChatForOutbound) {
    issues.push({ stepId: step.id, message: `${capability.label} can reply only after the contact has chatted there.` });
  }
}

function validateAskQuestionChannelRules(
  step: WorkflowStepLike,
  capability: WorkflowChannelCapability,
  hasOpenWindow: boolean,
  issues: WorkflowDeliveryValidationIssue[],
) {
  if (hasOpenWindow) return;
  if (capability.composer === 'email' || capability.composer === 'sms') return;

  issues.push({
    stepId: step.id,
    message: `${capability.label} questions need an open chat. Ask by Email/SMS or place it after a contact reply branch.`,
  });
}

function buildPathContexts(
  steps: WorkflowStepLike[],
  channelById: Map<string, WorkflowChannelFacts>,
) {
  return new Map(
    steps.map((step) => [
      step.id,
      getPathContext(steps, step.id, channelById),
    ]),
  );
}

function getPathContext(
  steps: WorkflowStepLike[],
  stepId: string,
  channelById: Map<string, WorkflowChannelFacts>,
): PathContext {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  let openWindows: OpenChannelWindow[] = [];

  for (const pathStep of getStepLineage(steps, stepId)) {
    if (pathStep.type === 'branch_connector') {
      const openedWindow = getWindowFromConnector(pathStep, stepById, channelById);
      if (!openedWindow) continue;
      openWindows = replaceWindow(openWindows, openedWindow);
      continue;
    }

    if (pathStep.type === 'wait') {
      openWindows = ageWindows(openWindows, waitToMinutes(asRecord(pathStep.data)), pathStep.id);
    }
  }

  return { openWindows };
}

function getStepLineage(steps: WorkflowStepLike[], stepId: string) {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const lineage: WorkflowStepLike[] = [];
  const visited = new Set<string>();
  let current = stepById.get(stepId);

  while (current?.parentId && current.parentId !== 'trigger') {
    const parent = stepById.get(current.parentId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    lineage.push(parent);
    current = parent;
  }

  return lineage.reverse();
}

function getWindowFromConnector(
  connector: WorkflowStepLike,
  stepsById: Map<string, WorkflowStepLike>,
  channelById: Map<string, WorkflowChannelFacts>,
) {
  if (connector.type !== 'branch_connector' || !connector.parentId) return null;
  const parent = stepsById.get(connector.parentId);
  if (!parent) return null;

  return (
    getWindowFromSendMessageConnector(connector, parent, channelById) ??
    getWindowFromAskQuestionConnector(connector, parent, channelById)
  );
}

function getWindowFromSendMessageConnector(
  connector: WorkflowStepLike,
  parent: WorkflowStepLike,
  channelById: Map<string, WorkflowChannelFacts>,
) {
  if (parent.type !== 'send_message') return null;
  if (!isCustomerReplyConnector(connector)) return null;

  const data = asRecord(parent.data) ?? {};
  if (!data.templateButtonBranching || !workflowMessageHasTemplate(data)) return null;

  const channelId = getSpecificChannelId(data.channel);
  if (!channelId) return null;

  return buildOpenWindow(parent.id, channelId, channelById);
}

function getWindowFromAskQuestionConnector(
  connector: WorkflowStepLike,
  parent: WorkflowStepLike,
  channelById: Map<string, WorkflowChannelFacts>,
) {
  if (parent.type !== 'ask_question') return null;
  if (normalizeConnectorName(connector.name) !== 'success') return null;

  const data = asRecord(parent.data) ?? {};
  const channelId = getSpecificChannelId(data.channel);
  if (!channelId) return null;

  return buildOpenWindow(parent.id, channelId, channelById);
}

function buildOpenWindow(
  openedByStepId: string,
  channelId: string,
  channelById: Map<string, WorkflowChannelFacts>,
) {
  const channel = channelById.get(channelId);
  if (!channel) return null;

  const capability = getWorkflowChannelCapability(channel.type);
  if (!capability.customerReplyWindowMinutes) return null;

  return {
    channelId,
    channelType: channel.type,
    elapsedMinutes: 0,
    remainingMinutes: capability.customerReplyWindowMinutes,
    expiresAfterMinutes: capability.customerReplyWindowMinutes,
    openedByStepId,
  };
}

function isCustomerReplyConnector(connector: WorkflowStepLike) {
  const name = normalizeConnectorName(connector.name);
  return name !== 'failure' && name !== 'message failure' && name !== 'timeout';
}

function normalizeConnectorName(name: unknown) {
  return String(name ?? '').trim().toLowerCase();
}

function replaceWindow(windows: OpenChannelWindow[], window: OpenChannelWindow) {
  return [
    ...windows.filter((item) => item.channelId !== window.channelId),
    window,
  ];
}

function ageWindows(
  windows: OpenChannelWindow[],
  minutes: number,
  _expiredByStepId: string,
) {
  if (minutes <= 0) return windows;

  return windows
    .map((window) => {
      const elapsedMinutes = window.elapsedMinutes + minutes;
      return {
        ...window,
        elapsedMinutes,
        remainingMinutes: window.expiresAfterMinutes - elapsedMinutes,
      };
    })
    .filter((window) => window.remainingMinutes > 0);
}

function waitToMinutes(data: Record<string, unknown> | null | undefined) {
  const value = typeof data?.value === 'number' && Number.isFinite(data.value)
    ? data.value
    : 0;

  switch (data?.unit) {
    case 'seconds':
      return value / 60;
    case 'minutes':
      return value;
    case 'hours':
      return value * 60;
    case 'days':
      return value * 24 * 60;
    default:
      return 0;
  }
}

function getSpecificChannelId(value: unknown) {
  return isSpecificWorkflowChannel(value) ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
