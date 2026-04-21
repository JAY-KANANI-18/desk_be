import { IsEmail } from 'class-validator';

export class RequestCodeDto {
  @IsEmail()
  email!: string;
}

