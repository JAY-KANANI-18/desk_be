import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class SignUpDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
