import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  private toTagResponse(tag: {
    id: string;
    name: string;
    workspaceId: string;
    createdAt: Date;
    updatedAt: Date;
    color: string;
    emoji: string;
    description: string | null;
    createdBy: string;
    createdById: string | null;
    updatedById: string | null;
    _count: { contacts: number };
  }) {
    return {
      id: tag.id,
      name: tag.name,
      workspaceId: tag.workspaceId,
      spaceId: tag.workspaceId,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
      createdBy: tag.createdBy,
      createdById: tag.createdById,
      updatedById: tag.updatedById,
      color: tag.color,
      emoji: tag.emoji,
      description: tag.description,
      bundle: {
        color: tag.color,
        emoji: tag.emoji,
        description: tag.description,
      },
      count: tag._count.contacts,
    };
  }

  async create(
    workspaceId: string,
    body: { name: string; color?: string; emoji?: string; description?: string },
    actorId?: string,
  ) {
    const name = body.name?.trim();

    if (!name) {
      throw new BadRequestException('Tag name is required');
    }

    const existing = await this.prisma.tag.findFirst({
      where: {
        workspaceId,
        name: {
          equals: name,
          mode: 'insensitive',
        },
      },
    });

    if (existing) {
      throw new BadRequestException('Tag with this name already exists');
    }

    const tag = await this.prisma.tag.create({
      data: {
        workspaceId,
        name,
        color: body.color || 'tag-indigo',
        emoji: body.emoji?.trim() || '🏷️',
        description: body.description?.trim() || null,
        createdBy: 'user',
        createdById: actorId ?? null,
      },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        updatedAt: true,
        color: true,
        emoji: true,
        description: true,
        createdBy: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return this.toTagResponse(tag);
  
  }

  async findAll(workspaceId: string, search?: string) {
    const tags = await this.prisma.tag.findMany({
      where: {
        workspaceId,
        ...(search?.trim()
          ? {
              name: {
                contains: search.trim(),
                mode: 'insensitive',
              },
            }
          : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        color: true,
        emoji: true,
        description: true,
        createdBy: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return tags.map((tag) => this.toTagResponse(tag));
  }

  async findOne(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({
      where: {
        id,
        workspaceId,
      },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        color: true,
        emoji: true,
        description: true,
        createdBy: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    if (!tag) {
      throw new NotFoundException('Tag not found');
    }

    return this.toTagResponse(tag);
  }

  async update(
    workspaceId: string,
    id: string,
    body: { name?: string; color?: string; emoji?: string; description?: string },
    actorId?: string,
  ) {
    const existingTag = await this.prisma.tag.findFirst({
      where: {
        id,
        workspaceId,
      },
    });

    if (!existingTag) {
      throw new NotFoundException('Tag not found');
    }

    const updateData: any = {};

    if (body.name !== undefined) {
      const name = body.name.trim();

      if (!name) {
        throw new BadRequestException('Tag name cannot be empty');
      }

      const duplicate = await this.prisma.tag.findFirst({
        where: {
          workspaceId,
          id: { not: id },
          name: {
            equals: name,
            mode: 'insensitive',
          },
        },
      });

      if (duplicate) {
        throw new BadRequestException('Another tag with this name already exists');
      }

      updateData.name = name;
    }

    if (body.color !== undefined) {
      updateData.color = body.color || 'tag-indigo';
    }

    if (body.emoji !== undefined) {
      updateData.emoji = body.emoji?.trim() || '🏷️';
    }

    if (body.description !== undefined) {
      updateData.description = body.description?.trim() || null;
    }

    updateData.updatedById = actorId ?? null;

    const updated = await this.prisma.tag.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        workspaceId: true,
        color: true,
        emoji: true,
        description: true,
        createdBy: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return this.toTagResponse(updated);
  }

  async remove(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({
      where: {
        id,
        workspaceId,
      },
      include: {
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    if (!tag) {
      throw new NotFoundException('Tag not found');
    }

    // Optional protection
    if (tag._count.contacts > 0) {
      throw new BadRequestException(
        'Cannot delete this tag because it is assigned to contacts',
      );
    }

    await this.prisma.tag.delete({
      where: { id },
    });

    return 
  }
}
