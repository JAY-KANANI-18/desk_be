import { Prisma } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AiAssistProviderOutput,
  AiConversationContext,
  AiProviderService,
} from './ai-provider.service';

type AssistMessage = {
  direction: string;
  type: string;
  text: string | null;
  subject: string | null;
  status: string;
  createdAt: Date;
  channel?: { name: string | null; type: string | null } | null;
  author?: { firstName: string | null; lastName: string | null } | null;
};

type PromptOption = {
  label: string;
  value: string;
  instruction?: string;
};

@Injectable()
export class AiAssistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiProvider: AiProviderService,
  ) {}

  async buildConversationAssist(workspaceId: string, conversationId: string) {
    const { context, settings } = await this.loadConversationContext(workspaceId, conversationId);
    const assistPrompt = await this.getActivePrompt(workspaceId, 'assist');
    const providerOutput = settings.enabled && assistPrompt
      ? await this.generateAssistOutput(context, settings, assistPrompt.prompt)
      : null;
    const providerMeta = this.aiProvider.getProviderMeta(settings);

    const response = {
      conversationId,
      mode: providerOutput ? 'provider_live' : 'context_only',
      generatedAt: new Date().toISOString(),
      provider: {
        name: providerMeta.provider,
        model: providerMeta.model,
        configured: providerMeta.configured,
        used: Boolean(providerOutput),
      },
      summary: providerOutput?.summary ?? this.buildDeterministicSummary(context),
      suggestedReply: providerOutput?.suggestedReply ?? null,
      suggestedTags: providerOutput?.suggestedTags ?? [],
      intent: providerOutput?.intent ?? null,
      urgency: providerOutput?.urgency ?? null,
      confidence: providerOutput?.confidence ?? null,
      channel: context.channel,
      context,
      guardrails: [
        'Use only verified DB-backed context before taking action.',
        'Review any draft before sending it to the customer.',
        'No automatic message send, tag mutation, or workflow execution was performed.',
      ],
    };

    return response;
  }

  async getWorkspaceSettings(workspaceId: string) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    const settings = await this.findSettings(workspaceId);
    if (!settings) {
      throw new NotFoundException('AI settings not found');
    }
    return settings;
  }

  async updateWorkspaceSettings(workspaceId: string, payload: any) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    await this.prisma.$executeRaw`
      UPDATE "WorkspaceAiSettings"
      SET
        "enabled" = ${payload.enabled},
        "provider" = ${payload.provider},
        "model" = ${payload.model},
        "autoSuggest" = ${payload.autoSuggest},
        "smartReply" = ${payload.smartReply},
        "summarize" = ${payload.summarize},
        "sentiment" = ${payload.sentiment},
        "translate" = ${payload.translate},
        "defaultLanguage" = ${payload.defaultLanguage},
        "updatedAt" = NOW()
      WHERE "workspaceId" = ${workspaceId}
    `;
    return this.getWorkspaceSettings(workspaceId);
  }

  async listWorkspacePrompts(workspaceId: string) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    return this.listPrompts(workspaceId, 'rewrite');
  }

  async getWorkspaceAssistPrompt(workspaceId: string) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    const prompt = await this.getActivePrompt(workspaceId, 'assist');
    if (!prompt) {
      throw new NotFoundException('AI assist prompt not found');
    }
    return prompt;
  }

  async updateWorkspaceAssistPrompt(workspaceId: string, payload: any) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    const prompt = await this.getActivePrompt(workspaceId, 'assist');
    if (!prompt) {
      throw new NotFoundException('AI assist prompt not found');
    }

    await this.prisma.$executeRaw`
      UPDATE "WorkspaceAiPrompt"
      SET
        "name" = ${payload.name ?? prompt.name},
        "description" = ${payload.description ?? prompt.description ?? null},
        "prompt" = ${payload.prompt ?? prompt.prompt},
        "isEnabled" = ${payload.isEnabled ?? prompt.isEnabled},
        "updatedAt" = NOW()
      WHERE "id" = ${prompt.id}::uuid
    `;

    return this.ensurePrompt(workspaceId, prompt.id);
  }

  async createWorkspacePrompt(workspaceId: string, payload: any) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    const kind = 'rewrite';
    const id = crypto.randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "WorkspaceAiPrompt"
      ("id","workspaceId","key","name","description","kind","prompt","options","isDefault","isEnabled","isActive","sortOrder","createdAt","updatedAt")
      VALUES (
        ${id}::uuid,
        ${workspaceId}::uuid,
        ${payload.key ?? null},
        ${payload.name},
        ${payload.description ?? null},
        ${kind},
        ${payload.prompt},
        ${payload.options ? JSON.stringify(payload.options) : null}::jsonb,
        false,
        ${payload.isEnabled ?? true},
        false,
        ${payload.sortOrder ?? 100},
        NOW(),
        NOW()
      )
    `;
    return this.ensurePrompt(workspaceId, id);
  }

  async updateWorkspacePrompt(workspaceId: string, promptId: string, payload: any) {
    const prompt = await this.ensurePrompt(workspaceId, promptId);
    if (prompt.kind !== 'rewrite') {
      throw new BadRequestException('Only rewrite prompts can be managed from AI prompts');
    }
    if (prompt.isDefault) {
      await this.prisma.$executeRaw`
        UPDATE "WorkspaceAiPrompt"
        SET
          "isEnabled" = ${payload.isEnabled ?? prompt.isEnabled},
          "updatedAt" = NOW()
        WHERE "id" = ${promptId}::uuid
      `;
      return this.ensurePrompt(workspaceId, promptId);
    }

    await this.prisma.$executeRaw`
      UPDATE "WorkspaceAiPrompt"
      SET
        "key" = ${payload.key ?? prompt.key ?? null},
        "name" = ${payload.name ?? prompt.name},
        "description" = ${payload.description ?? null},
        "kind" = 'rewrite',
        "prompt" = ${payload.prompt ?? prompt.prompt},
        "options" = ${payload.options ? JSON.stringify(payload.options) : null}::jsonb,
        "isEnabled" = ${payload.isEnabled ?? prompt.isEnabled},
        "isActive" = false,
        "sortOrder" = ${payload.sortOrder ?? prompt.sortOrder ?? 100},
        "updatedAt" = NOW()
      WHERE "id" = ${promptId}::uuid
    `;
    return this.ensurePrompt(workspaceId, promptId);
  }

  async deleteWorkspacePrompt(workspaceId: string, promptId: string) {
    const prompt = await this.ensurePrompt(workspaceId, promptId);
    if (prompt.kind !== 'rewrite') {
      throw new BadRequestException('Only rewrite prompts can be deleted from AI prompts');
    }
    if (prompt.isDefault) {
      throw new BadRequestException('Default AI prompts cannot be deleted');
    }
    await this.prisma.$executeRaw`DELETE FROM "WorkspaceAiPrompt" WHERE "id" = ${promptId}::uuid`;
    return { deleted: true };
  }

  async activatePrompt(workspaceId: string, promptId: string) {
    const prompt = await this.ensurePrompt(workspaceId, promptId);
    if (prompt.kind !== 'rewrite') {
      throw new BadRequestException('Only rewrite prompts can be activated from AI prompts');
    }
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE "WorkspaceAiPrompt"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "workspaceId" = ${workspaceId}::uuid AND "kind" = ${prompt.kind}
      `,
      this.prisma.$executeRaw`
        UPDATE "WorkspaceAiPrompt"
        SET "isActive" = true, "isEnabled" = true, "updatedAt" = NOW()
        WHERE "id" = ${promptId}::uuid
      `,
    ]);
    return { activated: true };
  }

  async rewriteDraft(
    workspaceId: string,
    conversationId: string,
    payload: { draft: string; promptId: string; optionValue?: string },
  ) {
    if (!payload.draft?.trim()) {
      throw new BadRequestException('Draft text is required');
    }

    const { context, settings } = await this.loadConversationContext(workspaceId, conversationId);
    if (!settings.enabled) {
      throw new BadRequestException('AI assist is disabled');
    }

    const prompt = await this.ensurePrompt(workspaceId, payload.promptId);
    const optionInstruction = this.resolvePromptOptionInstruction(prompt.options, payload.optionValue);
    const systemPrompt = [
      prompt.prompt,
      optionInstruction,
      'Rewrite only the provided draft.',
      'Keep facts grounded in the conversation context.',
      'Return plain text only.',
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = [
      'Conversation context JSON:',
      JSON.stringify(context),
      '',
      'Current draft:',
      payload.draft,
    ].join('\n');

    const text = await this.aiProvider.generateText({
      settings,
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });

    return {
      text,
      promptId: prompt.id,
      promptName: prompt.name,
      optionValue: payload.optionValue ?? null,
      provider: this.aiProvider.getProviderMeta(settings),
    };
  }

  async generateReplyDraft(workspaceId: string, conversationId: string) {
    const { context, settings } = await this.loadConversationContext(workspaceId, conversationId);
    if (!settings.enabled || !settings.smartReply) {
      throw new BadRequestException('AI reply assist is disabled');
    }

    const prompt = await this.getActivePrompt(workspaceId, 'assist');
    if (!prompt) {
      throw new NotFoundException('No active AI assist prompt found');
    }

    const text = await this.aiProvider.generateText({
      settings,
      systemPrompt: `${prompt.prompt}\nReturn only the reply draft text.`,
      userPrompt: `Conversation context JSON:\n${JSON.stringify(context)}`,
      temperature: 0.3,
    });

    return {
      text,
      promptId: prompt.id,
      promptName: prompt.name,
      provider: this.aiProvider.getProviderMeta(settings),
    };
  }

  async summarizeConversation(workspaceId: string, conversationId: string) {
    const { context, settings } = await this.loadConversationContext(workspaceId, conversationId);
    if (!settings.enabled || !settings.summarize) {
      throw new BadRequestException('AI summarize is disabled');
    }

    const prompt = await this.getActivePrompt(workspaceId, 'summarize');
    if (!prompt) {
      throw new NotFoundException('No active summary prompt found');
    }

    const text = await this.aiProvider.generateText({
      settings,
      systemPrompt: `${prompt.prompt}\nWrite a concise internal note summary only.`,
      userPrompt: `Conversation context JSON:\n${JSON.stringify(context)}`,
      temperature: 0.2,
    });

    return {
      text,
      promptId: prompt.id,
      promptName: prompt.name,
      provider: this.aiProvider.getProviderMeta(settings),
    };
  }

  private async loadConversationContext(workspaceId: string, conversationId: string) {
    await this.ensureWorkspaceAiSetup(workspaceId);
    const [conversation, workspaceTags, settings] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        include: {
          contact: {
            include: {
              lifecycle: { select: { name: true } },
              assignee: { select: { firstName: true, lastName: true } },
              team: { select: { name: true } },
              tags: { include: { tag: { select: { name: true } } } },
              contactChannels: {
                select: {
                  channelType: true,
                  identifier: true,
                },
                take: 10,
              },
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              direction: true,
              type: true,
              text: true,
              subject: true,
              status: true,
              createdAt: true,
              channel: { select: { name: true, type: true } },
              author: { select: { firstName: true, lastName: true } },
            },
          },
          activities: {
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              eventType: true,
              metadata: true,
              createdAt: true,
              actorType: true,
              actor: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.tag.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        select: { name: true },
      }),
      this.findSettings(workspaceId),
    ]);

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (!settings) {
      throw new NotFoundException('AI settings not found');
    }

    const messages = [...conversation.messages].reverse();
    return {
      context: this.buildContext(workspaceId, conversation, messages, workspaceTags),
      settings,
    };
  }

  private async generateAssistOutput(
    context: AiConversationContext,
    settings: { provider: string; model: string },
    assistPrompt: string,
  ): Promise<AiAssistProviderOutput | null> {
    try {
      const raw = await this.aiProvider.generateStructuredObject<any>({
        settings,
        systemPrompt: [
          assistPrompt,
          'Use only the supplied JSON context.',
          'Do not invent facts, actions, customer intent, urgency, or tags.',
          'If evidence is insufficient, return null for uncertain fields and [] for suggestedTags.',
          'suggestedTags must be chosen only from workspaceTags in the context.',
          'Return JSON with keys: summary, suggestedReply, suggestedTags, intent, urgency, confidence.',
        ].join('\n'),
        userPrompt: JSON.stringify(context),
        temperature: 0.2,
      });

      return this.aiProvider.normalizeAssistOutput(raw, context.workspaceTags);
    } catch {
      return null;
    }
  }

  private async ensureWorkspaceAiSetup(workspaceId: string) {
    await this.prisma.$executeRaw`
      INSERT INTO "WorkspaceAiSettings"
      ("id","workspaceId","enabled","provider","model","autoSuggest","smartReply","summarize","sentiment","translate","defaultLanguage","createdAt","updatedAt")
      VALUES (
        ${crypto.randomUUID()}::uuid,
        ${workspaceId}::uuid,
        true,
        'cohere',
        'command-a-03-2025',
        false,
        true,
        true,
        false,
        true,
        'auto',
        NOW(),
        NOW()
      )
      ON CONFLICT ("workspaceId") DO NOTHING
    `;

    const [{ count }] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "WorkspaceAiPrompt" WHERE "workspaceId" = ${workspaceId}::uuid
    `;
    if (Number(count) > 0) return;

    for (const prompt of this.defaultPrompts(workspaceId)) {
      await this.prisma.$executeRaw`
        INSERT INTO "WorkspaceAiPrompt"
        ("id","workspaceId","key","name","description","kind","prompt","options","isDefault","isEnabled","isActive","sortOrder","createdAt","updatedAt")
        VALUES (
          ${crypto.randomUUID()}::uuid,
          ${prompt.workspaceId}::uuid,
          ${prompt.key},
          ${prompt.name},
          ${prompt.description},
          ${prompt.kind},
          ${prompt.prompt},
          ${prompt.options ? JSON.stringify(prompt.options) : null}::jsonb,
          ${prompt.isDefault},
          ${prompt.isEnabled},
          ${prompt.isActive},
          ${prompt.sortOrder},
          NOW(),
          NOW()
        )
      `;
    }
  }

  private async getActivePrompt(workspaceId: string, kind: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "WorkspaceAiPrompt"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "kind" = ${kind}
        AND "isEnabled" = true
        AND "isActive" = true
      ORDER BY "sortOrder" ASC, "createdAt" ASC
      LIMIT 1
    `;
    return rows[0] ? this.normalizePromptRow(rows[0]) : null;
  }

  private async ensurePrompt(workspaceId: string, promptId: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "WorkspaceAiPrompt"
      WHERE "id" = ${promptId}::uuid AND "workspaceId" = ${workspaceId}::uuid
      LIMIT 1
    `;
    const prompt = rows[0] ? this.normalizePromptRow(rows[0]) : null;
    if (!prompt) {
      throw new NotFoundException('AI prompt not found');
    }
    return prompt;
  }

  private resolvePromptOptionInstruction(options: any, optionValue?: string) {
    if (!optionValue) return null;
    const parsed = this.parsePromptOptions(options);
    const match = parsed.find((item) => item.value === optionValue);
    return match?.instruction || null;
  }

  private parsePromptOptions(options: any): PromptOption[] {
    if (!options) return [];
    const raw = typeof options === 'string' ? options : JSON.stringify(options);
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private normalizePromptKind(kind?: string) {
    if (kind === 'assist' || kind === 'summarize') {
      return kind;
    }
    return 'rewrite';
  }

  private async findSettings(workspaceId: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "WorkspaceAiSettings" WHERE "workspaceId" = ${workspaceId}::uuid LIMIT 1
    `;
    return rows[0] || null;
  }

  private async listPrompts(workspaceId: string, kind?: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "WorkspaceAiPrompt"
      WHERE "workspaceId" = ${workspaceId}::uuid
        ${kind ? Prisma.sql`AND "kind" = ${kind}` : Prisma.empty}
      ORDER BY "kind" ASC, "sortOrder" ASC, "createdAt" ASC
    `;
    return rows.map((row) => this.normalizePromptRow(row));
  }

  private normalizePromptRow(row: any) {
    return {
      ...row,
      options: row.options ?? null,
    };
  }

  private defaultPrompts(workspaceId: string) {
    return [
      {
        workspaceId,
        key: 'change-tone',
        name: 'Change tone',
        description: 'Adjust the tone of the current draft before sending.',
        kind: 'rewrite',
        prompt:
          'You rewrite support and sales drafts for customer-facing messages. Preserve meaning, keep facts exact, and improve clarity.',
        options: [
          { label: 'Professional', value: 'professional', instruction: 'Use a professional tone.' },
          { label: 'Friendly', value: 'friendly', instruction: 'Use a friendly and warm tone.' },
          { label: 'Empathetic', value: 'empathetic', instruction: 'Use an empathetic and reassuring tone.' },
          { label: 'Straightforward', value: 'straightforward', instruction: 'Use a direct and straightforward tone.' },
        ],
        isDefault: true,
        isEnabled: true,
        isActive: false,
        sortOrder: 10,
      },
      {
        workspaceId,
        key: 'translate',
        name: 'Translate',
        description: 'Translate the current draft into the selected language.',
        kind: 'rewrite',
        prompt:
          'You translate customer support drafts accurately. Preserve facts, names, links, and product terms.',
        options: [
          { label: 'English', value: 'en', instruction: 'Translate to English.' },
          { label: 'Hindi', value: 'hi', instruction: 'Translate to Hindi.' },
          { label: 'Gujarati', value: 'gu', instruction: 'Translate to Gujarati.' },
          { label: 'Spanish', value: 'es', instruction: 'Translate to Spanish.' },
        ],
        isDefault: true,
        isEnabled: true,
        isActive: false,
        sortOrder: 20,
      },
      {
        workspaceId,
        key: 'fix-grammar',
        name: 'Fix spelling & grammar',
        description: 'Correct grammar, spelling, and punctuation.',
        kind: 'rewrite',
        prompt:
          'You improve spelling, grammar, punctuation, and readability while preserving meaning and facts.',
        options: null,
        isDefault: true,
        isEnabled: true,
        isActive: false,
        sortOrder: 30,
      },
      {
        workspaceId,
        key: 'simplify-language',
        name: 'Simplify language',
        description: 'Make the draft easier to read and understand.',
        kind: 'rewrite',
        prompt:
          'You simplify customer-facing drafts so they are easier to read, shorter, and clearer without losing meaning.',
        options: null,
        isDefault: true,
        isEnabled: true,
        isActive: false,
        sortOrder: 40,
      },
      {
        workspaceId,
        key: 'assist-reply',
        name: 'AI Assist Reply',
        description: 'Generate a reply draft from recent conversation history.',
        kind: 'assist',
        prompt:
          'You draft a helpful reply for the agent based on the conversation history and verified CRM context.',
        options: null,
        isDefault: true,
        isEnabled: true,
        isActive: true,
        sortOrder: 10,
      },
      {
        workspaceId,
        key: 'summarize-conversation',
        name: 'Conversation Summary',
        description: 'Summarize the conversation into an internal note.',
        kind: 'summarize',
        prompt:
          'You summarize conversations into short internal notes for the support team. Focus on issue, status, and next step.',
        options: null,
        isDefault: true,
        isEnabled: true,
        isActive: true,
        sortOrder: 10,
      },
    ];
  }

  private buildContext(
    workspaceId: string,
    conversation: any,
    messages: AssistMessage[],
    workspaceTags: Array<{ name: string }>,
  ): AiConversationContext {
    const incomingMessages = messages.filter((message) => message.direction === 'incoming');
    const outgoingMessages = messages.filter((message) => message.direction === 'outgoing');
    const currentTags = conversation.contact.tags
      .map((item: { tag: { name: string } }) => item.tag.name)
      .sort((a: string, b: string) => a.localeCompare(b));

    return {
      workspaceId,
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        priority: conversation.priority,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        lastIncomingAt: conversation.lastIncomingAt?.toISOString() ?? null,
      },
      contact: {
        id: conversation.contact.id,
        displayName: this.contactName(conversation.contact),
        firstName: conversation.contact.firstName ?? null,
        lastName: conversation.contact.lastName ?? null,
        email: conversation.contact.email ?? null,
        phone: conversation.contact.phone ?? null,
        company: conversation.contact.company ?? null,
        status: conversation.contact.status ?? null,
        marketingOptOut: conversation.contact.marketingOptOut,
        lifecycleStage: conversation.contact.lifecycle?.name ?? null,
        assigneeName: this.personName(conversation.contact.assignee),
        teamName: conversation.contact.team?.name ?? null,
        currentTags,
        linkedChannels: conversation.contact.contactChannels.map(
          (item: { channelType: string | null; identifier: string | null }) => ({
            type: item.channelType,
            identifier: item.identifier,
          }),
        ),
      },
      channel: this.resolveChannel(messages),
      recentMessages: messages.map((message) => ({
        direction: message.direction,
        type: message.type,
        text: message.text,
        subject: message.subject,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
        channelName: message.channel?.name ?? null,
        channelType: message.channel?.type ?? null,
        authorName: this.personName(message.author),
      })),
      recentActivities: conversation.activities
        .slice()
        .reverse()
        .map((activity: any) => ({
          eventType: activity.eventType,
          description: this.describeActivity(activity),
          createdAt: activity.createdAt.toISOString(),
        })),
      workspaceTags: workspaceTags.map((tag) => tag.name),
      facts: {
        incomingCount: incomingMessages.length,
        outgoingCount: outgoingMessages.length,
        lastCustomerMessage: this.findLastMessageText(incomingMessages),
        lastTeamReply: this.findLastMessageText(outgoingMessages),
      },
    };
  }

  private buildDeterministicSummary(context: AiConversationContext) {
    const lines = [
      `${context.contact.displayName} is attached to this conversation.`,
      `Conversation status is ${context.conversation.status} with ${context.conversation.priority} priority.`,
      `Recent message count: ${context.facts.incomingCount} incoming and ${context.facts.outgoingCount} outgoing.`,
    ];

    if (context.contact.company) {
      lines.push(`Company: ${context.contact.company}.`);
    }

    if (context.contact.lifecycleStage) {
      lines.push(`Lifecycle stage: ${context.contact.lifecycleStage}.`);
    }

    if (context.contact.currentTags.length > 0) {
      lines.push(`Current tags: ${context.contact.currentTags.join(', ')}.`);
    }

    if (context.facts.lastCustomerMessage) {
      lines.push(`Last customer message: "${this.clip(context.facts.lastCustomerMessage, 220)}"`);
    }

    return lines.join(' ');
  }

  private contactName(contact: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  }) {
    return this.personName(contact) || contact.email || contact.phone || 'the customer';
  }

  private personName(person?: { firstName?: string | null; lastName?: string | null } | null) {
    if (!person) return null;
    const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
    return fullName || null;
  }

  private resolveChannel(messages: AssistMessage[]) {
    const message = [...messages].reverse().find((item) => item.channel);
    if (!message?.channel) return 'unknown';
    return message.channel.name || message.channel.type || 'unknown';
  }

  private findLastMessageText(messages: AssistMessage[]) {
    const latest = [...messages].reverse().find((message) => this.messageText(message));
    return latest ? this.messageText(latest) : null;
  }

  private messageText(message?: Pick<AssistMessage, 'text' | 'subject'>) {
    if (!message) return '';
    return (message.text || message.subject || '').trim();
  }

  private describeActivity(activity: any) {
    const actorName = this.personName(activity.actor);
    if (activity.eventType === 'note') {
      const text = typeof activity.metadata?.text === 'string' ? activity.metadata.text : null;
      if (text) {
        const prefix = actorName ? `${actorName} note` : 'Internal note';
        return `${prefix}: ${this.clip(text, 120)}`;
      }
    }

    if (actorName) {
      return `${activity.eventType.replace(/_/g, ' ')} by ${actorName}`;
    }

    if (activity.actorType === 'automation') {
      return `${activity.eventType.replace(/_/g, ' ')} by automation`;
    }

    return activity.eventType.replace(/_/g, ' ');
  }

  private clip(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
  }
}
