import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { StripeService } from './providers/stripe.service';
import { RazorpayService } from './providers/razorpay.service';

@Controller('api/billing')

export class BillingWebhookController {
  constructor(
    private readonly billingService: BillingService,
    private readonly stripeService: StripeService,
    private readonly razorpayService: RazorpayService,
  ) {}

 
  @Post('webhook/stripe')
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    const event = this.stripeService.verifyWebhookSignature(
      req.rawBody as Buffer,
      signature,
    );

    await this.billingService.handleStripeWebhook(event);
    return res.status(200).send({ received: true });
  }

  @Post('webhook/razorpay')
  async razorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const rawBody = (req.rawBody as Buffer).toString('utf8');

    const valid = this.razorpayService.verifyWebhookSignature(rawBody, signature);
    console.log({valid});
    

    if (!valid) {
      return res.status(400).send({ message: 'Invalid webhook signature' });
    }

    await this.billingService.handleRazorpayWebhook(req.body);
    return res.status(200).send({ received: true });
  }
}
