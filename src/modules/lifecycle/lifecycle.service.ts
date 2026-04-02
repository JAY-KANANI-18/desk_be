import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateLifecycleStageDto, UpdateLifecycleStageDto, ReorderStagesDto } from './lifecycle.helper';


@Injectable()
export class LifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async findAll(workspaceId: string): Promise<CreateLifecycleStageDto[]> {
    return this.prisma.lifecycleStage.findMany({
      where: { workspaceId },
      orderBy: [{ type: 'asc' }, { order: 'asc' }],
    });
  }

  async findOne(id: string, workspaceId: string): Promise<any> {
    const stage = await this.prisma.lifecycleStage.findFirst({
      where: { id, workspaceId },
    });
    if (!stage) throw new NotFoundException(`Lifecycle stage #${id} not found`);
    return stage;
  }

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateLifecycleStageDto, workspaceId: string): Promise<any> {
    console.log({ dto, workspaceId });
    
    const count = await this.prisma.lifecycleStage.count({
      where: { workspaceId, type: dto.type },
    });

    const shouldBeDefault =
      dto.isDefault ?? (dto.type === 'lifecycle' && count === 0);

    return this.prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.lifecycleStage.updateMany({
          where: { workspaceId },
          data: { isDefault: false },
        });
      }

      return tx.lifecycleStage.create({
        data: {
          workspaceId,
          name: dto.name,
          description: dto.description ?? '',
          emoji: dto.emoji ?? '⭐',
          type: dto.type,
          order: count + 1,
          isDefault: shouldBeDefault,
          isWon: dto.isWon ?? false,
        },
      });
    });
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateLifecycleStageDto,
    workspaceId: string,
  ): Promise<any> {
    await this.findOne(id, workspaceId); // throws 404 if not found

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.lifecycleStage.updateMany({
          where: { workspaceId },
          data: { isDefault: false },
        });
      }

      if (dto.isWon === true) {
        await tx.lifecycleStage.updateMany({
          where: { workspaceId },
          data: { isWon: false },
        });
      }

      return tx.lifecycleStage.update({
        where: { id },
        data: {
          ...(dto.name        !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.emoji       !== undefined && { emoji: dto.emoji }),
          ...(dto.isDefault   !== undefined && { isDefault: dto.isDefault }),
          ...(dto.isWon       !== undefined && { isWon: dto.isWon }),
        },
      });
    });
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  async remove(id: string, workspaceId: string): Promise<void> {
    const stage = await this.findOne(id, workspaceId);

    if (stage.isDefault) {
      throw new BadRequestException('Cannot delete the default lifecycle stage');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.lifecycleStage.delete({ where: { id } });

      // Re-index remaining stages in the same type bucket
      const remaining = await tx.lifecycleStage.findMany({
        where: { workspaceId, type: stage.type, order: { gt: stage.order } },
        orderBy: { order: 'asc' },
      });

      for (const s of remaining) {
        await tx.lifecycleStage.update({
          where: { id: s.id },
          data: { order: s.order - 1 },
        });
      }
    });
  }

  // ─── Reorder ───────────────────────────────────────────────────────────────

  async reorder(dto: ReorderStagesDto, workspaceId: string): Promise<any> {
    await this.prisma.$transaction(
      dto.stages.map(({ id, order }) =>
        this.prisma.lifecycleStage.updateMany({
          where: { id, workspaceId },
          data: { order },
        }),
      ),
    );

    return {success: true};
  }

  // ─── Toggle visibility ─────────────────────────────────────────────────────

  async toggleVisibility(workspaceId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    // Uncomment when you have lifecycleEnabled on your Workspace model:
    // await this.prisma.workspace.update({
    //   where: { id: workspaceId },
    //   data: { lifecycleEnabled: enabled },
    // });
    return { enabled };
  }
}