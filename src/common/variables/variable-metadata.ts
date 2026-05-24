export interface VariableMetadata {
  key: string;
  label: string;
  group: string;
  description?: string;
}

export type VariableRenderContext = Record<string, unknown>;

export interface ContactVariableSource {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
}

export interface AgentVariableSource {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface ConversationVariableSource {
  id?: string | null;
  lastMessage?: string | null;
}

export const COMMON_VARIABLE_METADATA: VariableMetadata[] = [
  { key: 'contact.name', label: 'Contact name', group: 'Contact property' },
  { key: 'contact.first_name', label: 'First name', group: 'Contact property' },
  { key: 'contact.last_name', label: 'Last name', group: 'Contact property' },
  { key: 'contact.email', label: 'Email', group: 'Contact property' },
  { key: 'contact.phone', label: 'Phone number', group: 'Contact property' },
  { key: 'contact.company', label: 'Company', group: 'Contact property' },
  { key: 'agent.name', label: 'Agent name', group: 'Sender property' },
  { key: 'agent.email', label: 'Agent email', group: 'Sender property' },
  { key: 'conversation.id', label: 'Conversation ID', group: 'Conversation property' },
  {
    key: 'conversation.last_message',
    label: 'Last message',
    group: 'Conversation property',
  },
  { key: 'company.name', label: 'Workspace name', group: 'Workspace property' },
  { key: 'today.date', label: "Today's date", group: 'System property' },
];

export const COMMON_VARIABLE_KEYS = COMMON_VARIABLE_METADATA.map(
  (variable) => variable.key,
);

export const COMMON_VARIABLE_KEY_SET = new Set(COMMON_VARIABLE_KEYS);

export const SNIPPET_VARIABLE_KEY_SET = COMMON_VARIABLE_KEY_SET;

const VARIABLE_TOKEN_REGEX = /\{\{\s*\$?([a-zA-Z0-9._-]+)\s*\}\}/g;

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function getContactVariableName(contact?: ContactVariableSource | null): string {
  if (!contact) return '';
  return (
    [contact.firstName, contact.lastName]
      .map(cleanString)
      .filter(Boolean)
      .join(' ') ||
    cleanString(contact.email) ||
    cleanString(contact.phone)
  );
}

export function getAgentVariableName(agent?: AgentVariableSource | null): string {
  if (!agent) return '';
  return (
    cleanString(agent.name) ||
    [agent.firstName, agent.lastName]
      .map(cleanString)
      .filter(Boolean)
      .join(' ')
  );
}

export function buildCommonVariableContext(opts: {
  contact?: ContactVariableSource | null;
  agent?: AgentVariableSource | null;
  conversation?: ConversationVariableSource | null;
  company?: { name?: string | null } | null;
  today?: { date?: string | null } | null;
}): VariableRenderContext {
  const contact = opts.contact;
  const agent = opts.agent;
  const conversation = opts.conversation;

  return {
    contact: {
      name: getContactVariableName(contact),
      first_name: cleanString(contact?.firstName),
      last_name: cleanString(contact?.lastName),
      email: cleanString(contact?.email),
      phone: cleanString(contact?.phone),
      company: cleanString(contact?.company),
    },
    agent: {
      name: getAgentVariableName(agent),
      email: cleanString(agent?.email),
    },
    conversation: {
      id: cleanString(conversation?.id),
      last_message: cleanString(conversation?.lastMessage),
    },
    company: {
      name: cleanString(opts.company?.name),
    },
    today: {
      date: cleanString(opts.today?.date),
    },
  };
}

export function normalizeVariableKey(key: string): string {
  return key.trim().replace(/^\$/, '');
}

export function normalizeVariableTemplate(value: string): string {
  return value.replace(
    VARIABLE_TOKEN_REGEX,
    (_match, key: string) => `{{${normalizeVariableKey(key)}}}`,
  );
}

export function extractVariableKeys(value: string): string[] {
  const keys = Array.from(value.matchAll(VARIABLE_TOKEN_REGEX)).map((match) =>
    normalizeVariableKey(match[1]),
  );
  return Array.from(new Set(keys));
}

export function findUnsupportedVariableKeys(
  value: string,
  allowedKeys: ReadonlySet<string>,
): string[] {
  return extractVariableKeys(value).filter((key) => !allowedKeys.has(key));
}

export function getVariableValue(
  context: VariableRenderContext,
  rawKey: string,
): unknown {
  const key = normalizeVariableKey(rawKey);

  if (Object.prototype.hasOwnProperty.call(context, key)) {
    return context[key];
  }

  return key.split('.').reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;

    if (Object.prototype.hasOwnProperty.call(current, segment)) {
      return current[segment];
    }

    return undefined;
  }, context);
}

export function renderVariableTemplate(
  value: string | null | undefined,
  context: VariableRenderContext,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  return value.replace(VARIABLE_TOKEN_REGEX, (_match, key: string) =>
    renderValue(getVariableValue(context, key)),
  );
}
