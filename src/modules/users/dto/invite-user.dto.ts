import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class InviteUserDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    role: string;
}