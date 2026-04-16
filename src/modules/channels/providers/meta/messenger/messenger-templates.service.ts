import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../../prisma/prisma.service';

export interface MessengerTemplateCatalogItem {
  metaId: string;
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'SERVICE';
  status: 'APPROVED';
  language: 'default';
  templateType: 'text' | 'button' | 'generic' | 'media';
  description: string;
  variables: string[];
  components: any[];
  payload: any;
}

const TEMPLATE_TYPE = 'messenger_template';
const FEATURE = 'messenger_templates';

export const MESSENGER_TEMPLATE_CATALOG: MessengerTemplateCatalogItem[] = [
  {
    metaId: 'messenger_platform:text_update',
    name: 'text_update',
    category: 'SERVICE',
    status: 'APPROVED',
    language: 'default',
    templateType: 'text',
    description: 'Simple service update with contact personalization.',
    variables: ['contact_name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{contact_name}}, thanks for reaching out. We will help you shortly.',
      },
    ],
    payload: {
      text: 'Hi {{contact_name}}, thanks for reaching out. We will help you shortly.',
    },
  },
  {
    metaId: 'messenger_platform:quick_reply_prompt',
    name: 'quick_reply_prompt',
    category: 'SERVICE',
    status: 'APPROVED',
    language: 'default',
    templateType: 'button',
    description: 'Ask the contact to choose a support path.',
    variables: ['contact_name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{contact_name}}, what would you like help with?',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Talk to support' },
          { type: 'QUICK_REPLY', text: 'View plans' },
        ],
      },
    ],
    payload: {
      text: 'Hi {{contact_name}}, what would you like help with?',
      quick_replies: [
        {
          content_type: 'text',
          title: 'Talk to support',
          payload: 'TALK_TO_SUPPORT',
        },
        {
          content_type: 'text',
          title: 'View plans',
          payload: 'VIEW_PLANS',
        },
      ],
    },
  },
  {
    metaId: 'messenger_platform:button_template',
    name: 'button_template',
    category: 'UTILITY',
    status: 'APPROVED',
    language: 'default',
    templateType: 'button',
    description: 'Structured button template with an automation payload and URL.',
    variables: ['contact_name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{contact_name}}, here are the fastest next steps.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Start automation' },
          { type: 'URL', text: 'Open help center', url: 'https://example.com/help' },
        ],
      },
    ],
    payload: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'Hi {{contact_name}}, here are the fastest next steps.',
          buttons: [
            {
              type: 'postback',
              title: 'Start automation',
              payload: 'MESSENGER_TEMPLATE_START',
            },
            {
              type: 'web_url',
              title: 'Open help center',
              url: 'https://example.com/help',
            },
          ],
        },
      },
    },
  },
  {
    metaId: 'messenger_platform:generic_card',
    name: 'generic_card',
    category: 'MARKETING',
    status: 'APPROVED',
    language: 'default',
    templateType: 'generic',
    description: 'Generic card layout with title, subtitle, and action buttons.',
    variables: ['contact_name'],
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        text: 'Card image',
      },
      {
        type: 'BODY',
        text: 'Recommended for {{contact_name}}',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Interested' },
          { type: 'URL', text: 'Learn more', url: 'https://example.com' },
        ],
      },
    ],
    payload: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: 'Recommended for {{contact_name}}',
              subtitle: 'A ready-to-use Messenger card from Meta platform templates.',
              image_url: 'https://placehold.co/600x360?text=Messenger',
              buttons: [
                {
                  type: 'postback',
                  title: 'Interested',
                  payload: 'MESSENGER_TEMPLATE_INTERESTED',
                },
                {
                  type: 'web_url',
                  title: 'Learn more',
                  url: 'https://example.com',
                },
              ],
            },
          ],
        },
      },
    },
  },
  {
    metaId: 'messenger_platform:media_template',
    name: 'media_template',
    category: 'UTILITY',
    status: 'APPROVED',
    language: 'default',
    templateType: 'media',
    description: 'Media template shell for reusable image/video sends.',
    variables: [],
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        text: 'Reusable media',
      },
      {
        type: 'BODY',
        text: 'Media templates can send reusable image or video attachments.',
      },
    ],
    payload: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: 'Reusable media',
              subtitle: 'Media templates can send reusable image or video attachments.',
              image_url: 'https://placehold.co/600x360?text=Messenger+Media',
              buttons: [
                {
                  type: 'postback',
                  title: 'View details',
                  payload: 'MESSENGER_TEMPLATE_MEDIA_DETAILS',
                },
              ],
            },
          ],
        },
      },
    },
  },
];

@Injectable()
export class MessengerTemplatesService {
  private readonly logger = new Logger(MessengerTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async sync(channelId: string, workspaceId: string) {
    await this.findChannel(channelId, workspaceId);

    await this.prisma.metaPageTemplate.deleteMany({
      where: {
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: TEMPLATE_TYPE,
      },
    });

    await this.prisma.metaPageTemplate.createMany({
      data: MESSENGER_TEMPLATE_CATALOG.map((template) => ({
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: TEMPLATE_TYPE,
        metaId: template.metaId,
        name: template.name,
        payload: template as unknown as Prisma.InputJsonValue,
        syncedAt: new Date(),
      })),
    });

    const result = {
      synced: MESSENGER_TEMPLATE_CATALOG.length,
      errors: 0,
      syncedAt: new Date().toISOString(),
    };

    this.events.emit('channel.sync.completed', {
      workspaceId,
      channelId,
      feature: FEATURE,
      ...result,
    });

    this.logger.log(
      `Messenger templates synced channel=${channelId} count=${result.synced}`,
    );

    return result;
  }

  async list(
    channelId: string,
    workspaceId: string,
    filters: { category?: string; language?: string; search?: string } = {},
  ) {
    await this.findChannel(channelId, workspaceId);

    const rows = await this.prisma.metaPageTemplate.findMany({
      where: {
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: TEMPLATE_TYPE,
      },
      orderBy: { name: 'asc' },
    });

    const source = rows.length
      ? rows.map((row) => row.payload as unknown as MessengerTemplateCatalogItem)
      : MESSENGER_TEMPLATE_CATALOG;

    return source
      .filter((template) =>
        filters.category ? template.category === filters.category : true,
      )
      .filter((template) =>
        filters.language ? template.language === filters.language : true,
      )
      .filter((template) => {
        const q = filters.search?.trim().toLowerCase();
        if (!q) return true;
        return (
          template.name.toLowerCase().includes(q) ||
          template.description.toLowerCase().includes(q) ||
          template.templateType.toLowerCase().includes(q)
        );
      })
      .map((template) => this.toResponse(template));
  }

  async preview(
    channelId: string,
    workspaceId: string,
    templateId: string,
    variables: Record<string, string>,
  ) {
    await this.findChannel(channelId, workspaceId);
    const template = await this.getTemplate(channelId, workspaceId, templateId);
    const renderedPayload = this.renderValue(template.payload, variables);

    return {
      ...this.toResponse(template),
      preview: renderedPayload,
      components: this.renderValue(template.components, variables),
    };
  }

  async buildMessagePayload(
    channelId: string,
    workspaceId: string,
    templateMeta: { id?: string; metaId?: string; name?: string; variables?: Record<string, string> },
  ) {
    const template = await this.getTemplate(
      channelId,
      workspaceId,
      templateMeta.metaId ?? templateMeta.id ?? templateMeta.name ?? '',
    );

    return {
      payload: this.renderValue(template.payload, templateMeta.variables ?? {}),
      template: this.toResponse(template),
    };
  }

  private async getTemplate(
    channelId: string,
    workspaceId: string,
    templateId: string,
  ): Promise<MessengerTemplateCatalogItem> {
    const templateLookup: Prisma.MetaPageTemplateWhereInput[] = [
      { metaId: templateId },
      { name: templateId },
    ];

    if (this.isUuid(templateId)) {
      templateLookup.unshift({ id: templateId });
    }

    const row = await this.prisma.metaPageTemplate.findFirst({
      where: {
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: TEMPLATE_TYPE,
        OR: templateLookup,
      },
    });

    if (row) {
      return row.payload as unknown as MessengerTemplateCatalogItem;
    }

    const catalogTemplate = MESSENGER_TEMPLATE_CATALOG.find(
      (template) =>
        template.metaId === templateId ||
        template.name === templateId,
    );

    if (!catalogTemplate) {
      throw new NotFoundException('Messenger template not found');
    }

    return catalogTemplate;
  }

  private isUuid(value: unknown): value is string {
    return typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private toResponse(template: MessengerTemplateCatalogItem) {
    return {
      id: template.metaId,
      metaId: template.metaId,
      name: template.name,
      language: template.language,
      category: template.category,
      status: template.status,
      templateType: template.templateType,
      description: template.description,
      components: template.components,
      variables: template.variables,
    };
  }

  private renderValue(value: any, variables: Record<string, string>): any {
    if (typeof value === 'string') {
      return value.replace(
        /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
        (_match, key: string) => variables[key] ?? `{{${key}}}`,
      );
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.renderValue(entry, variables));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          this.renderValue(entry, variables),
        ]),
      );
    }

    return value;
  }

  private async findChannel(channelId: string, workspaceId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (
      !channel ||
      channel.workspaceId !== workspaceId ||
      channel.type !== 'messenger'
    ) {
      throw new NotFoundException('Messenger channel not found');
    }

    return channel;
  }
}
