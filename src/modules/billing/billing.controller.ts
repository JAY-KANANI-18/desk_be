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
import { AddMacAddonDto, BillingService, UpdateQuantityDto } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { StripeService } from './providers/stripe.service';
import { RazorpayService } from './providers/razorpay.service';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { ChangePlanDto } from './types/change-plan.dto';
import { ChangeSeatsDto } from './types/change-seats.dto';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Param } from '@nestjs/common';

@Controller('api/billing')
@UseGuards(JwtGuard)

export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly stripeService: StripeService,
    private readonly razorpayService: RazorpayService,
  ) {}

  @Get('me')
  async me(@Req() req: any) {
    return this.billingService.getBillingMe(req.workspaceId);
  }

  @Post('checkout')
  async createCheckout(@Req() req: any, @Body() dto: CreateCheckoutDto) {
    return this.billingService.createCheckout(req.workspaceId, dto, req.user);
  }

    @Post('change-plan')
  async changePlan(@Req() req: any, @Body() dto: ChangePlanDto) {
    return this.billingService.changePlan(req.workspaceId, dto, req.user);
  }

//   @Post('change-seats')
//   async changeSeats(@Req() req: any, @Body() dto: ChangeSeatsDto) {
//     return this.billingService.changeSeats(req.workspaceId, dto, req.user);
//   }

  @Post('cancel')
  async cancel(@Req() req: any) {
    return this.billingService.cancelSubscription(req.workspaceId);
  }

  @Get('invoices')
async getInvoices(@Req() req: any) {
  return this.billingService.getInvoices(req.user.workspaceId);
}

@Post('addon')
addAddon(@Req() req: any, @Body() dto: any) {
  return this.billingService.addAddon(req.workspaceId, dto);
}


@Post('invoices/:invoiceId/pay')
payInvoice(@Req()  req: any, @Param('invoiceId') invoiceId: string) {
  return this.billingService.payInvoice(req.workspaceId, invoiceId);
}
}