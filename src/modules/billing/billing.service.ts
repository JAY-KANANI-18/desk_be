import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { PLANS } from './plans.config';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { RazorpayService } from './providers/razorpay.service';
import { StripeService } from './providers/stripe.service';
import { UsageService } from './usage/usage.service';
import { IsInt, Min } from 'class-validator';


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
    constructor(
        private prisma: PrismaService,
        private razorpayService: RazorpayService,
        private stripeService: StripeService,
        private usageService: UsageService,
    ) { }

    async ensureTrialSubscription(workspaceId: string) {
        const existing = await this.prisma.subscription.findUnique({
            where: { workspaceId },
        });

        if (existing) return existing;

        const now = new Date();
        const trialEnd = new Date(now);
        trialEnd.setDate(trialEnd.getDate() + (PLANS.trial.trialDays || 14));

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
        const subscription = await this.prisma.subscription.findUnique({
            where: { workspaceId },
        });

        const planKey = subscription?.plan || 'trial';
        const plan = PLANS[planKey] || PLANS.trial;


        const addonPricing = plan?.addons
            ? {
                extraAgent: plan.addons.extraAgent
                    ? { pricePerUnit: plan.addons.extraAgent.pricePerUnit, label: plan.addons.extraAgent.label }
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


    async addAddon(workspaceId: string, dto: { type: 'extra_agents' | 'extra_contacts'; quantity: number }) {
        const subscription = await this.prisma.subscription.findUnique({ where: { workspaceId } });
        if (!subscription) throw new NotFoundException('Subscription not found');
        if (subscription.status !== 'active') throw new BadRequestException('Subscription must be active');

        const planConfig = PLANS[subscription.plan as string] as any;
        if (!planConfig?.addons) throw new BadRequestException('Add-ons not available on this plan');

        if (dto.type === 'extra_agents') {
            const cfg = planConfig.addons.extraAgent;
            if (!cfg) throw new BadRequestException('Extra agents not available — agents are unlimited on this plan');
            return this.createAddonInvoice(workspaceId, subscription, {
                type: 'extra_agents',
                quantity: dto.quantity,
                pricePerUnit: cfg.pricePerUnit,
                description: `${dto.quantity} extra agent seat${dto.quantity > 1 ? 's' : ''}`,
            });
        }

        if (dto.type === 'extra_contacts') {
            const cfg = planConfig.addons.extraContacts;
            if (!cfg) throw new BadRequestException('Extra contacts not available on this plan');
            return this.createAddonInvoice(workspaceId, subscription, {
                type: 'extra_contacts',
                quantity: dto.quantity,                       // number of slabs
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
                }
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
        const plan = PLANS[dto.plan];
        if (!plan || dto.plan === 'trial') {
            throw new BadRequestException('Invalid plan');
        }

        const subscription = await this.prisma.subscription.findUnique({
            where: { workspaceId },
        });

        if (subscription) {
            return await this.changePlan(workspaceId, { plan: dto.plan, effectiveAt: 'now' }, user);
            // await this.ensureTrialSubscription(workspaceId);
        }

        if (dto.provider === 'stripe') {
            return this.createStripeCheckout(workspaceId, dto, user);
        }

        if (dto.provider === 'razorpay') {
            return this.createRazorpayCheckout(workspaceId, dto, user);
        }

        throw new BadRequestException('Unsupported billing provider');
    }

    private async createStripeCheckout(workspaceId: string, dto: CreateCheckoutDto, user: any) {
        const plan = PLANS[dto.plan];

        if (!plan.stripePriceId) {
            throw new BadRequestException('Stripe price not configured for this plan');
        }

        const existing = await this.prisma.subscription.findUnique({
            where: { workspaceId },
        });

        let customerId = existing?.providerCustomerId;

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

    private async createRazorpayCheckout(workspaceId: string, dto: CreateCheckoutDto, user: any) {
        console.log({ workspaceId, dto, user });

        const plan = PLANS[dto.plan];
        console.log({ plan });


        if (!plan.razorpayPlanId || plan.razorpayPlanId.startsWith('replace_')) {
            throw new BadRequestException('Razorpay plan not configured for this plan');
        }

        const existing = await this.prisma.subscription.findUnique({
            where: { workspaceId },
        });

        let customerId = "cust_SXplsMPASO4xs9";

        if (!customerId) {
            const customer = await this.razorpayService.createCustomer({
                name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
                email: user.email,
            });

            customerId = customer.id;
        }

        const sub = await this.razorpayService.createSubscription({
            planId: plan.razorpayPlanId,
            customerNotify: true,
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
                providerSubId: sub.id,
            },
            create: {
                workspaceId,
                plan: 'trial',
                status: 'trialing',
                provider: 'razorpay',
                providerCustomerId: customerId,
                providerSubId: sub.id,
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

                await this.prisma.payment.create({
                    data: {
                        workspaceId: subscription.workspaceId,
                        subscriptionId: subscription.id,
                        amount: invoice.amount_paid,
                        currency: (invoice.currency || 'inr').toUpperCase(),
                        status: 'paid',
                        provider: 'stripe',
                        providerPaymentId: invoice.payment_intent || null,
                        providerInvoiceId: invoice.id,
                        paidAt: new Date(),
                        metadata: invoice,
                    },
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

                await this.prisma.payment.create({
                    data: {
                        workspaceId: subscription.workspaceId,
                        subscriptionId: subscription.id,
                        amount: invoice.amount_due || 0,
                        currency: (invoice.currency || 'inr').toUpperCase(),
                        status: 'failed',
                        provider: 'stripe',
                        providerInvoiceId: invoice.id,
                        metadata: invoice,
                    },
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
    async handleRazorpayWebhook(payload: any) {
        const event = payload.event;
        const entity = payload.payload;
        console.dir({ event, entity }, { depth: null });

        switch (event) {


            case 'order.paid': {
                const order = entity.order?.entity;
                const payment = entity.payment?.entity;

                const paymentRecordId = order?.notes?.paymentRecordId;
                const invoiceDbId = order?.notes?.invoiceDbId;

                // 1) Update payment row
                if (paymentRecordId) {
                    await this.prisma.payment.update({
                        where: { id: paymentRecordId },
                        data: {
                            status: 'paid',
                            providerPaymentId: payment?.id,
                            paidAt: new Date(),
                            metadata: {
                                ...(typeof order === 'object' ? { order } : {}),
                                ...(typeof payment === 'object' ? { payment } : {}),
                            },
                        },
                    });
                }

                // 2) Update invoice row
                if (invoiceDbId) {
                    await this.prisma.invoice.update({
                        where: { id: invoiceDbId },
                        data: {
                            status: 'paid',
                            amountPaid: payment?.amount || order?.amount || 0,
                            amountDue: 0,
                            paidAt: new Date(),
                            providerPaymentId: payment?.id,
                            metadata: {
                                ...(typeof order === 'object' ? { order } : {}),
                                ...(typeof payment === 'object' ? { payment } : {}),
                            },
                        },
                    });
                }

                break;
            }

            case 'refund.processed': {
                const refund = entity.refund?.entity;
                // Find subscription by payment
                const sub = await this.prisma.subscription.findFirst({
                    where: { providerSubId: refund?.subscription_id },
                });
                if (!sub) break;
                await this.prisma.subscription.update({
                    where: { id: sub.id },
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
                    // Activate the pending plan change
                    await this.prisma.subscription.update({
                        where: { id: existing.id },
                        data: {
                            providerSubId: providerSubId,       // swap to new sub ID
                            plan: existing.pendingPlan,
                            status: 'active',
                            pendingPlan: null,
                            pendingProviderSubId: null,
                        },
                    });
                    break;
                }

                // Normal activation flow
                const normal = await this.prisma.subscription.findFirst({
                    where: { providerSubId },
                });
                if (!normal) break;

                await this.prisma.subscription.update({
                    where: { id: normal.id },
                    data: { status: 'active', plan: sub?.notes?.plan || normal.plan },
                });
                break;
            }
            case 'subscription.charged':
            case 'subscription.completed':
            case 'subscription.updated': {
                const sub = entity.subscription?.entity || entity.subscription || entity.payment?.entity;
                const providerSubId = sub?.id || sub?.subscription_id;

                if (!providerSubId) break;

                const existing = await this.prisma.subscription.findFirst({
                    where: { providerSubId },
                });

                if (existing?.workspaceId) {
                    await this.syncRazorpayInvoices(existing.workspaceId, providerSubId);
                }
                console.log({ existing });


                if (!existing) break;

                const plan = sub?.notes?.plan || existing.plan;

                await this.prisma.subscription.update({
                    where: { id: existing.id },
                    data: {
                        provider: 'razorpay',
                        plan,
                        status: event === 'subscription.completed' ? 'cancelled' : 'active',
                    },
                });

                break;
            }

            case 'payment.captured': {
                const payment = entity.payment?.entity;
                if (!payment) break;

                // CASE 1: Subscription recurring payment
                if (payment.subscription_id) {
                    const subscription = await this.prisma.subscription.findFirst({
                        where: { providerSubId: payment.subscription_id },
                    });

                    if (subscription) {
                        await this.prisma.payment.create({
                            data: {
                                workspaceId: subscription.workspaceId,
                                subscriptionId: subscription.id,
                                amount: payment.amount,
                                currency: (payment.currency || 'INR').toUpperCase(),
                                status: 'paid',
                                provider: 'razorpay',
                                providerPaymentId: payment.id,
                                paidAt: new Date(),
                                metadata: payment,
                            },
                        });

                        await this.prisma.subscription.update({
                            where: { id: subscription.id },
                            data: { status: 'active' },
                        });
                    }

                    break;
                }

                // CASE 2: Addon / order-based payment
                if (payment.order_id) {
                    const order = await this.razorpayService.fetchOrder(payment.order_id);

                    const paymentRecordId = order?.notes?.paymentRecordId;
                    const invoiceDbId = order?.notes?.invoiceDbId;

                    if (paymentRecordId) {
                        await this.prisma.payment.updateMany({
                            where: { id: paymentRecordId },
                            data: {
                                status: 'paid',
                                providerPaymentId: payment.id,
                                paidAt: new Date(),
                                metadata: payment,
                            },
                        });
                    }

                    if (invoiceDbId) {
                        await this.prisma.invoice.updateMany({
                            where: { id: invoiceDbId },
                            data: {
                                status: 'paid',
                                amountPaid: payment.amount,
                                amountDue: 0,
                                paidAt: new Date(),
                                providerPaymentId: payment.id,
                                metadata: payment,
                            },
                        });
                    }
                }

                break;
            }

            case 'payment.failed': {
                const payment = entity.payment.entity;

                // Try subscription_id first (may be present in some flows)
                let providerSubId = payment.subscription_id;

                // If not present, fetch invoice to get subscription_id
                if (!providerSubId && payment.invoice_id) {
                    const invoice = await this.razorpayService.getInvoice(payment.invoice_id);
                    providerSubId = invoice?.subscription_id;
                }

                if (!providerSubId) break;

                const subscription = await this.prisma.subscription.findFirst({
                    where: { providerSubId },
                });

                if (!subscription) break;


                await this.prisma.payment.create({
                    data: {
                        workspaceId: subscription.workspaceId,
                        subscriptionId: subscription.id,
                        amount: payment.amount || 0,
                        currency: (payment.currency || 'INR').toUpperCase(),
                        status: 'failed',
                        provider: 'razorpay',
                        providerPaymentId: payment.id,
                        metadata: payment,
                    },
                });

                await this.prisma.subscription.update({
                    where: { id: subscription.id },
                    data: {
                        status: 'past_due',
                    },
                });

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

                await this.upsertRazorpayInvoice(inv, existing.id, existing.workspaceId);
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
        await this.fullSyncWorkspace(workspaceId).catch(() => { });

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
        if (invoice.status === 'paid') throw new BadRequestException('Invoice already paid');

        if (invoice.provider === 'razorpay') {
            // Create a Razorpay order for the due amount
            const order = await this.razorpayService.createOrder({
                amount: invoice.amountDue ?? invoice.amount,
                currency: invoice.currency,
                notes: { workspaceId, providerInvoiceId: invoice.providerInvoiceId },
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
            const finalized = await this.stripeService.finalizeInvoice(invoice.providerInvoiceId);
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
        const targetPlan = PLANS[dto.plan];
        if (!targetPlan || dto.plan === 'trial') throw new BadRequestException('Invalid plan');

        const subscription = await this.prisma.subscription.findUnique({ where: { workspaceId } });
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
        if (!targetPlan?.razorpayPlanId || targetPlan.razorpayPlanId.startsWith('replace_')) {
            throw new BadRequestException('Razorpay plan not configured');
        }

        const upgrade = this.isUpgrade(subscription.plan, dto.plan);
        const effectiveAt = dto.effectiveAt ?? (upgrade ? 'now' : 'cycle_end');
        const paymentMethod = await this.razorpayService.getSubscriptionPaymentMethod(subscription.providerSubId);
        const canUpdate = paymentMethod === 'card';

        // ── Calculate proration for refund tracking (downgrade) ──
        let refundAmount: number | null = null;
        if (!upgrade && subscription.currentPeriodStart && subscription.currentPeriodEnd) {
            const now = Date.now();
            const start = new Date(subscription.currentPeriodStart).getTime();
            const end = new Date(subscription.currentPeriodEnd).getTime();
            const totalMs = end - start;
            const remainingMs = end - now;
            const remainingFraction = Math.max(0, remainingMs / totalMs);

            const currentPlanConfig = PLANS[subscription.plan];
            const newPlanConfig = PLANS[dto.plan];

            if (currentPlanConfig && newPlanConfig) {
                const currentMonthlyAmount = currentPlanConfig.monthlyAmount || 0; // add this to PLANS config
                const newMonthlyAmount = newPlanConfig.monthlyAmount || 0;
                const proratedDiff = (currentMonthlyAmount - newMonthlyAmount) * remainingFraction;
                if (proratedDiff > 0) refundAmount = Math.round(proratedDiff);
            }
        }

        if (canUpdate) {
            // Card: direct update via Razorpay API
            const updated = await this.razorpayService.updateSubscription(subscription.providerSubId, {
                planId: targetPlan.razorpayPlanId,
                scheduleChangeAt: effectiveAt,
                // notes: { plan: dto.plan },
            });

            await this.prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    pendingPlan: dto.plan,
                    pendingEffectiveAt: effectiveAt,
                    // Track refund for downgrade — Razorpay handles it automatically for card
                    ...(refundAmount && !upgrade ? {
                        lastRefundAmount: refundAmount,
                        lastRefundStatus: 'initiated',
                        lastRefundAt: new Date(),
                    } : {}),
                },
            });

            return {
                method: 'updated',
                upgrade,
                effectiveAt,
                ...(refundAmount && !upgrade ? { refundInitiated: true, refundAmount } : {}),
            };

        } else {
            // UPI/eMandate: cancel + recreate
            await this.razorpayService.cancelSubscription(subscription.providerSubId, true);

            const newSub = await this.razorpayService.createSubscription({
                planId: targetPlan.razorpayPlanId,
                customerId: subscription.providerCustomerId,
                customerNotify: true,
                notes: {
                    workspaceId: subscription.workspaceId,
                    plan: dto.plan,
                    replacedSubscription: subscription.providerSubId,
                },
            });

            await this.prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    pendingPlan: dto.plan,
                    pendingEffectiveAt: effectiveAt,
                    pendingProviderSubId: newSub.id,
                    // For UPI downgrade, store refund as pending (manual process)
                    ...(refundAmount && !upgrade ? {
                        lastRefundAmount: refundAmount,
                        lastRefundStatus: 'initiated',
                        lastRefundAt: new Date(),
                    } : {}),
                },
            });

            return {
                method: 'recreated',
                requiresReauth: true,
                subscriptionId: newSub.id,
                shortUrl: newSub.short_url,
                key: process.env.RAZORPAY_KEY_ID,
                upgrade,
                ...(refundAmount && !upgrade ? { refundInitiated: true, refundAmount } : {}),
            };
        }
    }

    // ── Called after subscription activated / charged webhook ──────────────────
    async syncRazorpayInvoices(workspaceId: string, providerSubId: string) {
        try {
            const invoices = await this.razorpayService.fetchSubscriptionInvoices(providerSubId);
            if (!invoices?.items?.length) return;

            const subscription = await this.prisma.subscription.findUnique({ where: { workspaceId } });
            if (!subscription) return;

            for (const inv of invoices.items) {
                await this.upsertRazorpayInvoice(inv, subscription.id, workspaceId);
            }
        } catch (e) {
            // this.logger.error('Failed to sync Razorpay invoices', e);
        }
    }

    async upsertRazorpayInvoice(inv: any, subscriptionId: string, workspaceId: string) {
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
                periodStart: inv.billing_start ? new Date(inv.billing_start * 1000) : null,
                periodEnd: inv.billing_end ? new Date(inv.billing_end * 1000) : null,
                invoiceUrl: inv.short_url ?? null,
                metadata: JSON.parse(JSON.stringify(inv)),
            },
        });
    }

    // ── Called after Stripe invoice webhook ────────────────────────────────────
    async upsertStripeInvoice(inv: any, workspaceId: string, subscriptionId: string) {
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
                description: inv.description ?? inv.lines?.data?.[0]?.description ?? `Invoice ${inv.id}`,
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
                periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
                periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
                invoiceUrl: inv.hosted_invoice_url ?? null,
                invoicePdf: inv.invoice_pdf ?? null,
                metadata: JSON.parse(JSON.stringify(inv)),
            },
        });
    }

    // ── Full historical sync for a workspace ──────────────────────────────────
    async fullSyncWorkspace(workspaceId: string) {
        const subscription = await this.prisma.subscription.findUnique({ where: { workspaceId } });
        if (!subscription?.providerSubId) return;

        if (subscription.provider === 'razorpay') {
            await this.syncRazorpayInvoices(workspaceId, subscription.providerSubId);
        }

        if (subscription.provider === 'stripe') {
            await this.syncStripeInvoices(workspaceId, subscription.providerCustomerId!, subscription.id);
        }
    }

    private async syncStripeInvoices(workspaceId: string, customerId: string, subscriptionId: string) {
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