import { IsOptional, IsString } from 'class-validator';

export class VerifyTotpDto {
  @IsString()
  code!: string;
}

export class DisableTwoFactorDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  backupCode?: string;
}

