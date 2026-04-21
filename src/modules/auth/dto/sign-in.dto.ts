import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';

export class SignInDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  @IsOptional()
  @IsString()
  totpCode?: string;

  @IsOptional()
  @IsString()
  backupCode?: string;

  @IsOptional()
  @IsString()
  currentWorkspaceId?: string;

  @IsOptional()
  @IsString()
  currentOrganizationId?: string;
}

