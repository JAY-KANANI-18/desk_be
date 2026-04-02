import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingAccessService } from './billing-access.service';
import { RazorpayService } from './providers/razorpay.service';
import { StripeService } from './providers/stripe.service';
import { UsageService } from './usage/usage.service';
import { PrismaService } from 'prisma/prisma.service';
import { BillingWebhookController } from './billing-webhook.controller';

@Module({
  controllers: [BillingController,BillingWebhookController],
  providers: [
    BillingService,
    BillingAccessService,
    RazorpayService,
    StripeService,
    UsageService,
    PrismaService,
  ],
  exports: [BillingService, BillingAccessService, UsageService],
})
export class BillingModule {}