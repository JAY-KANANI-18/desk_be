import { IsOptional, IsString, MinLength } from 'class-validator';

export class OAuthExchangeDto {
  @IsString()
  @MinLength(1)
  code: string;
}

export class ShopifyOAuthExchangeDto extends OAuthExchangeDto {
  @IsOptional()
  @IsString()
  shop?: string;

  @IsOptional()
  @IsString()
  hmac?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsString()
  state?: string;
}
