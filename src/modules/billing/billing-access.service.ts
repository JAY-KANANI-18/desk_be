import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { PLANS } from './plans.config';
import { UsageService } from './usage/usage.service';
import { BillingFeature, BillingMetric } from './types/billing.types';

@Injectable()
export class BillingAccessService {
  constructor(
    private prisma: PrismaService,
    private usageService: UsageService,
  ) {}

  async getWorkspacePlan(workspaceId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });

    const planKey = subscription?.plan || 'trial';
    const plan = PLANS[planKey] || PLANS.trial;

    return {
      subscription,
      plan,
      planKey,
    };
  }

  async requireFeature(workspaceId: string, feature: BillingFeature) {
    const { subscription, plan } = await this.getWorkspacePlan(workspaceId);

    if (!subscription) {
      throw new ForbiddenException('No active subscription');
    }

    if (['expired', 'cancelled', 'paused', 'unpaid'].includes(subscription.status)) {
      throw new ForbiddenException('Subscription inactive');
    }

    if (!plan.features[feature]) {
      throw new ForbiddenException(`Upgrade plan to use ${feature}`);
    }

    return true;
  }

  async requireLimit(workspaceId: string, metric: BillingMetric) {
    const { subscription, plan } = await this.getWorkspacePlan(workspaceId);

    if (!subscription) {
      throw new ForbiddenException('No active subscription');
    }

    if (['expired', 'cancelled', 'paused', 'unpaid'].includes(subscription.status)) {
      throw new ForbiddenException('Subscription inactive');
    }

    const current = await this.usageService.getUsage(workspaceId, metric);
    const limit = plan.limits[metric];

    if (typeof limit === 'number' && current >= limit) {
      throw new ForbiddenException(`${metric} limit reached`);
    }

    return true;
  }
}