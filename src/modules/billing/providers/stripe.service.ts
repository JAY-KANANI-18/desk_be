import { Injectable, InternalServerErrorException } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  public stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, 
        {
    //   apiVersion: '2025-02-24.acacia',
    });
  }

  async createCustomer(params: {
    email: string;
    name?: string;
    metadata?: Record<string, string>;
  }) {
    return this.stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
  }

  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
    metadata?: Record<string, string>;
  }) {
    return this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: params.customerId,
      line_items: [
        {
          price: params.priceId,
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      subscription_data: {
        trial_period_days: params.trialDays,
        metadata: params.metadata,
      },
      metadata: params.metadata,
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string) {
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (e) {
      throw new InternalServerErrorException('Invalid Stripe webhook signature');
    }
  }
  // Add to stripe.service.ts

async createOneTimeInvoice(params: {
  customerId: string;
  amount: number;
  currency: string;
  description: string;
}) {
  // 1. Create an invoice item
  await this.stripe.invoiceItems.create({
    customer: params.customerId,
    amount: params.amount,
    currency: params.currency,
    description: params.description,
  });

  // 2. Create and auto-finalize the invoice
  const invoice = await this.stripe.invoices.create({
    customer: params.customerId,
    auto_advance: true,        // auto-finalizes and sends
    collection_method: 'send_invoice',
    days_until_due: 1,
  });

  // 3. Finalize immediately so hosted_invoice_url is available
  const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id);

  return finalized;
}

async finalizeInvoice(invoiceId: string) {
  try {
    // If already finalized this will throw — catch and just fetch instead
    return await this.stripe.invoices.finalizeInvoice(invoiceId);
  } catch (e: any) {
    // Invoice already finalized — just fetch and return it
    if (e?.code === 'invoice_already_finalized' || e?.statusCode === 400) {
      return await this.stripe.invoices.retrieve(invoiceId);
    }
    throw new InternalServerErrorException('Failed to finalize invoice');
  }
}

async listInvoices(customerId: string, limit = 50) {
  return this.stripe.invoices.list({ customer: customerId, limit });
}
 
}