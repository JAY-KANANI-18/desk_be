import { IsEmail, IsOptional, IsString, IsUrl } from 'class-validator';

export class MagicLinkDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  redirectTo?: string;

  @IsOptional()
  @IsString()
  purpose?: 'login' | 'invite';
}

