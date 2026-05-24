import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  findUnsupportedVariableKeys,
  normalizeVariableTemplate,
  SNIPPET_VARIABLE_KEY_SET,
} from '../../common/variables/variable-metadata';
import { CreateSnippetDto, SnippetAttachmentDto, UpdateSnippetDto } from './dto/snippet.dto';

const SNIPPET_SELECT = {
  id: true,
  workspaceId: true,
  shortcut: true,
  name: true,
  content: true,
  topic: true,
  attachments: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SnippetSelect;

type SnippetRow = Prisma.SnippetGetPayload<{ select: typeof SNIPPET_SELECT }>;

export interface SnippetAttachmentResponse {
  type: string;
  url: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface SnippetResponse {
  id: string;
  workspaceId: string;
  shortcut: string;
  name: string;
  title: string;
  content: string;
  topic: string | null;
  attachments: SnippetAttachmentResponse[];
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class SnippetsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    workspaceId: string,
    dto: CreateSnippetDto,
    actorId?: string,
  ): Promise<SnippetResponse> {
    const data = this.normalizeCreateInput(dto);
    await this.assertShortcutAvailable(workspaceId, data.shortcut);

    const snippet = await this.prisma.snippet.create({
      data: {
        workspaceId,
        shortcut: data.shortcut,
        name: data.name,
        content: data.content,
        topic: data.topic,
        attachments:
          data.attachments.length > 0
            ? this.toAttachmentJson(data.attachments)
            : Prisma.JsonNull,
        createdById: actorId ?? null,
      },
      select: SNIPPET_SELECT,
    });

    return this.toResponse(snippet);
  }

  async findAll(
    workspaceId: string,
    opts?: { search?: string; topic?: string; page?: number; limit?: number },
  ): Promise<SnippetResponse[] | {
    items: SnippetResponse[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  }> {
    const where: Prisma.SnippetWhereInput = { workspaceId };
    const search = opts?.search?.trim();
    const topic = opts?.topic?.trim();

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { shortcut: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
        { topic: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (topic && topic !== 'all') {
      where.topic = { equals: topic, mode: 'insensitive' };
    }

    const orderBy: Prisma.SnippetOrderByWithRelationInput[] = [
      { updatedAt: 'desc' },
      { name: 'asc' },
    ];

    const hasPagination =
      typeof opts?.page === 'number' || typeof opts?.limit === 'number';

    if (!hasPagination) {
      const snippets = await this.prisma.snippet.findMany({
        where,
        orderBy,
        select: SNIPPET_SELECT,
      });

      return snippets.map((snippet) => this.toResponse(snippet));
    }

    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(Math.max(1, opts?.limit ?? 10), 100);

    const [snippets, total] = await this.prisma.$transaction([
      this.prisma.snippet.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        select: SNIPPET_SELECT,
      }),
      this.prisma.snippet.count({ where }),
    ]);

    return {
      items: snippets.map((snippet) => this.toResponse(snippet)),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  async findOne(workspaceId: string, id: string): Promise<SnippetResponse> {
    const snippet = await this.prisma.snippet.findFirst({
      where: { id, workspaceId },
      select: SNIPPET_SELECT,
    });

    if (!snippet) {
      throw new NotFoundException('Snippet not found');
    }

    return this.toResponse(snippet);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateSnippetDto,
    actorId?: string,
  ): Promise<SnippetResponse> {
    const existing = await this.prisma.snippet.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Snippet not found');
    }

    const data: Prisma.SnippetUpdateInput = {};

    if (dto.name !== undefined) {
      data.name = this.normalizeName(dto.name);
    }

    if (dto.shortcut !== undefined) {
      const shortcut = this.normalizeShortcut(dto.shortcut);
      await this.assertShortcutAvailable(workspaceId, shortcut, id);
      data.shortcut = shortcut;
    }

    if (dto.content !== undefined) {
      data.content = this.normalizeContent(dto.content);
    }

    if (dto.topic !== undefined) {
      data.topic = this.normalizeTopic(dto.topic);
    }

    if (dto.attachments !== undefined) {
      const attachments = this.normalizeAttachments(dto.attachments);
      data.attachments =
        attachments.length > 0
          ? this.toAttachmentJson(attachments)
          : Prisma.JsonNull;
    }

    data.updatedById = actorId ?? null;

    const snippet = await this.prisma.snippet.update({
      where: { id },
      data,
      select: SNIPPET_SELECT,
    });

    return this.toResponse(snippet);
  }

  async remove(workspaceId: string, id: string): Promise<{ deleted: true }> {
    const existing = await this.prisma.snippet.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Snippet not found');
    }

    await this.prisma.snippet.delete({ where: { id } });
    return { deleted: true };
  }

  private normalizeCreateInput(dto: CreateSnippetDto) {
    return {
      name: this.normalizeName(dto.name),
      shortcut: this.normalizeShortcut(dto.shortcut),
      content: this.normalizeContent(dto.content),
      topic: this.normalizeTopic(dto.topic),
      attachments: this.normalizeAttachments(dto.attachments),
    };
  }

  private normalizeName(value: string) {
    const name = value.trim();
    if (!name) {
      throw new BadRequestException('Snippet name is required');
    }
    return name;
  }

  private normalizeShortcut(value: string) {
    const raw = value.trim();
    const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
    const shortcut = prefixed.toLowerCase();

    if (!/^\/[a-z0-9][a-z0-9_-]{0,62}$/.test(shortcut)) {
      throw new BadRequestException(
        'Snippet ID can use letters, numbers, dashes, and underscores only',
      );
    }

    return shortcut;
  }

  private normalizeContent(value: string) {
    const content = value.trim();
    if (!content) {
      throw new BadRequestException('Snippet message is required');
    }

    const invalidVariables = findUnsupportedVariableKeys(
      content,
      SNIPPET_VARIABLE_KEY_SET,
    );

    if (invalidVariables.length > 0) {
      throw new BadRequestException(
        `Unsupported snippet variables: ${Array.from(new Set(invalidVariables)).join(', ')}`,
      );
    }

    return normalizeVariableTemplate(content);
  }

  private normalizeTopic(value?: string) {
    const topic = value?.trim();
    return topic || null;
  }

  private normalizeAttachments(
    attachments?: SnippetAttachmentDto[],
  ): SnippetAttachmentResponse[] {
    return (attachments ?? []).map((attachment) => {
      const type = attachment.type.trim();
      const url = attachment.url.trim();
      const name = attachment.name.trim();
      const mimeType = attachment.mimeType?.trim();

      if (!type || !url || !name) {
        throw new BadRequestException('Snippet attachment details are incomplete');
      }

      return {
        type,
        url,
        name,
        ...(mimeType ? { mimeType } : {}),
        ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      };
    });
  }

  private toAttachmentJson(
    attachments: SnippetAttachmentResponse[],
  ): Prisma.InputJsonArray {
    return attachments.map((attachment) => ({
      type: attachment.type,
      url: attachment.url,
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
    }));
  }

  private parseAttachments(value: Prisma.JsonValue | null): SnippetAttachmentResponse[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (!isRecord(item)) {
          return null;
        }

        const type = typeof item.type === 'string' ? item.type : null;
        const url = typeof item.url === 'string' ? item.url : null;
        const name = typeof item.name === 'string' ? item.name : null;

        if (!type || !url || !name) {
          return null;
        }

        return {
          type,
          url,
          name,
          ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
          ...(typeof item.size === 'number' ? { size: item.size } : {}),
        };
      })
      .filter((attachment): attachment is SnippetAttachmentResponse => Boolean(attachment));
  }

  private async assertShortcutAvailable(
    workspaceId: string,
    shortcut: string,
    ignoreSnippetId?: string,
  ) {
    const existing = await this.prisma.snippet.findFirst({
      where: {
        workspaceId,
        shortcut: { equals: shortcut, mode: 'insensitive' },
        ...(ignoreSnippetId ? { id: { not: ignoreSnippetId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('A snippet with this ID already exists');
    }
  }

  private toResponse(snippet: SnippetRow): SnippetResponse {
    return {
      id: snippet.id,
      workspaceId: snippet.workspaceId,
      shortcut: snippet.shortcut,
      name: snippet.name,
      title: snippet.name,
      content: snippet.content,
      topic: snippet.topic,
      attachments: this.parseAttachments(snippet.attachments),
      createdById: snippet.createdById,
      updatedById: snippet.updatedById,
      createdAt: snippet.createdAt,
      updatedAt: snippet.updatedAt,
    };
  }
}
