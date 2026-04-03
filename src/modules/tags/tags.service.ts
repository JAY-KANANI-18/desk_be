import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    workspaceId: string,
    body: { name: string; color?: string },
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
        color: body.color || '#000000',
      },
      select: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return tag
  
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
        color: true,
        createdAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return tags;
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
        color: true,
        createdAt: true,
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

    return tag;
  }

  async update(
    workspaceId: string,
    id: string,
    body: { name?: string; color?: string },
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
      updateData.color = body.color || '#000000';
    }

    const updated = await this.prisma.tag.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        _count: {
          select: {
            contacts: true,
          },
        },
      },
    });

    return updated;
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