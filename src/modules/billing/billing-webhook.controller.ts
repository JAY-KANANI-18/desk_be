import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { StripeService } from './providers/stripe.service';
import { RazorpayService } from './providers/razorpay.service';
import { Public } from '../../common/auth/route-access.decorator';

@Public()
@Controller('api/billing')
export class BillingWebhookController {
  constructor(
    private readonly billingService: BillingService,
    private readonly stripeService: StripeService,
    private readonly razorpayService: RazorpayService,
  ) {}

 
  @Post('webhook/stripe')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const event = this.stripeService.verifyWebhookSignature(
      req.rawBody as Buffer,
      signature,
    );

    await this.billingService.handleStripeWebhook(event);
    return { received: true };
  }

  @Post('webhook/razorpay')
  @HttpCode(200)
  async razorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const rawBody = (req.rawBody as Buffer).toString('utf8');

    const valid = this.razorpayService.verifyWebhookSignature(rawBody, signature);

    if (!valid) {
      throw new BadRequestException('Invalid webhook signature');
    }

    await this.billingService.handleRazorpayWebhook(req.body);
    return { received: true };
  }
}
