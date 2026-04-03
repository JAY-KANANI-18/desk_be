import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class UsageService {
  constructor(private prisma: PrismaService) {}

  private getPeriod(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  async increment(workspaceId: string, metric: string, amount = 1) {
    const period = this.getPeriod();

    return this.prisma.usage.upsert({
      where: {
        workspaceId_metric_period: {
          workspaceId,
          metric,
          period,
        },
      },
      update: {
        value: { increment: amount },
      },
      create: {
        workspaceId,
        metric,
        period,
        value: amount,
      },
    });
  }

  async set(workspaceId: string, metric: string, value: number) {
    const period = this.getPeriod();

    return this.prisma.usage.upsert({
      where: {
        workspaceId_metric_period: {
          workspaceId,
          metric,
          period,
        },
      },
      update: { value },
      create: {
        workspaceId,
        metric,
        period,
        value,
      },
    });
  }

  async getUsage(workspaceId: string, metric: string) {
    const period = this.getPeriod();

    const row = await this.prisma.usage.findUnique({
      where: {
        workspaceId_metric_period: {
          workspaceId,
          metric,
          period,
        },
      },
    });

    return row?.value || 0;
  }

  async getUsageMap(workspaceId: string) {
    const period = this.getPeriod();

    const rows = await this.prisma.usage.findMany({
      where: { workspaceId, period },
    });

    return rows.reduce((acc, row) => {
      acc[row.metric] = row.value;
      return acc;
    }, {} as Record<string, number>);
  }
}