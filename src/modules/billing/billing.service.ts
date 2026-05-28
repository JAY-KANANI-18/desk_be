import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PLANS } from './plans.config';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { RazorpayService } from './providers/razorpay.service';
import { StripeService } from './providers/stripe.service';
import { UsageService } from './usage/usage.service';
import { IsInt, Min } from 'class-validator';
import { Cron } from '@nestjs/schedule';
import type {
  Prisma,
  Subscription,
  SubscriptionOperation,
} from '@prisma/client';

type RazorpaySubscriptionLike = {
  id?: string;
  status?: string;
  customer_id?: string;
  notes?: {
    workspaceId?: string;
    plan?: string;
    replacedSubscription?: string;
  };
  current_start?: number;
  current_end?: number;
  charge_at?: number;
};

const RAZORPAY_OPERATION_TYPE = {
  REPLACE_SUBSCRIPTION: 'replace_subscription',
  CANCEL_SUBSCRIPTION: 'cancel_subscription',
} as const;

const RAZORPAY_OPERATION_STATUS = {
  PENDING: 'pending',
  CLEANUP_PENDING: 'cleanup_pending',
  CANCEL_REQUESTED: 'cancel_requested',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  FAILED: 'failed',
} as const;

const RAZORPAY_LEGACY_RETRYING_STATUS = 'retrying';

type RazorpayOperationStatus =
  (typeof RAZORPAY_OPERATION_STATUS)[keyof typeof RAZORPAY_OPERATION_STATUS];

const RAZORPAY_OPERATION_TERMINAL_STATUSES = [
  RAZORPAY_OPERATION_STATUS.COMPLETED,
  RAZORPAY_OPERATION_STATUS.ABANDONED,
] as const;

const RAZORPAY_OPERATION_WORKER_STATUSES = [
  RAZORPAY_OPERATION_STATUS.PENDING,
  RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
  RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
  RAZORPAY_OPERATION_STATUS.FAILED,
  RAZORPAY_LEGACY_RETRYING_STATUS,
] as const;

const RAZORPAY_WIDE_RECONCILE_INTERVAL_MINUTES = 30;

// dto/update-quantity.dto.ts
export class UpdateQuantityDto {
  @IsInt() @Min(1) quantity: number;
}

// dto/add-mac-addon.dto.ts
export class AddMacAddonDto {
  @IsInt() @Min(500) contacts: number;
}
@Injectable()
export class BillingService {
  private readonly checkoutLocks = new Set<string>();
  private readonly razorpayOperationLockMs = 5 * 60_000;

  constructor(
    private prisma: PrismaService,
    private razorpayService: RazorpayService,
    private stripeService: StripeService,
    private usageService: UsageService,
  ) {}

  private async withCheckoutLock<T>(
    workspaceId: string,
    action: () => Promise<T>,
  ) {
    if (this.checkoutLocks.has(workspaceId)) {
      throw new BadRequestException(
        'Checkout already in progress. Please wait a few seconds.',
      );
    }

    this.checkoutLocks.add(workspaceId);
    try {
      return await action();
    } finally {
      this.checkoutLocks.delete(workspaceId);
    }
  }

  private hasActivePaidSubscription(subscription: Subscription | null) {
    return Boolean(
      subscription &&
      subscription.plan !== 'trial' &&
      subscription.status === 'active' &&
      subscription.provider &&
      subscription.providerSubId,
    );
  }

  private isReusableRazorpaySubscription(subscription: any, planKey: string) {
    const status = String(subscription?.status || '').toLowerCase();
    const providerPlan = subscription?.notes?.plan;
    const expectedPlanId = PLANS[planKey]?.razorpayPlanId;

    return Boolean(
      subscription?.id &&
      !['cancelled', 'completed', 'expired'].includes(status) &&
      (!expectedPlanId ||
        !subscription?.plan_id ||
        subscription.plan_id === expectedPlanId) &&
      (!providerPlan || providerPlan === planKey),
    );
  }

  private async cancelRazorpaySubscriptionIfPossible(
    subscriptionId?: string | null,
    cancelAtCycleEnd = true,
  ) {
    if (!subscriptionId) return null;

    const result = await this.razorpayService.cancelSubscriptionIfPossible(
      subscriptionId,
      cancelAtCycleEnd,
    );
    if (result.status === 'deferred') {
      console.warn('Razorpay subscription cancellation deferred', {
        subscriptionId,
        reason: result.reason,
      });
    }

    return result;
  }

  private calculateProratedPlanRefund(subscription: Subscription) {
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
      return 0;
    }

    const start = new Date(subscription.currentPeriodStart).getTime();
    const end = new Date(subscription.currentPeriodEnd).getTime();
    const now = Date.now();
    const totalMs = end - start;

    if (totalMs <= 0 || now >= end) {
      return 0;
    }

    const currentPlanConfig = PLANS[subscription.plan];
    const currentMonthlyAmount = currentPlanConfig?.monthlyAmount || 0;
    const remainingFraction = Math.max(0, (end - now) / totalMs);

    return Math.max(0, Math.round(currentMonthlyAmount * remainingFraction));
  }

  private async findLatestRazorpayPaymentForProviderSubscription(
    subscriptionId: string,
    workspaceId: string,
    providerSubId: string,
  ) {
    const payments = await this.prisma.payment.findMany({
      where: {
        workspaceId,
        subscriptionId,
        provider: 'razorpay',
        status: 'paid',
        providerPaymentId: { not: null },
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });

    return (
      payments.find((payment) => {
        const metadata = payment.metadata as {
          subscription_id?: string;
        } | null;
        return metadata?.subscription_id === providerSubId;
      }) || null
    );
  }

  private async refundReplacementCredit(params: {
    subscription: Subscription;
    replacedProviderSubId?: string | null;
    replacementProviderSubId: string;
  }) {
    const refundAmount = params.subscription.lastRefundAmount || 0;
    if (!params.replacedProviderSubId || refundAmount <= 0) return;
    if (
      params.subscription.lastRefundStatus &&
      params.subscription.lastRefundStatus !== 'pending'
    )
      return;

    const payment = await this.findLatestRazorpayPaymentForProviderSubscription(
      params.subscription.id,
      params.subscription.workspaceId,
      params.replacedProviderSubId,
    );

    if (!payment?.providerPaymentId) {
      console.warn(
        'Unable to refund replacement credit; previous Razorpay payment not found',
        {
          workspaceId: params.subscription.workspaceId,
          replacedProviderSubId: params.replacedProviderSubId,
          refundAmount,
        },
      );
      return;
    }

    const refund = await this.razorpayService.refundPayment(
      payment.providerPaymentId,
      {
        amount: refundAmount,
        notes: {
          workspaceId: params.subscription.workspaceId,
          replacedSubscription: params.replacedProviderSubId,
          replacementSubscription: params.replacementProviderSubId,
        },
      },
    );

    await this.prisma.subscription.update({
      where: { id: params.subscription.id },
      data: {
        lastRefundStatus: refund?.status || 'initiated',
        lastRefundAt: new Date(),
      },
    });
  }

  private getRazorpayCleanupDelayMs(attempt: number) {
    const retryDelaysMs = [60_000, 300_000, 900_000, 1_800_000];
    return retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
  }

  private getRazorpayCancellationVerificationDelayMs(attempt: number) {
    const retryDelaysMs = [300_000, 900_000, 1_800_000, 3_600_000];
    return retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
  }

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Unknown error';
  }

  private buildRazorpayReplacementOperationKey(params: {
    workspaceId: string;
    oldProviderSubId: string;
    newProviderSubId: string;
  }) {
    return [
      'razorpay',
      RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
      params.workspaceId,
      params.oldProviderSubId,
      params.newProviderSubId,
    ].join(':');
  }

  private buildRazorpayCancelOperationKey(params: {
    workspaceId: string;
    providerSubId: string;
  }) {
    return [
      'razorpay',
      RAZORPAY_OPERATION_TYPE.CANCEL_SUBSCRIPTION,
      params.workspaceId,
      params.providerSubId,
    ].join(':');
  }

  private isTerminalRazorpayOperationStatus(status: string) {
    return RAZORPAY_OPERATION_TERMINAL_STATUSES.includes(
      status as (typeof RAZORPAY_OPERATION_TERMINAL_STATUSES)[number],
    );
  }

  private nextRazorpayOperationStatus(
    existingStatus: string | undefined,
    requestedStatus: RazorpayOperationStatus,
  ): RazorpayOperationStatus {
    if (
      existingStatus &&
      this.isTerminalRazorpayOperationStatus(existingStatus)
    ) {
      return existingStatus as RazorpayOperationStatus;
    }

    if (
      existingStatus === RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED &&
      requestedStatus !== RAZORPAY_OPERATION_STATUS.COMPLETED &&
      requestedStatus !== RAZORPAY_OPERATION_STATUS.ABANDONED &&
      requestedStatus !== RAZORPAY_OPERATION_STATUS.FAILED
    ) {
      return RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED;
    }

    if (
      existingStatus === RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING &&
      requestedStatus === RAZORPAY_OPERATION_STATUS.PENDING
    ) {
      return RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING;
    }

    return requestedStatus;
  }

  private async upsertRazorpayReplacementOperation(params: {
    workspaceId: string;
    oldProviderSubId?: string | null;
    newProviderSubId?: string | null;
    plan?: string | null;
    status: RazorpayOperationStatus;
    retryCount?: number;
    nextRetryAt?: Date;
    lastError?: string | null;
    refundAmount?: number;
  }) {
    if (
      !params.oldProviderSubId ||
      !params.newProviderSubId ||
      params.oldProviderSubId === params.newProviderSubId
    ) {
      return null;
    }

    const operationKey = this.buildRazorpayReplacementOperationKey({
      workspaceId: params.workspaceId,
      oldProviderSubId: params.oldProviderSubId,
      newProviderSubId: params.newProviderSubId,
    });
    const existingOperation =
      await this.prisma.subscriptionOperation.findUnique({
        where: { operationKey },
      });
    const status = this.nextRazorpayOperationStatus(
      existingOperation?.status,
      params.status,
    );

    const retryCount = params.retryCount ?? existingOperation?.retryCount ?? 0;
    const nextRetryAt =
      params.nextRetryAt ??
      new Date(Date.now() + this.getRazorpayCleanupDelayMs(retryCount));
    const metadata =
      typeof params.refundAmount === 'number'
        ? { refundAmount: params.refundAmount }
        : undefined;

    if (existingOperation) {
      return this.prisma.subscriptionOperation.update({
        where: { id: existingOperation.id },
        data: {
          status,
          plan: params.plan ?? existingOperation.plan,
          retryCount,
          nextRetryAt,
          lastError: params.lastError ?? existingOperation.lastError,
          metadata,
        },
      });
    }

    const createData = {
      operationKey,
      workspaceId: params.workspaceId,
      provider: 'razorpay',
      type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
      status,
      oldProviderSubId: params.oldProviderSubId,
      newProviderSubId: params.newProviderSubId,
      plan: params.plan,
      retryCount,
      nextRetryAt,
      lastError: params.lastError,
      metadata,
    };

    try {
      return await this.prisma.subscriptionOperation.create({
        data: createData,
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;

      const operation = await this.prisma.subscriptionOperation.findUnique({
        where: { operationKey },
      });
      if (!operation) throw error;

      return this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: this.nextRazorpayOperationStatus(
            operation.status,
            params.status,
          ),
          plan: params.plan ?? operation.plan,
          retryCount: params.retryCount ?? operation.retryCount,
          nextRetryAt: params.nextRetryAt ?? operation.nextRetryAt,
          lastError: params.lastError ?? operation.lastError,
          metadata,
        },
      });
    }
  }

  private async upsertRazorpayCancelOperation(params: {
    workspaceId: string;
    providerSubId?: string | null;
    cancelAtCycleEnd: boolean;
    status?: RazorpayOperationStatus;
    retryCount?: number;
    nextRetryAt?: Date;
    lastError?: string | null;
  }) {
    if (!params.providerSubId) return null;

    const operationKey = this.buildRazorpayCancelOperationKey({
      workspaceId: params.workspaceId,
      providerSubId: params.providerSubId,
    });
    const existingOperation =
      await this.prisma.subscriptionOperation.findUnique({
        where: { operationKey },
      });
    const requestedStatus =
      params.status ?? RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING;
    const status = this.nextRazorpayOperationStatus(
      existingOperation?.status,
      requestedStatus,
    );
    const retryCount = params.retryCount ?? existingOperation?.retryCount ?? 0;
    const nextRetryAt = params.nextRetryAt ?? new Date();
    const metadata = { cancelAtCycleEnd: params.cancelAtCycleEnd };

    if (existingOperation) {
      return this.prisma.subscriptionOperation.update({
        where: { id: existingOperation.id },
        data: {
          status,
          retryCount,
          nextRetryAt,
          lastError: params.lastError ?? existingOperation.lastError,
          metadata,
        },
      });
    }

    try {
      return await this.prisma.subscriptionOperation.create({
        data: {
          operationKey,
          workspaceId: params.workspaceId,
          provider: 'razorpay',
          type: RAZORPAY_OPERATION_TYPE.CANCEL_SUBSCRIPTION,
          status,
          oldProviderSubId: params.providerSubId,
          retryCount,
          nextRetryAt,
          lastError: params.lastError,
          metadata,
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      return this.upsertRazorpayCancelOperation(params);
    }
  }

  private async markRazorpayReplacementOperationCompleted(params: {
    workspaceId: string;
    replacedProviderSubId: string;
    replacementProviderSubId: string;
  }) {
    await this.prisma.subscriptionOperation.updateMany({
      where: {
        workspaceId: params.workspaceId,
        provider: 'razorpay',
        type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
        oldProviderSubId: params.replacedProviderSubId,
        newProviderSubId: params.replacementProviderSubId,
        status: { notIn: [...RAZORPAY_OPERATION_TERMINAL_STATUSES] },
      },
      data: {
        status: RAZORPAY_OPERATION_STATUS.COMPLETED,
        lastError: null,
        nextRetryAt: new Date(),
      },
    });
  }

  private queueRazorpayReplacementCleanup(params: {
    workspaceId: string;
    replacedProviderSubId: string;
    replacementProviderSubId: string;
    attempt?: number;
    lastError?: string;
  }) {
    void this.scheduleRazorpayReplacementCleanup(params).catch((error) => {
      console.error('Failed to queue Razorpay replacement cleanup', {
        workspaceId: params.workspaceId,
        replacedProviderSubId: params.replacedProviderSubId,
        replacementProviderSubId: params.replacementProviderSubId,
        error,
      });
    });
  }

  private async scheduleRazorpayReplacementCleanup(params: {
    workspaceId: string;
    replacedProviderSubId: string;
    replacementProviderSubId: string;
    attempt?: number;
    lastError?: string;
  }) {
    const attempt = params.attempt ?? 0;
    const delayMs = this.getRazorpayCleanupDelayMs(attempt);
    const nextRetryAt = new Date(Date.now() + delayMs);

    await this.upsertRazorpayReplacementOperation({
      workspaceId: params.workspaceId,
      oldProviderSubId: params.replacedProviderSubId,
      newProviderSubId: params.replacementProviderSubId,
      status: RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
      retryCount: attempt,
      nextRetryAt,
      lastError: params.lastError,
    });
  }

  private async finalizeReplacedRazorpaySubscription(params: {
    subscription: Subscription;
    replacedProviderSubId?: string | null;
    replacementProviderSubId: string;
    attempt?: number;
  }) {
    if (
      !params.replacedProviderSubId ||
      params.replacedProviderSubId === params.replacementProviderSubId
    ) {
      return;
    }

    const existingOperation = await this.prisma.subscriptionOperation.findFirst(
      {
        where: {
          workspaceId: params.subscription.workspaceId,
          provider: 'razorpay',
          type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
          oldProviderSubId: params.replacedProviderSubId,
          newProviderSubId: params.replacementProviderSubId,
          status: RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
        },
        orderBy: { updatedAt: 'desc' },
      },
    );

    if (existingOperation) {
      await this.verifyRazorpayReplacementCancellation(
        existingOperation,
        params.subscription,
      );
      return;
    }

    const attempt = params.attempt ?? 0;
    console.info('Razorpay replacement cleanup started', {
      workspaceId: params.subscription.workspaceId,
      replacedProviderSubId: params.replacedProviderSubId,
      replacementProviderSubId: params.replacementProviderSubId,
      attempt,
    });

    const result = await this.cancelRazorpaySubscriptionIfPossible(
      params.replacedProviderSubId,
      false,
    );
    const returnedProviderStatus = String(
      result?.subscription?.status || '',
    ).toLowerCase();
    console.info('Razorpay replacement cancel returned', {
      workspaceId: params.subscription.workspaceId,
      replacedProviderSubId: params.replacedProviderSubId,
      replacementProviderSubId: params.replacementProviderSubId,
      attempt,
      cancelResult: result?.status,
      cancelReason: result?.reason,
      returnedProviderStatus: returnedProviderStatus || null,
    });

    if (result?.status === 'deferred') {
      await this.scheduleRazorpayReplacementCleanup({
        workspaceId: params.subscription.workspaceId,
        replacedProviderSubId: params.replacedProviderSubId,
        replacementProviderSubId: params.replacementProviderSubId,
        attempt: attempt + 1,
        lastError: result.reason,
      });
      return;
    }

    if (result?.status === 'not_started') {
      const retryCount = attempt + 1;
      await this.upsertRazorpayReplacementOperation({
        workspaceId: params.subscription.workspaceId,
        oldProviderSubId: params.replacedProviderSubId,
        newProviderSubId: params.replacementProviderSubId,
        status: RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
        retryCount,
        nextRetryAt: new Date(
          Date.now() + this.getRazorpayCleanupDelayMs(retryCount),
        ),
        lastError: result.reason,
      });
      return;
    }

    let verifiedOldStatus = returnedProviderStatus;
    if (
      !verifiedOldStatus ||
      !this.isTerminalRazorpaySubscriptionStatus(verifiedOldStatus)
    ) {
      const verifiedOld = await this.fetchRazorpaySubscriptionStatus(
        params.replacedProviderSubId,
      );
      verifiedOldStatus = verifiedOld.status;
    }

    if (!this.isTerminalRazorpaySubscriptionStatus(verifiedOldStatus)) {
      const retryCount = attempt + 1;
      const lastError = `Cancel requested; old Razorpay subscription still ${verifiedOldStatus}`;
      console.warn(
        'Razorpay replacement cancellation requested; verification will continue without another cancel call',
        {
          workspaceId: params.subscription.workspaceId,
          replacedProviderSubId: params.replacedProviderSubId,
          replacementProviderSubId: params.replacementProviderSubId,
          attempt,
          cancelResult: result?.status,
          cancelReason: result?.reason,
          verifiedOldStatus,
        },
      );

      await this.upsertRazorpayReplacementOperation({
        workspaceId: params.subscription.workspaceId,
        oldProviderSubId: params.replacedProviderSubId,
        newProviderSubId: params.replacementProviderSubId,
        status: RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
        retryCount,
        nextRetryAt: new Date(
          Date.now() +
            this.getRazorpayCancellationVerificationDelayMs(retryCount),
        ),
        lastError,
      });
      return;
    }

    await this.markRazorpayReplacementOperationCompleted({
      workspaceId: params.subscription.workspaceId,
      replacedProviderSubId: params.replacedProviderSubId,
      replacementProviderSubId: params.replacementProviderSubId,
    });

    console.info('Razorpay replacement cleanup completed', {
      workspaceId: params.subscription.workspaceId,
      replacedProviderSubId: params.replacedProviderSubId,
      replacementProviderSubId: params.replacementProviderSubId,
      attempt,
      verifiedOldStatus,
    });

    try {
      await this.refundReplacementCredit({
        subscription: params.subscription,
        replacedProviderSubId: params.replacedProviderSubId,
        replacementProviderSubId: params.replacementProviderSubId,
      });
    } catch (error) {
      console.error('Failed to refund Razorpay replacement credit', {
        workspaceId: params.subscription.workspaceId,
        replacedProviderSubId: params.replacedProviderSubId,
        replacementProviderSubId: params.replacementProviderSubId,
        error,
      });
    }
  }

  private async cleanupRazorpayWorkspaceSubscriptions(params: {
    workspaceId: string;
    customerId?: string | null;
    keepSubscriptionId: string;
    pendingSubscriptionId?: string | null;
  }) {
    if (!params.customerId) return;

    try {
      const subscriptions = await this.razorpayService.listSubscriptions({
        customerId: params.customerId,
        count: 100,
      });

      const cancellableStatuses = new Set([
        'authenticated',
        'active',
        'pending',
        'halted',
      ]);
      const duplicateSubscriptions = (subscriptions?.items || [])
        .filter(
          (item: any) =>
            item?.id &&
            item.id !== params.keepSubscriptionId &&
            item.id !== params.pendingSubscriptionId &&
            item?.notes?.workspaceId === params.workspaceId &&
            (!params.customerId || item?.customer_id === params.customerId) &&
            cancellableStatuses.has(String(item?.status || '').toLowerCase()),
        )
        .sort(
          (a: any, b: any) =>
            Number(a?.created_at || 0) - Number(b?.created_at || 0),
        );

      for (const duplicate of duplicateSubscriptions.slice(0, 10)) {
        const replacementOperation =
          await this.prisma.subscriptionOperation.findFirst({
            where: {
              workspaceId: params.workspaceId,
              provider: 'razorpay',
              type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
              oldProviderSubId: duplicate.id,
              newProviderSubId: params.keepSubscriptionId,
              status: {
                notIn: [...RAZORPAY_OPERATION_TERMINAL_STATUSES],
              },
            },
            select: { id: true },
          });

        if (replacementOperation) continue;

        await this.upsertRazorpayCancelOperation({
          workspaceId: params.workspaceId,
          providerSubId: duplicate.id,
          cancelAtCycleEnd: false,
          status: RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
          lastError: 'Duplicate Razorpay subscription discovered by reconciler',
        });
      }
    } catch (error) {
      console.error(
        'Failed to cleanup duplicate Razorpay subscriptions',
        error,
      );
    }
  }

  private getRazorpayDate(seconds?: number | null) {
    return typeof seconds === 'number' && seconds > 0
      ? new Date(seconds * 1000)
      : null;
  }

  private isPendingRazorpaySubscriptionStatus(status: string) {
    return ['created', 'authenticated', 'pending', 'halted'].includes(status);
  }

  private isActiveLikeRazorpaySubscriptionStatus(status: string) {
    return ['active', 'authenticated', 'resumed'].includes(status);
  }

  private isTerminalRazorpaySubscriptionStatus(status: string) {
    return ['cancelled', 'completed', 'expired'].includes(status);
  }

  private mapRazorpaySubscriptionStatus(status: string) {
    const normalised = String(status || '').toLowerCase();
    const map: Record<string, string> = {
      active: 'active',
      authenticated: 'active',
      resumed: 'active',
      pending: 'past_due',
      halted: 'past_due',
      paused: 'paused',
      cancelled: 'cancelled',
      completed: 'cancelled',
      expired: 'expired',
    };

    return map[normalised] || 'past_due';
  }

  private async fetchRazorpaySubscriptionStatus(subscriptionId: string) {
    const subscription = (await this.razorpayService.fetchSubscription(
      subscriptionId,
    )) as RazorpaySubscriptionLike;
    return {
      subscription,
      status: String(subscription?.status || 'unknown').toLowerCase(),
    };
  }

  private async syncCurrentRazorpaySubscriptionStatus(
    subscription: Subscription,
  ) {
    if (!subscription.providerSubId) return subscription;

    const providerSubscription = await this.fetchRazorpaySubscriptionStatus(
      subscription.providerSubId,
    );
    const mappedStatus = this.mapRazorpaySubscriptionStatus(
      providerSubscription.status,
    );
    const providerEntity = providerSubscription.subscription;

    if (
      subscription.status === mappedStatus &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd
    ) {
      return subscription;
    }

    return this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: mappedStatus,
        cancelAtPeriodEnd: this.isTerminalRazorpaySubscriptionStatus(
          providerSubscription.status,
        )
          ? false
          : subscription.cancelAtPeriodEnd,
        currentPeriodStart:
          this.getRazorpayDate(providerEntity.current_start) ||
          subscription.currentPeriodStart,
        currentPeriodEnd:
          this.getRazorpayDate(providerEntity.current_end) ||
          this.getRazorpayDate(providerEntity.charge_at) ||
          subscription.currentPeriodEnd,
      },
    });
  }

  private async activateRazorpayReplacement(params: {
    subscription: Subscription;
    replacement: RazorpaySubscriptionLike;
    replacementProviderSubId: string;
    replacedProviderSubId?: string | null;
    plan?: string | null;
  }) {
    const nextPlan =
      params.plan ||
      params.replacement.notes?.plan ||
      params.subscription.pendingPlan ||
      params.subscription.plan;

    const updated = await this.prisma.subscription.update({
      where: { id: params.subscription.id },
      data: {
        provider: 'razorpay',
        providerCustomerId:
          params.replacement.customer_id ||
          params.subscription.providerCustomerId,
        providerSubId: params.replacementProviderSubId,
        plan: nextPlan,
        status: 'active',
        pendingPlan: null,
        pendingEffectiveAt: null,
        pendingProviderSubId: null,
        currentPeriodStart:
          this.getRazorpayDate(params.replacement.current_start) ||
          params.subscription.currentPeriodStart,
        currentPeriodEnd:
          this.getRazorpayDate(params.replacement.current_end) ||
          this.getRazorpayDate(params.replacement.charge_at) ||
          params.subscription.currentPeriodEnd,
      },
    });

    if (
      params.replacedProviderSubId &&
      params.replacedProviderSubId !== params.replacementProviderSubId
    ) {
      this.queueRazorpayReplacementCleanup({
        workspaceId: params.subscription.workspaceId,
        replacedProviderSubId: params.replacedProviderSubId,
        replacementProviderSubId: params.replacementProviderSubId,
      });
    }

    return updated;
  }

  private async deferRazorpayOperation(
    operation: SubscriptionOperation,
    lastError: string,
  ) {
    const retryCount = operation.retryCount + 1;
    const status =
      operation.status === RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING
        ? RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING
        : RAZORPAY_OPERATION_STATUS.PENDING;

    await this.prisma.subscriptionOperation.update({
      where: { id: operation.id },
      data: {
        status,
        retryCount,
        nextRetryAt: new Date(
          Date.now() + this.getRazorpayCleanupDelayMs(retryCount),
        ),
        lastError,
      },
    });
  }

  private async verifyRazorpayReplacementCancellation(
    operation: SubscriptionOperation,
    subscription: Subscription,
  ) {
    if (!operation.oldProviderSubId || !operation.newProviderSubId) {
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.ABANDONED,
          lastError:
            'Cancellation verification is missing old or new subscription id',
        },
      });
      return;
    }

    const oldSubscription = await this.fetchRazorpaySubscriptionStatus(
      operation.oldProviderSubId,
    );
    console.info(
      'Verifying Razorpay replacement cancellation without issuing cancel',
      {
        operationId: operation.id,
        workspaceId: operation.workspaceId,
        oldProviderSubId: operation.oldProviderSubId,
        newProviderSubId: operation.newProviderSubId,
        oldProviderStatus: oldSubscription.status,
        retryCount: operation.retryCount,
      },
    );

    if (this.isTerminalRazorpaySubscriptionStatus(oldSubscription.status)) {
      await this.markRazorpayReplacementOperationCompleted({
        workspaceId: operation.workspaceId,
        replacedProviderSubId: operation.oldProviderSubId,
        replacementProviderSubId: operation.newProviderSubId,
      });

      await this.refundReplacementCredit({
        subscription,
        replacedProviderSubId: operation.oldProviderSubId,
        replacementProviderSubId: operation.newProviderSubId,
      });
      return;
    }

    const retryCount = operation.retryCount + 1;
    await this.prisma.subscriptionOperation.update({
      where: { id: operation.id },
      data: {
        status: RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
        retryCount,
        nextRetryAt: new Date(
          Date.now() +
            this.getRazorpayCancellationVerificationDelayMs(retryCount),
        ),
        lastError: `Cancel requested; old Razorpay subscription still ${oldSubscription.status}`,
      },
    });
  }

  private async processRazorpaySubscriptionOperation(
    operation: SubscriptionOperation,
  ) {
    if (operation.provider !== 'razorpay') {
      return;
    }

    if (operation.type === RAZORPAY_OPERATION_TYPE.CANCEL_SUBSCRIPTION) {
      await this.processRazorpayCancelSubscriptionOperation(operation);
      return;
    }

    if (operation.type !== RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION) return;

    console.info('Processing Razorpay subscription operation', {
      operationId: operation.id,
      workspaceId: operation.workspaceId,
      status: operation.status,
      oldProviderSubId: operation.oldProviderSubId,
      newProviderSubId: operation.newProviderSubId,
      retryCount: operation.retryCount,
    });

    if (!operation.newProviderSubId) {
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.ABANDONED,
          lastError: 'Replacement subscription id is missing',
        },
      });
      return;
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId: operation.workspaceId },
    });

    if (!subscription) {
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.ABANDONED,
          lastError: 'Workspace subscription not found',
        },
      });
      return;
    }

    if (operation.status === RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED) {
      await this.verifyRazorpayReplacementCancellation(operation, subscription);
      return;
    }

    const replacement = (await this.razorpayService.fetchSubscription(
      operation.newProviderSubId,
    )) as RazorpaySubscriptionLike;
    const replacementStatus = String(replacement?.status || '').toLowerCase();
    console.info('Fetched Razorpay replacement subscription status', {
      operationId: operation.id,
      workspaceId: operation.workspaceId,
      oldProviderSubId: operation.oldProviderSubId,
      newProviderSubId: operation.newProviderSubId,
      replacementStatus,
    });

    if (replacementStatus === 'active') {
      const updatedSubscription = await this.activateRazorpayReplacement({
        subscription,
        replacement,
        replacementProviderSubId: operation.newProviderSubId,
        replacedProviderSubId: operation.oldProviderSubId,
        plan: operation.plan,
      });

      if (
        operation.oldProviderSubId &&
        operation.oldProviderSubId !== operation.newProviderSubId
      ) {
        await this.finalizeReplacedRazorpaySubscription({
          subscription: updatedSubscription,
          replacedProviderSubId: operation.oldProviderSubId,
          replacementProviderSubId: operation.newProviderSubId,
          attempt: operation.retryCount,
        });
      } else {
        await this.prisma.subscriptionOperation.update({
          where: { id: operation.id },
          data: {
            status: RAZORPAY_OPERATION_STATUS.COMPLETED,
            lastError: null,
            nextRetryAt: new Date(),
          },
        });
      }
      return;
    }

    if (this.isPendingRazorpaySubscriptionStatus(replacementStatus)) {
      await this.deferRazorpayOperation(
        operation,
        `Replacement subscription is still ${replacementStatus || 'pending'}`,
      );
      return;
    }

    await this.prisma.subscriptionOperation.update({
      where: { id: operation.id },
      data: {
        status: this.isTerminalRazorpaySubscriptionStatus(replacementStatus)
          ? RAZORPAY_OPERATION_STATUS.ABANDONED
          : RAZORPAY_OPERATION_STATUS.FAILED,
        retryCount: operation.retryCount + 1,
        nextRetryAt: new Date(
          Date.now() + this.getRazorpayCleanupDelayMs(operation.retryCount + 1),
        ),
        lastError: `Replacement subscription status is ${replacementStatus || 'unknown'}`,
      },
    });
  }

  private async processRazorpayCancelSubscriptionOperation(
    operation: SubscriptionOperation,
  ) {
    if (!operation.oldProviderSubId) {
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.ABANDONED,
          lastError: 'Cancel operation is missing subscription id',
        },
      });
      return;
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId: operation.workspaceId },
    });
    const metadata = operation.metadata as {
      cancelAtCycleEnd?: boolean;
    } | null;
    const cancelAtCycleEnd = metadata?.cancelAtCycleEnd ?? true;

    if (operation.status === RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED) {
      const providerSubscription = await this.fetchRazorpaySubscriptionStatus(
        operation.oldProviderSubId,
      );

      if (
        this.isTerminalRazorpaySubscriptionStatus(providerSubscription.status)
      ) {
        await this.prisma.subscriptionOperation.update({
          where: { id: operation.id },
          data: {
            status: RAZORPAY_OPERATION_STATUS.COMPLETED,
            lastError: null,
            nextRetryAt: new Date(),
          },
        });

        if (subscription?.providerSubId === operation.oldProviderSubId) {
          await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: this.mapRazorpaySubscriptionStatus(
                providerSubscription.status,
              ),
              cancelAtPeriodEnd: false,
            },
          });
        }
        return;
      }

      const retryCount = operation.retryCount + 1;
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
          retryCount,
          nextRetryAt: new Date(
            Date.now() +
              this.getRazorpayCancellationVerificationDelayMs(retryCount),
          ),
          lastError: `Cancel requested; Razorpay subscription still ${providerSubscription.status}`,
        },
      });
      return;
    }

    const result = await this.cancelRazorpaySubscriptionIfPossible(
      operation.oldProviderSubId,
      cancelAtCycleEnd,
    );

    if (result?.status === 'deferred' || result?.status === 'not_started') {
      const retryCount = operation.retryCount + 1;
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
          retryCount,
          nextRetryAt: new Date(
            Date.now() + this.getRazorpayCleanupDelayMs(retryCount),
          ),
          lastError: result.reason,
        },
      });
      return;
    }

    const returnedStatus = String(
      result?.subscription?.status || '',
    ).toLowerCase();
    const providerSubscription = this.isTerminalRazorpaySubscriptionStatus(
      returnedStatus,
    )
      ? { status: returnedStatus }
      : await this.fetchRazorpaySubscriptionStatus(operation.oldProviderSubId);

    if (
      this.isTerminalRazorpaySubscriptionStatus(providerSubscription.status)
    ) {
      await this.prisma.subscriptionOperation.update({
        where: { id: operation.id },
        data: {
          status: RAZORPAY_OPERATION_STATUS.COMPLETED,
          lastError: null,
          nextRetryAt: new Date(),
        },
      });

      if (subscription?.providerSubId === operation.oldProviderSubId) {
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: this.mapRazorpaySubscriptionStatus(
              providerSubscription.status,
            ),
            cancelAtPeriodEnd: false,
          },
        });
      }
      return;
    }

    const retryCount = operation.retryCount + 1;
    await this.prisma.subscriptionOperation.update({
      where: { id: operation.id },
      data: {
        status: RAZORPAY_OPERATION_STATUS.CANCEL_REQUESTED,
        retryCount,
        nextRetryAt: new Date(
          Date.now() +
            this.getRazorpayCancellationVerificationDelayMs(retryCount),
        ),
        lastError: `Cancel requested; Razorpay subscription still ${providerSubscription.status}`,
      },
    });
  }

  private async reconcileRazorpaySubscription(subscription: Subscription) {
    let currentSubscription = subscription;

    if (currentSubscription.providerSubId) {
      currentSubscription =
        await this.syncCurrentRazorpaySubscriptionStatus(currentSubscription);
    }

    if (currentSubscription.pendingProviderSubId) {
      const pendingSub = (await this.razorpayService.fetchSubscription(
        currentSubscription.pendingProviderSubId,
      )) as RazorpaySubscriptionLike;
      const pendingStatus = String(pendingSub?.status || '').toLowerCase();

      if (pendingStatus === 'active') {
        await this.activateRazorpayReplacement({
          subscription: currentSubscription,
          replacement: pendingSub,
          replacementProviderSubId: currentSubscription.pendingProviderSubId,
          replacedProviderSubId: currentSubscription.providerSubId,
          plan: currentSubscription.pendingPlan,
        });
      } else if (this.isPendingRazorpaySubscriptionStatus(pendingStatus)) {
        await this.upsertRazorpayReplacementOperation({
          workspaceId: currentSubscription.workspaceId,
          oldProviderSubId: currentSubscription.providerSubId,
          newProviderSubId: currentSubscription.pendingProviderSubId,
          plan: currentSubscription.pendingPlan,
          status: RAZORPAY_OPERATION_STATUS.PENDING,
          lastError: `Replacement subscription is still ${pendingStatus || 'pending'}`,
        });
      } else if (this.isTerminalRazorpaySubscriptionStatus(pendingStatus)) {
        await this.prisma.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            pendingPlan: null,
            pendingEffectiveAt: null,
            pendingProviderSubId: null,
          },
        });

        await this.prisma.subscriptionOperation.updateMany({
          where: {
            workspaceId: currentSubscription.workspaceId,
            provider: 'razorpay',
            type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
            newProviderSubId: currentSubscription.pendingProviderSubId,
            status: { notIn: [...RAZORPAY_OPERATION_TERMINAL_STATUSES] },
          },
          data: {
            status: RAZORPAY_OPERATION_STATUS.ABANDONED,
            lastError: `Replacement subscription ended as ${pendingStatus}`,
          },
        });
      }
    }

    if (
      currentSubscription.providerSubId &&
      currentSubscription.providerCustomerId &&
      currentSubscription.status === 'active'
    ) {
      await this.cleanupRazorpayWorkspaceSubscriptions({
        workspaceId: currentSubscription.workspaceId,
        customerId: currentSubscription.providerCustomerId,
        keepSubscriptionId: currentSubscription.providerSubId,
        pendingSubscriptionId: currentSubscription.pendingProviderSubId,
      });
    }

    if (
      currentSubscription.lastRefundStatus === 'pending' &&
      currentSubscription.providerSubId
    ) {
      const operation = await this.prisma.subscriptionOperation.findFirst({
        where: {
          workspaceId: currentSubscription.workspaceId,
          provider: 'razorpay',
          type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
          newProviderSubId: currentSubscription.providerSubId,
          oldProviderSubId: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (operation?.oldProviderSubId) {
        await this.refundReplacementCredit({
          subscription: currentSubscription,
          replacedProviderSubId: operation.oldProviderSubId,
          replacementProviderSubId: currentSubscription.providerSubId,
        });
      }
    }
  }

  private async claimRazorpaySubscriptionOperation(
    operation: SubscriptionOperation,
  ) {
    const now = new Date();
    const lockExpiresAt = new Date(
      now.getTime() + this.razorpayOperationLockMs,
    );
    const claimed = await this.prisma.subscriptionOperation.updateMany({
      where: {
        id: operation.id,
        status: operation.status,
        nextRetryAt: { lte: now },
        OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lt: now } }],
      },
      data: {
        lockedAt: now,
        lockExpiresAt,
      },
    });

    if (claimed.count === 0) return null;
    return this.prisma.subscriptionOperation.findUnique({
      where: { id: operation.id },
    });
  }

  private async releaseRazorpaySubscriptionOperationLock(operationId: string) {
    await this.prisma.subscriptionOperation.updateMany({
      where: { id: operationId },
      data: {
        lockedAt: null,
        lockExpiresAt: null,
      },
    });
  }

  @Cron('*/10 * * * *')
  async reconcileRazorpayBillingState() {
    const now = new Date();
    const shouldRunWideReconcile =
      now.getMinutes() % RAZORPAY_WIDE_RECONCILE_INTERVAL_MINUTES === 0;
    const operations = await this.prisma.subscriptionOperation.findMany({
      where: {
        provider: 'razorpay',
        status: { in: [...RAZORPAY_OPERATION_WORKER_STATUSES] },
        nextRetryAt: { lte: now },
        OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lt: now } }],
      },
      orderBy: { nextRetryAt: 'asc' },
      take: 25,
    });
    if (operations.length > 0) {
      console.info('Razorpay subscription operations due for reconciliation', {
        count: operations.length,
        operationIds: operations.map((operation) => operation.id),
      });
    }

    for (const operation of operations) {
      const claimedOperation =
        await this.claimRazorpaySubscriptionOperation(operation);
      if (!claimedOperation) continue;

      await this.processRazorpaySubscriptionOperation(claimedOperation)
        .catch(async (error) => {
          await this.prisma.subscriptionOperation.update({
            where: { id: claimedOperation.id },
            data: {
              status: RAZORPAY_OPERATION_STATUS.FAILED,
              retryCount: claimedOperation.retryCount + 1,
              nextRetryAt: new Date(
                Date.now() +
                  this.getRazorpayCleanupDelayMs(
                    claimedOperation.retryCount + 1,
                  ),
              ),
              lastError: this.getErrorMessage(error),
            },
          });
        })
        .finally(async () => {
          await this.releaseRazorpaySubscriptionOperationLock(
            claimedOperation.id,
          );
        });
    }

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        provider: 'razorpay',
        OR: [
          { pendingProviderSubId: { not: null } },
          { lastRefundStatus: 'pending' },
          ...(shouldRunWideReconcile ? [{ providerSubId: { not: null } }] : []),
        ],
      },
      take: 50,
    });

    for (const subscription of subscriptions) {
      await this.reconcileRazorpaySubscription(subscription).catch((error) => {
        console.error('Failed to reconcile Razorpay subscription', {
          workspaceId: subscription.workspaceId,
          providerSubId: subscription.providerSubId,
          pendingProviderSubId: subscription.pendingProviderSubId,
          error,
        });
      });
    }
  }

  async ensureTrialSubscription(workspaceId: string) {
    const existing = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });

    const now = new Date();
    const trialDays = PLANS.trial.trialDays || 14;

    if (existing) {
      if (
        existing.status === 'trialing' &&
        (!existing.trialStartAt ||
          !existing.trialEndAt ||
          !existing.currentPeriodStart ||
          !existing.currentPeriodEnd)
      ) {
        const trialStart =
          existing.trialStartAt ||
          existing.currentPeriodStart ||
          existing.createdAt ||
          now;
        const trialEnd =
          existing.trialEndAt ||
          existing.currentPeriodEnd ||
          new Date(trialStart.getTime() + trialDays * 86400000);

        return this.prisma.subscription.update({
          where: { workspaceId },
          data: {
            trialStartAt: existing.trialStartAt || trialStart,
            trialEndAt: existing.trialEndAt || trialEnd,
            currentPeriodStart: existing.currentPeriodStart || trialStart,
            currentPeriodEnd: existing.currentPeriodEnd || trialEnd,
          },
        });
      }

      return existing;
    }

    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    return this.prisma.subscription.create({
      data: {
        workspaceId,
        plan: 'trial',
        status: 'trialing',
        trialStartAt: now,
        trialEndAt: trialEnd,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
      },
    });
  }

  async getBillingMe(workspaceId: string) {
    const subscription = await this.ensureTrialSubscription(workspaceId);

    const planKey = subscription?.plan || 'trial';
    const plan = PLANS[planKey] || PLANS.trial;

    const addonPricing = plan?.addons
      ? {
          extraAgent: plan.addons.extraAgent
            ? {
                pricePerUnit: plan.addons.extraAgent.pricePerUnit,
                label: plan.addons.extraAgent.label,
              }
            : null,
          extraContacts: plan.addons.extraContacts
            ? {
                pricePerSlab: plan.addons.extraContacts.pricePerSlab,
                slabSize: plan.addons.extraContacts.slabSize,
                label: plan.addons.extraContacts.label,
              }
            : null,
        }
      : null;

    const usageMap = await this.usageService.getUsageMap(workspaceId);

    return {
      subscription,
      plan: {
        key: planKey,
        name: plan.name,
      },
      limits: plan.limits,
      features: plan.features,
      addonPricing,
      usage: {
        agents: usageMap.agents || 0,
        channels: usageMap.channels || 0,
        messagesPerMonth: usageMap.messagesPerMonth || 0,
        contacts: usageMap.contacts || 0,
      },
    };
  }

  async addAddon(
    workspaceId: string,
    dto: { type: 'extra_agents' | 'extra_contacts'; quantity: number },
  ) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');
    if (subscription.status !== 'active')
      throw new BadRequestException('Subscription must be active');

    const planConfig = PLANS[subscription.plan as string] as any;
    if (!planConfig?.addons)
      throw new BadRequestException('Add-ons not available on this plan');

    if (dto.type === 'extra_agents') {
      const cfg = planConfig.addons.extraAgent;
      if (!cfg)
        throw new BadRequestException(
          'Extra agents not available — agents are unlimited on this plan',
        );
      return this.createAddonInvoice(workspaceId, subscription, {
        type: 'extra_agents',
        quantity: dto.quantity,
        pricePerUnit: cfg.pricePerUnit,
        description: `${dto.quantity} extra agent seat${dto.quantity > 1 ? 's' : ''}`,
      });
    }

    if (dto.type === 'extra_contacts') {
      const cfg = planConfig.addons.extraContacts;
      if (!cfg)
        throw new BadRequestException(
          'Extra contacts not available on this plan',
        );
      return this.createAddonInvoice(workspaceId, subscription, {
        type: 'extra_contacts',
        quantity: dto.quantity, // number of slabs
        pricePerUnit: cfg.pricePerSlab,
        description: `${(dto.quantity * cfg.slabSize).toLocaleString()} extra contacts (${dto.quantity} × ${cfg.slabSize.toLocaleString()})`,
      });
    }

    throw new BadRequestException('Invalid addon type');
  }

  private async createAddonInvoice(
    workspaceId: string,
    subscription: any,
    data: {
      type: 'extra_agents' | 'extra_contacts';
      quantity: number;
      pricePerUnit: number;
      description: string;
    },
  ) {
    const amount = data.quantity * data.pricePerUnit;

    // 👉 RAZORPAY FLOW
    if (subscription.provider === 'razorpay') {
      const rpInvoice = await this.razorpayService.createInvoice({
        customerId: subscription.providerCustomerId || undefined,
        amount,

        description: data.description,
        notes: {
          workspaceId,
          subscriptionId: subscription.id,
          type: data.type,
        },
      });
      const invoice = await this.prisma.invoice.create({
        data: {
          workspaceId,
          subscriptionId: subscription.id,
          provider: 'razorpay',
          providerInvoiceId: rpInvoice.id,
          type: 'addon',
          description: data.description,
          amount,
          amountDue: amount,
          amountPaid: 0,
          currency: 'INR',
          status: 'open',
          invoiceUrl: rpInvoice.short_url ?? null,
          metadata: JSON.parse(JSON.stringify(rpInvoice)),
        },
      });

      const order = await this.razorpayService.createOrder({
        amount,
        currency: 'INR',
        notes: {
          workspaceId,
          invoiceDbId: invoice.id,
          providerInvoiceId: invoice.providerInvoiceId,
          type: data.type,
          quantity: String(data.quantity),
          subscriptionId: subscription.providerSubId || '',
        },
      });

      const payment = await this.prisma.payment.create({
        data: {
          workspaceId,
          subscriptionId: subscription.id,
          amount,
          currency: 'INR',
          status: 'pending',
          provider: 'razorpay',
          providerInvoiceId: order.id,
          type: 'addon',
          description: data.description,
          metadata: { order, ...data },
        },
      });

      return {
        provider: 'razorpay',
        razorpayOrderId: order.id,
        key: process.env.RAZORPAY_KEY_ID,
        amount,
        currency: 'INR',
        description: data.description,
        paymentId: payment.id,
      };
    }

    // 👉 STRIPE FLOW
    if (subscription.provider === 'stripe') {
      const invoice = await this.stripeService.createOneTimeInvoice({
        customerId: subscription.providerCustomerId!,
        amount,
        currency: 'inr',
        description: data.description,
      });

      await this.prisma.payment.create({
        data: {
          workspaceId,
          subscriptionId: subscription.id,
          amount,
          currency: 'INR',
          status: invoice.status === 'paid' ? 'paid' : 'pending',
          provider: 'stripe',
          providerInvoiceId: invoice.id,
          type: 'addon',
          description: data.description,
          paidAt: invoice.status === 'paid' ? new Date() : null,
          metadata: JSON.parse(JSON.stringify(invoice)),
        },
      });

      return {
        provider: 'stripe',
        invoiceId: invoice.id,
        invoiceUrl: invoice.hosted_invoice_url,
        amount,
        description: data.description,
      };
    }

    throw new BadRequestException('Unsupported provider');
  }
  async createCheckout(workspaceId: string, dto: CreateCheckoutDto, user: any) {
    return this.withCheckoutLock(workspaceId, async () => {
      const plan = PLANS[dto.plan];
      if (!plan || dto.plan === 'trial') {
        throw new BadRequestException('Invalid plan');
      }

      const subscription = await this.prisma.subscription.findUnique({
        where: { workspaceId },
      });

      if (this.hasActivePaidSubscription(subscription)) {
        return await this.changePlanInternal(
          workspaceId,
          { plan: dto.plan, effectiveAt: 'now' },
          user,
        );
      }

      if (dto.provider === 'stripe') {
        return this.createStripeCheckout(workspaceId, dto, user);
      }

      if (dto.provider === 'razorpay') {
        return this.createRazorpayCheckout(workspaceId, dto, user);
      }

      throw new BadRequestException('Unsupported billing provider');
    });
  }

  private async createStripeCheckout(
    workspaceId: string,
    dto: CreateCheckoutDto,
    user: any,
  ) {
    const plan = PLANS[dto.plan];

    if (!plan.stripePriceId) {
      throw new BadRequestException(
        'Stripe price not configured for this plan',
      );
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });

    let customerId =
      existing?.provider === 'stripe' ? existing.providerCustomerId : null;

    if (!customerId) {
      const customer = await this.stripeService.createCustomer({
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        metadata: {
          workspaceId,
          userId: user.id,
        },
      });

      customerId = customer.id;
    }

    const session = await this.stripeService.createCheckoutSession({
      customerId,
      priceId: plan.stripePriceId,
      successUrl: dto.successUrl || `${process.env.APP_URL}/billing/success`,
      cancelUrl: dto.cancelUrl || `${process.env.APP_URL}/billing/cancel`,
      trialDays: existing?.plan === 'trial' ? 0 : undefined,
      metadata: {
        workspaceId,
        plan: dto.plan,
      },
    });

    await this.prisma.subscription.upsert({
      where: { workspaceId },
      update: {
        provider: 'stripe',
        providerCustomerId: customerId,
      },
      create: {
        workspaceId,
        plan: 'trial',
        status: 'trialing',
        provider: 'stripe',
        providerCustomerId: customerId,
      },
    });

    return {
      provider: 'stripe',
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  private async createRazorpayCheckout(
    workspaceId: string,
    dto: CreateCheckoutDto,
    user: any,
  ) {
    const plan = PLANS[dto.plan];

    if (!plan.razorpayPlanId || plan.razorpayPlanId.startsWith('replace_')) {
      throw new BadRequestException(
        'Razorpay plan not configured for this plan',
      );
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });

    if (existing?.pendingProviderSubId && existing.pendingPlan !== dto.plan) {
      try {
        const pendingSub = await this.razorpayService.fetchSubscription(
          existing.pendingProviderSubId,
        );
        const pendingStatus = String(pendingSub?.status || '').toLowerCase();
        if (pendingStatus === 'active') {
          await this.activateRazorpayReplacement({
            subscription: existing,
            replacement: pendingSub,
            replacementProviderSubId: existing.pendingProviderSubId,
            replacedProviderSubId: existing.providerSubId,
            plan: existing.pendingPlan,
          });

          throw new BadRequestException(
            'A previous Razorpay checkout just completed. Refresh billing before choosing another plan.',
          );
        }

        if (
          ['created', 'authenticated', 'pending', 'halted'].includes(
            pendingStatus,
          )
        ) {
          throw new BadRequestException(
            'A Razorpay plan checkout is already in progress. Complete it or wait before choosing another plan.',
          );
        }

        if (this.isTerminalRazorpaySubscriptionStatus(pendingStatus)) {
          await this.prisma.subscription.update({
            where: { id: existing.id },
            data: {
              pendingPlan: null,
              pendingEffectiveAt: null,
              pendingProviderSubId: null,
            },
          });
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw error;
      }
    }

    const reusableSubscriptionId =
      existing?.pendingPlan === dto.plan && existing?.pendingProviderSubId
        ? existing.pendingProviderSubId
        : existing?.provider === 'razorpay'
          ? existing.providerSubId
          : null;

    if (reusableSubscriptionId) {
      try {
        const reusableSubscription =
          await this.razorpayService.fetchSubscription(reusableSubscriptionId);
        if (
          this.isReusableRazorpaySubscription(reusableSubscription, dto.plan)
        ) {
          const customerId =
            reusableSubscription.customer_id ||
            existing?.providerCustomerId ||
            null;
          const reusableStatus = String(
            reusableSubscription.status || '',
          ).toLowerCase();

          if (reusableStatus === 'active') {
            await this.prisma.subscription.update({
              where: { workspaceId },
              data: {
                provider: 'razorpay',
                providerCustomerId: customerId,
                providerSubId: reusableSubscription.id,
                plan: dto.plan,
                status: 'active',
                pendingPlan: null,
                pendingEffectiveAt: null,
                pendingProviderSubId: null,
              },
            });

            return {
              provider: 'razorpay',
              method: 'updated',
              effectiveAt: 'now',
              reconciled: true,
            };
          }

          await this.prisma.subscription.update({
            where: { workspaceId },
            data: {
              provider: 'razorpay',
              providerCustomerId: customerId,
              ...(existing?.providerSubId === reusableSubscriptionId
                ? { providerSubId: null }
                : {}),
              pendingProviderSubId: reusableSubscriptionId,
              pendingPlan: dto.plan,
              pendingEffectiveAt: 'now',
            },
          });

          if (reusableStatus !== 'created') {
            return {
              provider: 'razorpay',
              method: 'updated',
              effectiveAt: 'now',
              pending: true,
            };
          }

          return {
            provider: 'razorpay',
            subscriptionId: reusableSubscription.id,
            key: process.env.RAZORPAY_KEY_ID,
          };
        }
      } catch (error) {
        console.warn(
          'Failed to reuse Razorpay subscription, creating a new checkout',
          {
            workspaceId,
            subscriptionId: reusableSubscriptionId,
            error,
          },
        );
      }
    }

    let customerId =
      existing?.provider === 'razorpay' ? existing.providerCustomerId : null;

    if (!customerId) {
      const customer = await this.razorpayService.createCustomer({
        name:
          `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
        email: user.email,
      });

      customerId = customer.id;
    }

    const sub = await this.razorpayService.createSubscription({
      planId: plan.razorpayPlanId,
      customerId,
      customerNotify: false,
      expireBy: Math.floor(Date.now() / 1000) + 1800,
      notes: {
        workspaceId,
        plan: dto.plan,
      },
    });

    await this.prisma.subscription.upsert({
      where: { workspaceId },
      update: {
        provider: 'razorpay',
        providerCustomerId: customerId,
        providerSubId: null,
        pendingProviderSubId: sub.id,
        pendingPlan: dto.plan,
        pendingEffectiveAt: 'now',
      },
      create: {
        workspaceId,
        plan: 'trial',
        status: 'trialing',
        provider: 'razorpay',
        providerCustomerId: customerId,
        pendingProviderSubId: sub.id,
        pendingPlan: dto.plan,
        pendingEffectiveAt: 'now',
      },
    });

    return {
      provider: 'razorpay',
      subscriptionId: sub.id,
      key: process.env.RAZORPAY_KEY_ID,
    };
  }

  async handleStripeWebhook(event: any) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const workspaceId = sub.metadata?.workspaceId;

        if (!workspaceId) break;

        await this.prisma.subscription.upsert({
          where: { workspaceId },
          update: {
            provider: 'stripe',
            providerSubId: sub.id,
            providerCustomerId: sub.customer,
            plan: sub.metadata?.plan || 'starter',
            status: this.mapStripeStatus(sub.status),
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
          create: {
            workspaceId,
            provider: 'stripe',
            providerSubId: sub.id,
            providerCustomerId: sub.customer,
            plan: sub.metadata?.plan || 'starter',
            status: this.mapStripeStatus(sub.status),
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
        });

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const subscription = await this.prisma.subscription.findFirst({
          where: { providerSubId: subscriptionId },
        });

        if (!subscription) break;

        await this.upsertProviderPayment({
          workspaceId: subscription.workspaceId,
          subscriptionId: subscription.id,
          amount: invoice.amount_paid,
          currency: (invoice.currency || 'inr').toUpperCase(),
          status: 'paid',
          provider: 'stripe',
          providerPaymentId: invoice.payment_intent || `invoice:${invoice.id}`,
          providerInvoiceId: invoice.id,
          paidAt: new Date(),
          metadata: JSON.parse(JSON.stringify(invoice)),
        });

        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: 'active',
          },
        });

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const subscription = await this.prisma.subscription.findFirst({
          where: { providerSubId: subscriptionId },
        });

        if (!subscription) break;

        await this.upsertProviderPayment({
          workspaceId: subscription.workspaceId,
          subscriptionId: subscription.id,
          amount: invoice.amount_due || 0,
          currency: (invoice.currency || 'inr').toUpperCase(),
          status: 'failed',
          provider: 'stripe',
          providerPaymentId: invoice.payment_intent || `invoice:${invoice.id}`,
          providerInvoiceId: invoice.id,
          metadata: JSON.parse(JSON.stringify(invoice)),
        });

        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: 'past_due',
          },
        });

        break;
      }
    }

    return { received: true };
  }
  private isUpgrade(currentPlan: string, targetPlan: string) {
    const order = ['trial', 'starter', 'growth', 'enterprise'];
    return order.indexOf(targetPlan) > order.indexOf(currentPlan);
  }

  private async upsertProviderPayment(data: {
    workspaceId: string;
    subscriptionId?: string | null;
    amount: number;
    currency: string;
    status: string;
    provider: string;
    providerPaymentId?: string | null;
    providerInvoiceId?: string | null;
    paidAt?: Date | null;
    metadata?: Prisma.InputJsonValue;
    type?: string;
    description?: string | null;
  }) {
    const paymentData: Prisma.PaymentUncheckedCreateInput = {
      workspaceId: data.workspaceId,
      subscriptionId: data.subscriptionId ?? null,
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      provider: data.provider,
      providerPaymentId: data.providerPaymentId ?? null,
      providerInvoiceId: data.providerInvoiceId ?? null,
      paidAt: data.paidAt ?? null,
      metadata: data.metadata,
      type: data.type ?? 'subscription',
      description: data.description ?? null,
    };

    if (data.providerPaymentId) {
      const existingPayment = await this.prisma.payment.findFirst({
        where: {
          provider: data.provider,
          providerPaymentId: data.providerPaymentId,
        },
        select: { id: true },
      });

      if (existingPayment) {
        return this.prisma.payment.update({
          where: { id: existingPayment.id },
          data: paymentData,
        });
      }
    }

    try {
      return await this.prisma.payment.create({ data: paymentData });
    } catch (error) {
      if (
        data.providerPaymentId &&
        (error as { code?: string })?.code === 'P2002'
      ) {
        const existingPayment = await this.prisma.payment.findFirst({
          where: {
            provider: data.provider,
            providerPaymentId: data.providerPaymentId,
          },
          select: { id: true },
        });

        if (existingPayment) {
          return this.prisma.payment.update({
            where: { id: existingPayment.id },
            data: paymentData,
          });
        }
      }

      throw error;
    }
  }

  private async markRazorpayOrderInvoicePaid(order: any, payment: any) {
    const notes = {
      ...(payment?.notes && typeof payment.notes === 'object'
        ? payment.notes
        : {}),
      ...(order?.notes && typeof order.notes === 'object' ? order.notes : {}),
    };
    const paymentRecordId = notes.paymentRecordId;
    const invoiceDbId = notes.invoiceDbId;
    const providerInvoiceId = notes.providerInvoiceId ?? payment?.invoice_id;
    const workspaceId = notes.workspaceId;
    const paidAt = payment?.created_at
      ? new Date(payment.created_at * 1000)
      : new Date();
    const amountPaid =
      payment?.amount ?? order?.amount_paid ?? order?.amount ?? 0;
    const metadata = {
      ...(order && typeof order === 'object' ? { order } : {}),
      ...(payment && typeof payment === 'object' ? { payment } : {}),
    };

    if (paymentRecordId) {
      await this.prisma.payment.updateMany({
        where: { id: paymentRecordId },
        data: {
          status: 'paid',
          providerPaymentId: payment?.id,
          paidAt,
          metadata,
        },
      });
    } else if (payment?.id) {
      const existingPayment = await this.prisma.payment.findFirst({
        where: { provider: 'razorpay', providerPaymentId: payment.id },
        select: { id: true },
      });
      const pendingOrderPayment =
        !existingPayment && order?.id
          ? await this.prisma.payment.findFirst({
              where: {
                provider: 'razorpay',
                providerInvoiceId: order.id,
                status: 'pending',
              },
              select: { id: true },
            })
          : null;

      if (pendingOrderPayment) {
        await this.prisma.payment.update({
          where: { id: pendingOrderPayment.id },
          data: {
            status: 'paid',
            providerPaymentId: payment.id,
            providerInvoiceId,
            paidAt,
            metadata,
          },
        });
      } else if (!existingPayment) {
        const invoice =
          invoiceDbId || providerInvoiceId
            ? await this.prisma.invoice.findFirst({
                where: {
                  ...(invoiceDbId
                    ? { id: invoiceDbId }
                    : { providerInvoiceId }),
                  ...(workspaceId ? { workspaceId } : {}),
                },
                select: { subscriptionId: true, type: true, description: true },
              })
            : null;

        if (workspaceId) {
          await this.upsertProviderPayment({
            workspaceId,
            subscriptionId: invoice?.subscriptionId ?? null,
            amount: amountPaid,
            currency: (
              payment.currency ||
              order?.currency ||
              'INR'
            ).toUpperCase(),
            status: 'paid',
            provider: 'razorpay',
            providerPaymentId: payment.id,
            providerInvoiceId,
            paidAt,
            type: invoice?.type ?? 'subscription',
            description:
              invoice?.description ?? payment.description ?? 'Invoice payment',
            metadata: JSON.parse(JSON.stringify(metadata)),
          });
        }
      }
    }

    const invoiceWhere = invoiceDbId
      ? { id: invoiceDbId }
      : providerInvoiceId
        ? { providerInvoiceId, ...(workspaceId ? { workspaceId } : {}) }
        : null;

    if (!invoiceWhere) {
      return;
    }

    await this.prisma.invoice.updateMany({
      where: {
        ...invoiceWhere,
        status: { not: 'paid' },
      },
      data: {
        status: 'paid',
        amountPaid,
        amountDue: 0,
        paidAt,
        providerPaymentId: payment?.id,
        metadata,
      },
    });
  }

  async handleRazorpayWebhook(payload: any) {
    const event = payload.event;
    const entity = payload.payload;

    switch (event) {
      case 'order.paid': {
        const order = entity.order?.entity;
        const payment = entity.payment?.entity;

        await this.markRazorpayOrderInvoicePaid(order, payment);

        break;
      }

      case 'refund.processed': {
        const refund = entity.refund?.entity;
        const payment = await this.prisma.payment.findFirst({
          where: {
            provider: 'razorpay',
            providerPaymentId: refund?.payment_id,
          },
        });
        if (!payment?.subscriptionId) break;
        await this.prisma.subscription.update({
          where: { id: payment.subscriptionId },
          data: { lastRefundStatus: 'processed' },
        });
        break;
      }
      case 'subscription.activated': {
        const sub = entity.subscription?.entity;
        const providerSubId = sub?.id;
        if (!providerSubId) break;

        // Check if this is a pending replacement subscription
        const existing = await this.prisma.subscription.findFirst({
          where: { pendingProviderSubId: providerSubId },
        });

        if (existing) {
          const replacedProviderSubId = existing.providerSubId;
          const nextPlan =
            existing.pendingPlan || sub?.notes?.plan || existing.plan;

          // Activate the pending plan change
          await this.prisma.subscription.update({
            where: { id: existing.id },
            data: {
              providerSubId: providerSubId, // swap to new sub ID
              plan: nextPlan,
              status: 'active',
              pendingPlan: null,
              pendingEffectiveAt: null,
              pendingProviderSubId: null,
            },
          });

          if (
            replacedProviderSubId &&
            replacedProviderSubId !== providerSubId
          ) {
            this.queueRazorpayReplacementCleanup({
              workspaceId: existing.workspaceId,
              replacedProviderSubId,
              replacementProviderSubId: providerSubId,
            });
          }

          break;
        }

        // Normal activation flow
        const normal = await this.prisma.subscription.findFirst({
          where: { providerSubId },
        });
        if (!normal) break;

        const normalPlan =
          sub?.notes?.plan || normal.pendingPlan || normal.plan;

        await this.prisma.subscription.update({
          where: { id: normal.id },
          data: {
            status: 'active',
            plan: normalPlan,
            pendingPlan: null,
            pendingEffectiveAt: null,
          },
        });
        break;
      }
      case 'subscription.charged':
      case 'subscription.completed':
      case 'subscription.cancelled':
      case 'subscription.pending':
      case 'subscription.halted':
      case 'subscription.paused':
      case 'subscription.resumed':
      case 'subscription.authenticated':
      case 'subscription.updated': {
        const sub =
          entity.subscription?.entity ||
          entity.subscription ||
          entity.payment?.entity;
        const providerSubId = sub?.id || sub?.subscription_id;
        const providerStatus = String(
          sub?.status || (event === 'subscription.charged' ? 'active' : ''),
        ).toLowerCase();

        if (!providerSubId) break;

        const existing = await this.prisma.subscription.findFirst({
          where: {
            OR: [{ providerSubId }, { pendingProviderSubId: providerSubId }],
          },
        });

        if (existing?.workspaceId) {
          await this.syncRazorpayInvoices(existing.workspaceId, providerSubId);
        }

        if (!existing) break;

        const isPendingReplacement =
          existing.pendingProviderSubId === providerSubId;
        const replacedProviderSubId = isPendingReplacement
          ? existing.providerSubId
          : null;

        if (
          isPendingReplacement &&
          this.isTerminalRazorpaySubscriptionStatus(providerStatus)
        ) {
          await this.prisma.subscription.update({
            where: { id: existing.id },
            data: {
              pendingPlan: null,
              pendingEffectiveAt: null,
              pendingProviderSubId: null,
            },
          });

          await this.prisma.subscriptionOperation.updateMany({
            where: {
              workspaceId: existing.workspaceId,
              provider: 'razorpay',
              type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
              newProviderSubId: providerSubId,
              status: { notIn: [...RAZORPAY_OPERATION_TERMINAL_STATUSES] },
            },
            data: {
              status: RAZORPAY_OPERATION_STATUS.ABANDONED,
              lastError: `Replacement subscription ended as ${providerStatus}`,
            },
          });
          break;
        }

        if (
          isPendingReplacement &&
          !this.isActiveLikeRazorpaySubscriptionStatus(providerStatus)
        ) {
          await this.upsertRazorpayReplacementOperation({
            workspaceId: existing.workspaceId,
            oldProviderSubId: existing.providerSubId,
            newProviderSubId: providerSubId,
            plan: existing.pendingPlan,
            status: RAZORPAY_OPERATION_STATUS.PENDING,
            lastError: `Replacement subscription is ${providerStatus || 'pending'}`,
          });
          break;
        }

        const plan = isPendingReplacement
          ? existing.pendingPlan || sub?.notes?.plan || existing.plan
          : sub?.notes?.plan || existing.pendingPlan || existing.plan;
        const shouldClearPending =
          isPendingReplacement || existing.pendingPlan === plan;
        const mappedStatus = this.mapRazorpaySubscriptionStatus(providerStatus);

        await this.prisma.subscription.update({
          where: { id: existing.id },
          data: {
            provider: 'razorpay',
            providerSubId: isPendingReplacement
              ? providerSubId
              : existing.providerSubId,
            plan,
            status: mappedStatus,
            cancelAtPeriodEnd: this.isTerminalRazorpaySubscriptionStatus(
              providerStatus,
            )
              ? false
              : existing.cancelAtPeriodEnd,
            pendingPlan: shouldClearPending ? null : existing.pendingPlan,
            pendingEffectiveAt: shouldClearPending
              ? null
              : existing.pendingEffectiveAt,
            pendingProviderSubId: isPendingReplacement
              ? null
              : existing.pendingProviderSubId,
          },
        });

        if (replacedProviderSubId && replacedProviderSubId !== providerSubId) {
          this.queueRazorpayReplacementCleanup({
            workspaceId: existing.workspaceId,
            replacedProviderSubId,
            replacementProviderSubId: providerSubId,
          });
        }

        break;
      }

      case 'payment.captured': {
        const payment = entity.payment?.entity;
        if (!payment) break;

        // CASE 1: Subscription recurring payment
        if (payment.subscription_id) {
          const subscription = await this.prisma.subscription.findFirst({
            where: {
              OR: [
                { providerSubId: payment.subscription_id },
                { pendingProviderSubId: payment.subscription_id },
              ],
            },
          });

          if (subscription) {
            const isPendingReplacement =
              subscription.pendingProviderSubId === payment.subscription_id;
            const replacedProviderSubId = isPendingReplacement
              ? subscription.providerSubId
              : null;
            const nextPlan = isPendingReplacement
              ? subscription.pendingPlan || subscription.plan
              : payment.notes?.plan ||
                subscription.pendingPlan ||
                subscription.plan;
            const shouldClearPending =
              isPendingReplacement || subscription.pendingPlan === nextPlan;

            await this.upsertProviderPayment({
              workspaceId: subscription.workspaceId,
              subscriptionId: subscription.id,
              amount: payment.amount,
              currency: (payment.currency || 'INR').toUpperCase(),
              status: 'paid',
              provider: 'razorpay',
              providerPaymentId: payment.id,
              paidAt: new Date(),
              metadata: JSON.parse(JSON.stringify(payment)),
            });

            await this.prisma.subscription.update({
              where: { id: subscription.id },
              data: {
                provider: 'razorpay',
                status: 'active',
                providerSubId: isPendingReplacement
                  ? payment.subscription_id
                  : subscription.providerSubId,
                plan: nextPlan,
                pendingPlan: shouldClearPending
                  ? null
                  : subscription.pendingPlan,
                pendingEffectiveAt: shouldClearPending
                  ? null
                  : subscription.pendingEffectiveAt,
                pendingProviderSubId: isPendingReplacement
                  ? null
                  : subscription.pendingProviderSubId,
              },
            });

            if (
              replacedProviderSubId &&
              replacedProviderSubId !== payment.subscription_id
            ) {
              this.queueRazorpayReplacementCleanup({
                workspaceId: subscription.workspaceId,
                replacedProviderSubId,
                replacementProviderSubId: payment.subscription_id,
              });
            }
          }

          break;
        }

        // CASE 2: Addon / order-based payment
        if (payment.order_id) {
          const order = await this.razorpayService.fetchOrder(payment.order_id);

          await this.markRazorpayOrderInvoicePaid(order, payment);
        }

        break;
      }

      case 'payment.failed': {
        const payment = entity.payment.entity;

        // Try subscription_id first (may be present in some flows)
        let providerSubId = payment.subscription_id;

        // If not present, fetch invoice to get subscription_id
        if (!providerSubId && payment.invoice_id) {
          const invoice = await this.razorpayService.getInvoice(
            payment.invoice_id,
          );
          providerSubId = invoice?.subscription_id;
        }

        if (!providerSubId) break;

        const subscription = await this.prisma.subscription.findFirst({
          where: {
            OR: [{ providerSubId }, { pendingProviderSubId: providerSubId }],
          },
        });

        if (!subscription) break;

        const isPendingReplacementFailure =
          subscription.pendingProviderSubId === providerSubId;

        await this.upsertProviderPayment({
          workspaceId: subscription.workspaceId,
          subscriptionId: subscription.id,
          amount: payment.amount || 0,
          currency: (payment.currency || 'INR').toUpperCase(),
          status: 'failed',
          provider: 'razorpay',
          providerPaymentId: payment.id,
          metadata: JSON.parse(JSON.stringify(payment)),
        });

        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: isPendingReplacementFailure
            ? {
                pendingPlan: null,
                pendingEffectiveAt: null,
                pendingProviderSubId: null,
              }
            : {
                status: 'past_due',
              },
        });

        if (isPendingReplacementFailure) {
          await this.prisma.subscriptionOperation.updateMany({
            where: {
              workspaceId: subscription.workspaceId,
              provider: 'razorpay',
              type: RAZORPAY_OPERATION_TYPE.REPLACE_SUBSCRIPTION,
              newProviderSubId: providerSubId,
              status: { notIn: [...RAZORPAY_OPERATION_TERMINAL_STATUSES] },
            },
            data: {
              status: RAZORPAY_OPERATION_STATUS.ABANDONED,
              lastError:
                payment.error_description || 'Replacement payment failed',
            },
          });
        }

        break;
      }

      case 'invoice.paid':
      case 'invoice.issued': {
        const inv = entity.invoice?.entity;
        if (!inv?.subscription_id) break;

        const existing = await this.prisma.subscription.findFirst({
          where: { providerSubId: inv.subscription_id },
        });
        if (!existing) break;

        await this.upsertRazorpayInvoice(
          inv,
          existing.id,
          existing.workspaceId,
        );
        break;
      }
    }

    return { received: true };
  }

  private mapStripeStatus(status: string) {
    const map: Record<string, string> = {
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      canceled: 'cancelled',
      unpaid: 'unpaid',
      paused: 'paused',
      incomplete_expired: 'expired',
      incomplete: 'past_due',
    };

    return map[status] || 'past_due';
  }

  async expireTrials() {
    const now = new Date();

    return this.prisma.subscription.updateMany({
      where: {
        status: 'trialing',
        trialEndAt: { lt: now },
      },
      data: {
        status: 'expired',
      },
    });
  }

  async cancelSubscription(workspaceId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });

    if (!sub) throw new NotFoundException('Subscription not found');

    if (sub.provider === 'razorpay' && sub.providerSubId) {
      await this.upsertRazorpayCancelOperation({
        workspaceId,
        providerSubId: sub.providerSubId,
        cancelAtCycleEnd: true,
        status: RAZORPAY_OPERATION_STATUS.CLEANUP_PENDING,
        nextRetryAt: new Date(),
      });
    }

    return this.prisma.subscription.update({
      where: { workspaceId },
      data: {
        cancelAtPeriodEnd: true,
      },
    });
  }
  private extractInvoiceUrl(payment: any): string | null {
    if (!payment?.metadata) return null;

    const metadata = payment.metadata as any;

    // Stripe invoice hosted URL
    if (metadata?.hosted_invoice_url) return metadata.hosted_invoice_url;

    // Stripe invoice PDF
    if (metadata?.invoice_pdf) return metadata.invoice_pdf;

    // Razorpay may not always give direct invoice links unless invoices are separately used
    if (metadata?.short_url) return metadata.short_url;

    return null;
  }

  async getInvoices(workspaceId: string) {
    // Trigger a sync before returning so data is fresh
    await this.fullSyncWorkspace(workspaceId).catch(() => {});

    const invoices = await this.prisma.invoice.findMany({
      where: { workspaceId },
      orderBy: { invoiceDate: 'desc' },
      take: 50,
    });

    return {
      data: invoices.map((inv) => ({
        id: inv.providerInvoiceId,
        dbId: inv.id,
        date: inv.invoiceDate ?? inv.createdAt,
        amount: inv.amount,
        amountDue: inv.amountDue,
        amountPaid: inv.amountPaid,
        currency: inv.currency,
        status: inv.status,
        provider: inv.provider,
        type: inv.type,
        description: inv.description,
        invoiceUrl: inv.invoiceUrl,
        invoicePdf: inv.invoicePdf,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        paidAt: inv.paidAt,
        paymentId: inv.providerPaymentId,
      })),
    };
  }

  // ── 3. payInvoice ───────────────────────────────────────────────────────────
  // For unpaid invoices — returns a Razorpay order or Stripe hosted URL to pay.

  async payInvoice(workspaceId: string, providerInvoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { providerInvoiceId, workspaceId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'paid')
      throw new BadRequestException('Invoice already paid');

    if (invoice.provider === 'razorpay') {
      // Create a Razorpay order for the due amount
      const order = await this.razorpayService.createOrder({
        amount: invoice.amountDue ?? invoice.amount,
        currency: invoice.currency,
        notes: {
          workspaceId,
          invoiceDbId: invoice.id,
          providerInvoiceId: invoice.providerInvoiceId,
        },
      });
      return {
        provider: 'razorpay',
        razorpayOrderId: order.id,
        key: process.env.RAZORPAY_KEY_ID,
        amount: invoice.amountDue ?? invoice.amount,
        currency: invoice.currency,
        description: invoice.description ?? 'Invoice payment',
      };
    }

    if (invoice.provider === 'stripe') {
      const finalized = await this.stripeService.finalizeInvoice(
        invoice.providerInvoiceId,
      );
      return { provider: 'stripe', invoiceUrl: finalized.hosted_invoice_url };
    }

    throw new BadRequestException('Cannot process payment for this invoice');
  }

  // ── 4. Updated changePlan with refund tracking ──────────────────────────────
  // Replace / update your existing changePlan + handleRazorpayPlanChange methods:

  async changePlan(
    workspaceId: string,
    dto: { plan: string; effectiveAt?: 'now' | 'cycle_end' },
    user: any,
  ) {
    return this.withCheckoutLock(workspaceId, () =>
      this.changePlanInternal(workspaceId, dto, user),
    );
  }

  private async changePlanInternal(
    workspaceId: string,
    dto: { plan: string; effectiveAt?: 'now' | 'cycle_end' },
    user: any,
  ) {
    const targetPlan = PLANS[dto.plan];
    if (!targetPlan || dto.plan === 'trial')
      throw new BadRequestException('Invalid plan');

    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });
    if (!subscription?.provider || !subscription?.providerSubId) {
      throw new BadRequestException('No active paid subscription found');
    }

    if (subscription.provider === 'razorpay') {
      return this.handleRazorpayPlanChange(subscription, dto, user);
    }

    throw new BadRequestException('Unsupported billing provider');
  }

  private async handleRazorpayPlanChange(
    subscription: any,
    dto: { plan: string; effectiveAt?: 'now' | 'cycle_end' },
    user: any,
  ) {
    const targetPlan = PLANS[dto.plan];
    if (
      !targetPlan?.razorpayPlanId ||
      targetPlan.razorpayPlanId.startsWith('replace_')
    ) {
      throw new BadRequestException('Razorpay plan not configured');
    }

    const upgrade = this.isUpgrade(subscription.plan, dto.plan);

    if (
      subscription.pendingProviderSubId &&
      subscription.pendingPlan !== dto.plan
    ) {
      const pendingSub = await this.razorpayService.fetchSubscription(
        subscription.pendingProviderSubId,
      );
      const pendingStatus = String(pendingSub?.status || '').toLowerCase();

      if (
        ['created', 'authenticated', 'pending', 'halted'].includes(
          pendingStatus,
        )
      ) {
        throw new BadRequestException(
          'A Razorpay plan change is already in progress. Complete it or wait before choosing another plan.',
        );
      }

      if (pendingStatus === 'active') {
        await this.activateRazorpayReplacement({
          subscription,
          replacement: pendingSub,
          replacementProviderSubId: subscription.pendingProviderSubId,
          replacedProviderSubId: subscription.providerSubId,
          plan: subscription.pendingPlan,
        });

        throw new BadRequestException(
          'A previous Razorpay plan change just completed. Refresh billing and try again.',
        );
      }

      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          pendingPlan: null,
          pendingEffectiveAt: null,
          pendingProviderSubId: null,
        },
      });
    }

    if (
      subscription.pendingProviderSubId &&
      subscription.pendingPlan === dto.plan
    ) {
      const pendingSub = await this.razorpayService.fetchSubscription(
        subscription.pendingProviderSubId,
      );
      const pendingStatus = String(pendingSub?.status || '').toLowerCase();

      if (pendingStatus === 'active') {
        const replacedProviderSubId = subscription.providerSubId;
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            provider: 'razorpay',
            providerCustomerId:
              pendingSub.customer_id || subscription.providerCustomerId,
            providerSubId: pendingSub.id,
            plan: dto.plan,
            status: 'active',
            pendingPlan: null,
            pendingEffectiveAt: null,
            pendingProviderSubId: null,
          },
        });

        if (replacedProviderSubId && replacedProviderSubId !== pendingSub.id) {
          this.queueRazorpayReplacementCleanup({
            workspaceId: subscription.workspaceId,
            replacedProviderSubId,
            replacementProviderSubId: pendingSub.id,
          });
        }

        return {
          provider: 'razorpay',
          method: 'updated',
          upgrade,
          effectiveAt: 'now',
          reconciled: true,
        };
      }

      if (pendingStatus === 'created') {
        await this.upsertRazorpayReplacementOperation({
          workspaceId: subscription.workspaceId,
          oldProviderSubId: subscription.providerSubId,
          newProviderSubId: pendingSub.id,
          plan: dto.plan,
          status: RAZORPAY_OPERATION_STATUS.PENDING,
          refundAmount: subscription.lastRefundAmount || 0,
        });

        return {
          provider: 'razorpay',
          method: 'recreated',
          requiresReauth: true,
          subscriptionId: pendingSub.id,
          shortUrl: pendingSub.short_url,
          key: process.env.RAZORPAY_KEY_ID,
          upgrade,
          effectiveAt: 'now',
          refundAmount: subscription.lastRefundAmount || 0,
        };
      }

      if (['authenticated', 'pending', 'halted'].includes(pendingStatus)) {
        await this.upsertRazorpayReplacementOperation({
          workspaceId: subscription.workspaceId,
          oldProviderSubId: subscription.providerSubId,
          newProviderSubId: pendingSub.id,
          plan: dto.plan,
          status: RAZORPAY_OPERATION_STATUS.PENDING,
          refundAmount: subscription.lastRefundAmount || 0,
        });

        return {
          provider: 'razorpay',
          method: 'recreated',
          upgrade,
          effectiveAt: 'now',
          pending: true,
          refundAmount: subscription.lastRefundAmount || 0,
        };
      }

      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          pendingPlan: null,
          pendingEffectiveAt: null,
          pendingProviderSubId: null,
        },
      });
    }

    const replacementRefundAmount =
      this.calculateProratedPlanRefund(subscription);
    const newSub = await this.razorpayService.createSubscription({
      planId: targetPlan.razorpayPlanId,
      customerId: subscription.providerCustomerId || undefined,
      customerNotify: false,
      expireBy: Math.floor(Date.now() / 1000) + 1800,
      notes: {
        workspaceId: subscription.workspaceId,
        plan: dto.plan,
        replacedSubscription: subscription.providerSubId || '',
      },
    });

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        pendingPlan: dto.plan,
        pendingEffectiveAt: 'now',
        pendingProviderSubId: newSub.id,
        lastRefundAmount: replacementRefundAmount || null,
        lastRefundStatus: replacementRefundAmount > 0 ? 'pending' : null,
        lastRefundAt: null,
      },
    });

    await this.upsertRazorpayReplacementOperation({
      workspaceId: subscription.workspaceId,
      oldProviderSubId: subscription.providerSubId,
      newProviderSubId: newSub.id,
      plan: dto.plan,
      status: RAZORPAY_OPERATION_STATUS.PENDING,
      refundAmount: replacementRefundAmount,
    });

    return {
      provider: 'razorpay',
      method: 'recreated',
      requiresReauth: true,
      subscriptionId: newSub.id,
      shortUrl: newSub.short_url,
      key: process.env.RAZORPAY_KEY_ID,
      upgrade,
      effectiveAt: 'now',
      refundAmount: replacementRefundAmount,
    };
  }

  // ── Called after subscription activated / charged webhook ──────────────────
  async syncRazorpayInvoices(workspaceId: string, providerSubId: string) {
    try {
      const invoices =
        await this.razorpayService.fetchSubscriptionInvoices(providerSubId);
      if (!invoices?.items?.length) return;

      const subscription = await this.prisma.subscription.findUnique({
        where: { workspaceId },
      });
      if (!subscription) return;

      for (const inv of invoices.items) {
        await this.upsertRazorpayInvoice(inv, subscription.id, workspaceId);
      }
    } catch (e) {
      // this.logger.error('Failed to sync Razorpay invoices', e);
    }
  }

  async upsertRazorpayInvoice(
    inv: any,
    subscriptionId: string,
    workspaceId: string,
  ) {
    const status = this.mapRazorpayInvoiceStatus(inv.status);
    const amount = inv.amount ?? inv.line_items?.[0]?.amount ?? 0;

    await this.prisma.invoice.upsert({
      where: { providerInvoiceId: inv.id },
      update: {
        status,
        amountPaid: inv.amount_paid ?? (status === 'paid' ? amount : 0),
        amountDue: inv.amount_due ?? (status !== 'paid' ? amount : 0),
        paidAt: inv.paid_at ? new Date(inv.paid_at * 1000) : null,
        invoiceUrl: inv.short_url ?? null,
        providerPaymentId: inv.payment_id ?? null,
        metadata: JSON.parse(JSON.stringify(inv)),
      },
      create: {
        workspaceId,
        subscriptionId,
        provider: 'razorpay',
        providerInvoiceId: inv.id,
        providerPaymentId: inv.payment_id ?? null,
        type: inv.type === 'invoice' ? 'subscription' : 'addon',
        description: inv.description ?? `Invoice ${inv.id}`,
        amount,
        amountDue: inv.amount_due ?? (status !== 'paid' ? amount : 0),
        amountPaid: inv.amount_paid ?? (status === 'paid' ? amount : 0),
        currency: (inv.currency ?? 'INR').toUpperCase(),
        status,
        invoiceDate: inv.date ? new Date(inv.date * 1000) : null,
        dueDate: inv.due ? new Date(inv.due * 1000) : null,
        paidAt: inv.paid_at ? new Date(inv.paid_at * 1000) : null,
        periodStart: inv.billing_start
          ? new Date(inv.billing_start * 1000)
          : null,
        periodEnd: inv.billing_end ? new Date(inv.billing_end * 1000) : null,
        invoiceUrl: inv.short_url ?? null,
        metadata: JSON.parse(JSON.stringify(inv)),
      },
    });
  }

  // ── Called after Stripe invoice webhook ────────────────────────────────────
  async upsertStripeInvoice(
    inv: any,
    workspaceId: string,
    subscriptionId: string,
  ) {
    const status = this.mapStripeInvoiceStatus(inv.status);
    const amount = inv.amount_due ?? inv.total ?? 0;

    await this.prisma.invoice.upsert({
      where: { providerInvoiceId: inv.id },
      update: {
        status,
        amountPaid: inv.amount_paid ?? 0,
        amountDue: inv.amount_due ?? 0,
        paidAt: inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000)
          : null,
        invoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null,
        providerPaymentId: inv.payment_intent ?? null,
        metadata: JSON.parse(JSON.stringify(inv)),
      },
      create: {
        workspaceId,
        subscriptionId,
        provider: 'stripe',
        providerInvoiceId: inv.id,
        providerPaymentId: inv.payment_intent ?? null,
        type: inv.metadata?.type === 'addon' ? 'addon' : 'subscription',
        description:
          inv.description ??
          inv.lines?.data?.[0]?.description ??
          `Invoice ${inv.id}`,
        amount,
        amountDue: inv.amount_due ?? 0,
        amountPaid: inv.amount_paid ?? 0,
        currency: (inv.currency ?? 'inr').toUpperCase(),
        status,
        invoiceDate: inv.created ? new Date(inv.created * 1000) : null,
        dueDate: inv.due_date ? new Date(inv.due_date * 1000) : null,
        paidAt: inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000)
          : null,
        periodStart: inv.period_start
          ? new Date(inv.period_start * 1000)
          : null,
        periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
        invoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null,
        metadata: JSON.parse(JSON.stringify(inv)),
      },
    });
  }

  // ── Full historical sync for a workspace ──────────────────────────────────
  async fullSyncWorkspace(workspaceId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { workspaceId },
    });
    if (!subscription?.providerSubId) return;

    if (subscription.provider === 'razorpay') {
      await this.syncRazorpayInvoices(workspaceId, subscription.providerSubId);
    }

    if (subscription.provider === 'stripe') {
      await this.syncStripeInvoices(
        workspaceId,
        subscription.providerCustomerId!,
        subscription.id,
      );
    }
  }

  private async syncStripeInvoices(
    workspaceId: string,
    customerId: string,
    subscriptionId: string,
  ) {
    try {
      const invoices = await this.stripeService.listInvoices(customerId);
      for (const inv of invoices.data) {
        await this.upsertStripeInvoice(inv, workspaceId, subscriptionId);
      }
    } catch (e) {
      // this.logger.error('Failed to sync Stripe invoices', e);
    }
  }

  private mapRazorpayInvoiceStatus(status: string): string {
    const map: Record<string, string> = {
      draft: 'draft',
      issued: 'open',
      paid: 'paid',
      cancelled: 'void',
      expired: 'void',
    };
    return map[status] ?? 'open';
  }

  private mapStripeInvoiceStatus(status: string): string {
    const map: Record<string, string> = {
      draft: 'draft',
      open: 'open',
      paid: 'paid',
      void: 'void',
      uncollectible: 'uncollectible',
    };
    return map[status] ?? 'open';
  }
}
