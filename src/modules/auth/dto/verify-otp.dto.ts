import { IsEmail, IsIn, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(4, 8)
  code!: string;

  @IsString()
  @IsIn(['signup', 'forgot-password', 'login'])
  flow!: 'signup' | 'forgot-password' | 'login';
}

