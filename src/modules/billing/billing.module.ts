import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingAccessService } from './billing-access.service';
import { RazorpayService } from './providers/razorpay.service';
import { StripeService } from './providers/stripe.service';
import { UsageService } from './usage/usage.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingWebhookController } from './billing-webhook.controller';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController,BillingWebhookController],
  providers: [
    BillingService,
    BillingAccessService,
    RazorpayService,
    StripeService,
    UsageService,
  ],
  exports: [BillingService, BillingAccessService, UsageService],
})
export class BillingModule {}
