import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateCheckoutDto {
  @IsString()
  @IsIn(['starter', 'growth', 'pro'])
  plan: string;

  @IsString()
  @IsIn(['razorpay', 'stripe'])
  provider: 'razorpay' | 'stripe';

  @IsOptional()
  @IsString()
  successUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}