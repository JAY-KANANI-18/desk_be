import { Injectable, InternalServerErrorException } from '@nestjs/common';
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

    async createCustomer(params: { name: string; email: string; contact?: string }) {
        return this.razorpay.customers.create({
            name: params.name,
            email: params.email,
            contact: params.contact,
            fail_existing: 0,
        });
    }

    async createSubscription(params: {
        planId: string;
        customerId?: string;
        customerNotify?: boolean;
        totalCount?: number;
        startAt?: number;
        notes?: Record<string, string>;
    }) {
        return this.razorpay.subscriptions.create({
            plan_id: params.planId,
            customer_id: params.customerId,
            customer_notify: params.customerNotify ? 1 : 0,
            total_count: params.totalCount || 12,
            start_at: params.startAt,
            notes: params.notes,
        });
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
        } catch (e) {
            throw new InternalServerErrorException('Failed to fetch Razorpay subscription');
        }
    }

    /**
     * Detects payment method used for a subscription.
     * Razorpay doesn't expose this directly on the sub object,
     * so we check the most recent payment linked to the subscription.
     */
    async getSubscriptionPaymentMethod(subscriptionId: string): Promise<'card' | 'upi' | 'emandate' | 'unknown'> {
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
            notes?: Record<string, string>;
        },
    ) {
        try {
            const payload: any = {};
            if (params.planId) payload.plan_id = params.planId;
            if (typeof params.quantity === 'number') payload.quantity = params.quantity;
            if (params.scheduleChangeAt) payload.schedule_change_at = params.scheduleChangeAt;
            if (typeof params.remainingCount === 'number') payload.remaining_count = params.remainingCount;
            if (typeof params.customerNotify === 'boolean') {
                payload.customer_notify = params.customerNotify ? 1 : 0;
            }
            if (params.notes) payload.notes = params.notes;

            return this.razorpay.subscriptions.update(subscriptionId, payload);
        } catch (e) {
            console.error('Razorpay updateSubscription error', e);
            throw new InternalServerErrorException('Failed to update Razorpay subscription');
        }
    }

    async cancelSubscription(subscriptionId: string, cancelAtCycleEnd = true) {
        try {
            return this.razorpay.subscriptions.cancel(subscriptionId, {
                cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0,
            });
        } catch (e) {
            console.error('Razorpay cancelSubscription error', e);
            throw new InternalServerErrorException('Failed to cancel Razorpay subscription');
        }
    }

    async getInvoice(invoiceId: string) {
        try {
            return this.razorpay.invoices.fetch(invoiceId);
        } catch (e) {
            console.error('Razorpay getInvoice error', e);
            throw new InternalServerErrorException('Failed to fetch Razorpay invoice');
        }
    }

    async fetchPayment(paymentId: string) {
        try {
            return this.razorpay.payments.fetch(paymentId);
        } catch (e) {
            console.error('Razorpay fetchPayment error', e);
            throw new InternalServerErrorException('Failed to fetch Razorpay payment');
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

    async createOrder(params: { amount: number; currency: string; notes?: Record<string, string> }) {
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
            throw new InternalServerErrorException('Failed to create Razorpay invoice');
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