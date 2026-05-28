import { BillingService } from './billing.service';

const makeService = () => {
  const prisma = {
    subscription: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    subscriptionOperation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    invoice: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
    },
  };

  const razorpayService = {
    cancelSubscriptionIfPossible: jest.fn(),
    fetchSubscription: jest.fn(),
    listSubscriptions: jest.fn(),
    fetchSubscriptionInvoices: jest.fn(),
    fetchOrder: jest.fn(),
    getInvoice: jest.fn(),
  };

  const stripeService = {};
  const usageService = {
    getUsageMap: jest.fn(),
  };

  const service = new BillingService(
    prisma as never,
    razorpayService as never,
    stripeService as never,
    usageService as never,
  );

  return { service, prisma, razorpayService, usageService };
};

describe('BillingService Razorpay state machine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses one deterministic operation row even when the existing row is completed', async () => {
    const { service, prisma } = makeService();
    const existingOperation = {
      id: 'op_1',
      operationKey: 'razorpay:replace_subscription:workspace_1:sub_old:sub_new',
      workspaceId: 'workspace_1',
      provider: 'razorpay',
      type: 'replace_subscription',
      status: 'completed',
      oldProviderSubId: 'sub_old',
      newProviderSubId: 'sub_new',
      plan: 'growth',
      retryCount: 1,
      nextRetryAt: new Date('2026-05-27T00:00:00.000Z'),
      lastError: null,
      metadata: null,
      lockedAt: null,
      lockExpiresAt: null,
      createdAt: new Date('2026-05-27T00:00:00.000Z'),
      updatedAt: new Date('2026-05-27T00:00:00.000Z'),
    };

    prisma.subscriptionOperation.findUnique.mockResolvedValue(
      existingOperation,
    );
    prisma.subscriptionOperation.update.mockResolvedValue(existingOperation);

    await (
      service as unknown as {
        upsertRazorpayReplacementOperation(params: {
          workspaceId: string;
          oldProviderSubId: string;
          newProviderSubId: string;
          plan: string;
          status: string;
        }): Promise<unknown>;
      }
    ).upsertRazorpayReplacementOperation({
      workspaceId: 'workspace_1',
      oldProviderSubId: 'sub_old',
      newProviderSubId: 'sub_new',
      plan: 'pro',
      status: 'cleanup_pending',
    });

    expect(prisma.subscriptionOperation.findUnique).toHaveBeenCalledWith({
      where: {
        operationKey:
          'razorpay:replace_subscription:workspace_1:sub_old:sub_new',
      },
    });
    expect(prisma.subscriptionOperation.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'op_1' },
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('does not call Razorpay cancel again after cancel_requested', async () => {
    const { service, prisma, razorpayService } = makeService();

    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_db',
      workspaceId: 'workspace_1',
      plan: 'growth',
      status: 'active',
      provider: 'razorpay',
      providerSubId: 'sub_new',
      providerCustomerId: 'cust_1',
    });
    razorpayService.fetchSubscription.mockResolvedValue({
      id: 'sub_old',
      status: 'active',
    });
    prisma.subscriptionOperation.update.mockResolvedValue({});

    await (
      service as unknown as {
        processRazorpaySubscriptionOperation(operation: unknown): Promise<void>;
      }
    ).processRazorpaySubscriptionOperation({
      id: 'op_1',
      operationKey: 'razorpay:replace_subscription:workspace_1:sub_old:sub_new',
      workspaceId: 'workspace_1',
      provider: 'razorpay',
      type: 'replace_subscription',
      status: 'cancel_requested',
      oldProviderSubId: 'sub_old',
      newProviderSubId: 'sub_new',
      plan: 'growth',
      retryCount: 1,
      nextRetryAt: new Date(),
      lockedAt: null,
      lockExpiresAt: null,
      lastError: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(razorpayService.fetchSubscription).toHaveBeenCalledWith('sub_old');
    expect(razorpayService.cancelSubscriptionIfPossible).not.toHaveBeenCalled();
  });

  it('records duplicate Razorpay captured payments idempotently', async () => {
    const { service, prisma } = makeService();
    const subscription = {
      id: 'sub_db',
      workspaceId: 'workspace_1',
      plan: 'growth',
      pendingPlan: null,
      pendingProviderSubId: null,
      pendingEffectiveAt: null,
      providerSubId: 'sub_rzp',
      providerCustomerId: 'cust_1',
    };
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_1',
            subscription_id: 'sub_rzp',
            amount: 299900,
            currency: 'INR',
            notes: { plan: 'growth' },
          },
        },
      },
    };

    prisma.subscription.findFirst.mockResolvedValue(subscription);
    prisma.subscription.update.mockResolvedValue(subscription);
    prisma.payment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'payment_row_1' });
    prisma.payment.create.mockResolvedValue({ id: 'payment_row_1' });
    prisma.payment.update.mockResolvedValue({ id: 'payment_row_1' });

    await service.handleRazorpayWebhook(payload);
    await service.handleRazorpayWebhook(payload);

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.update).toHaveBeenCalledTimes(1);
  });

  it('does not start Razorpay cleanup from the billing read path', async () => {
    const { service, prisma, usageService } = makeService();
    const cleanupSpy = jest.fn();
    (
      service as unknown as { cleanupRazorpayWorkspaceSubscriptions: jest.Mock }
    ).cleanupRazorpayWorkspaceSubscriptions = cleanupSpy;

    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub_db',
      workspaceId: 'workspace_1',
      plan: 'trial',
      status: 'trialing',
      provider: 'razorpay',
      providerSubId: 'sub_rzp',
      providerCustomerId: 'cust_1',
    });
    usageService.getUsageMap.mockResolvedValue({
      agents: 0,
      channels: 0,
      messagesPerMonth: 0,
      contacts: 0,
    });

    await service.getBillingMe('workspace_1');

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('queues user-requested Razorpay cancellation without calling the provider inline', async () => {
    const { service, prisma, razorpayService } = makeService();
    const subscription = {
      id: 'sub_db',
      workspaceId: 'workspace_1',
      plan: 'growth',
      status: 'active',
      provider: 'razorpay',
      providerSubId: 'sub_rzp',
      providerCustomerId: 'cust_1',
    };

    prisma.subscription.findUnique.mockResolvedValue(subscription);
    prisma.subscriptionOperation.findUnique.mockResolvedValue(null);
    prisma.subscriptionOperation.create.mockResolvedValue({
      id: 'op_cancel',
    });
    prisma.subscription.update.mockResolvedValue({
      ...subscription,
      cancelAtPeriodEnd: true,
    });

    await service.cancelSubscription('workspace_1');

    expect(prisma.subscriptionOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationKey: 'razorpay:cancel_subscription:workspace_1:sub_rzp',
          type: 'cancel_subscription',
          oldProviderSubId: 'sub_rzp',
          metadata: { cancelAtCycleEnd: true },
        }),
      }),
    );
    expect(razorpayService.cancelSubscriptionIfPossible).not.toHaveBeenCalled();
  });

  it('queues duplicate Razorpay subscriptions as cancel operations', async () => {
    const { service, prisma, razorpayService } = makeService();

    razorpayService.listSubscriptions.mockResolvedValue({
      items: [
        {
          id: 'sub_duplicate',
          status: 'active',
          customer_id: 'cust_1',
          notes: { workspaceId: 'workspace_1' },
          created_at: 1,
        },
      ],
    });
    prisma.subscriptionOperation.findFirst.mockResolvedValue(null);
    prisma.subscriptionOperation.findUnique.mockResolvedValue(null);
    prisma.subscriptionOperation.create.mockResolvedValue({
      id: 'op_duplicate',
    });

    await (
      service as unknown as {
        cleanupRazorpayWorkspaceSubscriptions(params: {
          workspaceId: string;
          customerId: string;
          keepSubscriptionId: string;
        }): Promise<void>;
      }
    ).cleanupRazorpayWorkspaceSubscriptions({
      workspaceId: 'workspace_1',
      customerId: 'cust_1',
      keepSubscriptionId: 'sub_current',
    });

    expect(prisma.subscriptionOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationKey:
            'razorpay:cancel_subscription:workspace_1:sub_duplicate',
          type: 'cancel_subscription',
          oldProviderSubId: 'sub_duplicate',
          metadata: { cancelAtCycleEnd: false },
        }),
      }),
    );
    expect(razorpayService.cancelSubscriptionIfPossible).not.toHaveBeenCalled();
  });
});
