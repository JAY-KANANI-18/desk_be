import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
const Razorpay = require('razorpay');
import * as crypto from 'crypto';

@Injectable()
export class RazorpayService {
  private razorpay: any;

  constructor() {
    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
  }

  private getProviderErrorDescription(error: unknown) {
    const providerError = error as {
      error?: { description?: string };
      description?: string;
      message?: string;
    };

    return String(
      providerError?.error?.description ||
        providerError?.description ||
        providerError?.message ||
        '',
    );
  }

  private isCustomerAlreadyExistsError(error: unknown) {
    return this.getProviderErrorDescription(error)
      .toLowerCase()
      .includes('customer already exists');
  }

  private normaliseEmail(email?: string) {
    return String(email || '')
      .trim()
      .toLowerCase();
  }

  private normaliseContact(contact?: string) {
    return String(contact || '').trim();
  }

  private async findExistingCustomer(params: {
    email: string;
    contact?: string;
  }) {
    const expectedEmail = this.normaliseEmail(params.email);
    const expectedContact = this.normaliseContact(params.contact);
    const count = 100;
    const maxPages = 10;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.razorpay.customers.all({
        count,
        skip: page * count,
      });

      const items = Array.isArray(result?.items) ? result.items : [];
      const match = items.find(
        (customer: { email?: string; contact?: string }) => {
          const emailMatches =
            expectedEmail &&
            this.normaliseEmail(customer.email) === expectedEmail;
          const contactMatches =
            expectedContact &&
            this.normaliseContact(customer.contact) === expectedContact;

          if (expectedEmail && expectedContact)
            return emailMatches && contactMatches;
          return emailMatches || contactMatches;
        },
      );

      if (match) return match;
      if (items.length < count) break;
    }

    return null;
  }

  async createCustomer(params: {
    name: string;
    email: string;
    contact?: string;
  }) {
    const payload: {
      name: string;
      email: string;
      contact?: string;
      fail_existing: 0;
    } = {
      name: params.name,
      email: params.email,
      fail_existing: 0,
    };

    if (params.contact) {
      payload.contact = params.contact;
    }

    try {
      return await this.razorpay.customers.create(payload);
    } catch (error) {
      if (this.isCustomerAlreadyExistsError(error)) {
        const existingCustomer = await this.findExistingCustomer(params);
        if (existingCustomer) return existingCustomer;

        throw new BadRequestException(
          'Razorpay customer already exists but could not be resolved.',
        );
      }

      console.error('Razorpay createCustomer error', error);
      throw new InternalServerErrorException(
        'Failed to create Razorpay customer',
      );
    }
  }

  async createSubscription(params: {
    planId: string;
    customerId?: string;
    customerNotify?: boolean;
    totalCount?: number;
    startAt?: number;
    expireBy?: number;
    notes?: Record<string, string>;
  }) {
    const payload: any = {
      plan_id: params.planId,
      customer_notify: params.customerNotify ? 1 : 0,
      total_count: params.totalCount || 12,
    };

    if (params.customerId) payload.customer_id = params.customerId;
    if (params.startAt) payload.start_at = params.startAt;
    if (params.expireBy) payload.expire_by = params.expireBy;
    if (params.notes && Object.keys(params.notes).length > 0)
      payload.notes = params.notes;

    return this.razorpay.subscriptions.create(payload);
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('hex');
    return expected === signature;
  }

  async fetchSubscription(subscriptionId: string) {
    try {
      return this.razorpay.subscriptions.fetch(subscriptionId);
    } catch (e: any) {
      throw new InternalServerErrorException(
        'Failed to fetch Razorpay subscription',
      );
    }
  }

  async listSubscriptions(params: {
    customerId?: string;
    count?: number;
    skip?: number;
  }) {
    try {
      return this.razorpay.subscriptions.all({
        count: params.count ?? 100,
        skip: params.skip ?? 0,
      });
    } catch (e) {
      console.error('Razorpay listSubscriptions error', e);
      throw new InternalServerErrorException(
        'Failed to list Razorpay subscriptions',
      );
    }
  }

  /**
   * Detects payment method used for a subscription.
   * Razorpay doesn't expose this directly on the sub object,
   * so we check the most recent payment linked to the subscription.
   */
  async getSubscriptionPaymentMethod(
    subscriptionId: string,
  ): Promise<'card' | 'upi' | 'emandate' | 'unknown'> {
    try {
      // Correct API: fetch payments filtered by subscription_id
      const payments = await this.razorpay.payments.all({
        subscription_id: subscriptionId,
        count: 1,
      });

      const latest = payments?.items?.[0];
      if (!latest) return 'unknown';

      const method = latest.method as string;
      if (method === 'card') return 'card';
      if (method === 'upi') return 'upi';
      if (method === 'emandate') return 'emandate';
      return 'unknown';
    } catch (e) {
      console.error('Failed to detect payment method', e);
      return 'unknown';
    }
  }

  async updateSubscription(
    subscriptionId: string,
    params: {
      planId?: string;
      quantity?: number;
      scheduleChangeAt?: 'now' | 'cycle_end';
      remainingCount?: number;
      customerNotify?: boolean;
    },
  ) {
    try {
      const payload: any = {};
      if (params.planId) payload.plan_id = params.planId;
      if (typeof params.quantity === 'number')
        payload.quantity = params.quantity;
      if (params.scheduleChangeAt)
        payload.schedule_change_at = params.scheduleChangeAt;
      if (typeof params.remainingCount === 'number')
        payload.remaining_count = params.remainingCount;
      if (typeof params.customerNotify === 'boolean') {
        payload.customer_notify = params.customerNotify ? 1 : 0;
      }
      return this.razorpay.subscriptions.update(subscriptionId, payload);
    } catch (e: any) {
      const description = String(
        e?.error?.description || e?.description || e?.message || '',
      ).toLowerCase();

      if (
        description.includes('another subscription operation is in progress')
      ) {
        throw new BadRequestException(
          'Razorpay is already processing a subscription change. Please wait and try again.',
        );
      }

      if (
        description.includes(
          "can't update subscription immediately when card mandate is applicable",
        )
      ) {
        throw new BadRequestException(
          'Razorpay card mandates only allow subscription plan changes at cycle end.',
        );
      }

      console.error('Razorpay updateSubscription error', e);
      throw new InternalServerErrorException(
        'Failed to update Razorpay subscription',
      );
    }
  }

  async cancelSubscription(subscriptionId: string, cancelAtCycleEnd = true) {
    try {
      return this.razorpay.subscriptions.cancel(
        subscriptionId,
        cancelAtCycleEnd,
      );
    } catch (e) {
      console.error('Razorpay cancelSubscription error', e);
      throw new InternalServerErrorException(
        'Failed to cancel Razorpay subscription',
      );
    }
  }

  async cancelSubscriptionIfPossible(
    subscriptionId: string,
    cancelAtCycleEnd = true,
  ) {
    try {
      const subscription = await this.razorpay.subscriptions.cancel(
        subscriptionId,
        cancelAtCycleEnd,
      );
      return { status: 'cancelled' as const, subscription };
    } catch (error: any) {
      const description = String(
        error?.error?.description || error?.description || error?.message || '',
      ).toLowerCase();
      const statusCode = Number(error?.statusCode || error?.status || 0);

      if (statusCode === 429 || description.includes('too many requests')) {
        return {
          status: 'deferred' as const,
          reason:
            error?.error?.description ||
            error?.message ||
            'Razorpay rate limit reached',
        };
      }

      if (
        description.includes(
          'cannot be cancelled since no billing cycle is going on',
        )
      ) {
        return {
          status: 'not_started' as const,
          reason:
            error?.error?.description ||
            error?.message ||
            'Subscription has no active billing cycle',
        };
      }

      if (
        description.includes('another subscription operation is in progress') ||
        description.includes('not cancellable in cancelled status') ||
        description.includes('already cancelled')
      ) {
        return {
          status: description.includes('operation is in progress')
            ? ('deferred' as const)
            : ('already_cancelled' as const),
          reason:
            error?.error?.description ||
            error?.message ||
            'Cancellation skipped',
        };
      }

      console.error('Razorpay cancelSubscription error', error);
      throw new InternalServerErrorException(
        'Failed to cancel Razorpay subscription',
      );
    }
  }

  async getInvoice(invoiceId: string) {
    try {
      return this.razorpay.invoices.fetch(invoiceId);
    } catch (e) {
      console.error('Razorpay getInvoice error', e);
      throw new InternalServerErrorException(
        'Failed to fetch Razorpay invoice',
      );
    }
  }

  async fetchPayment(paymentId: string) {
    try {
      return this.razorpay.payments.fetch(paymentId);
    } catch (e) {
      console.error('Razorpay fetchPayment error', e);
      throw new InternalServerErrorException(
        'Failed to fetch Razorpay payment',
      );
    }
  }

  async refundPayment(
    paymentId: string,
    params: { amount?: number; notes?: Record<string, string> },
  ) {
    try {
      return this.razorpay.payments.refund(paymentId, {
        amount: params.amount,
        notes: params.notes,
      });
    } catch (e) {
      console.error('Razorpay refundPayment error', e);
      throw new InternalServerErrorException(
        'Failed to refund Razorpay payment',
      );
    }
  }

  async fetchOrder(orderId: string) {
    try {
      return this.razorpay.orders.fetch(orderId);
    } catch (e) {
      console.error('Razorpay fetchOrder error', e);
      throw new InternalServerErrorException('Failed to fetch Razorpay order');
    }
  }

  async createOrder(params: {
    amount: number;
    currency: string;
    notes?: Record<string, string>;
  }) {
    try {
      return this.razorpay.orders.create({
        amount: params.amount,
        currency: params.currency,
        notes: params.notes,
      });
    } catch (e) {
      throw new InternalServerErrorException('Failed to create Razorpay order');
    }
  }
  async createInvoice(params: {
    customerId?: string;
    amount: number;
    description: string;
    email?: string;
    contact?: string;
    notes?: Record<string, string>;
  }) {
    try {
      return this.razorpay.invoices.create({
        type: 'invoice',

        description: params.description,

        customer_id: params.customerId,

        line_items: [
          {
            name: params.description,
            amount: params.amount, // ✅ amount goes here
            currency: 'INR',
            quantity: 1,
          },
        ],

        currency: 'INR',

        email_notify: 1,
        sms_notify: 0,

        notes: params.notes,
      });
    } catch (e) {
      console.error('Razorpay createInvoice error', e);
      throw new InternalServerErrorException(
        'Failed to create Razorpay invoice',
      );
    }
  }

  async fetchSubscriptionInvoices(subscriptionId: string, count = 20) {
    try {
      return await this.razorpay.invoices.all({
        subscription_id: subscriptionId,
        count,
      });
    } catch (e) {
      // this.logger.error('Failed to fetch Razorpay invoices', e);
      return { items: [] };
    }
  }
}
