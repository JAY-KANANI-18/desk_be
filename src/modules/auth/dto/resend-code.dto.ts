import { IsEmail, IsIn, IsString } from 'class-validator';

export class ResendCodeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsIn(['signup', 'forgot-password'])
  flow!: 'signup' | 'forgot-password';
}

