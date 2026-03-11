import { IsOptional, IsString, IsEmail } from 'class-validator';

export class CreateContactDto {
    @IsString()
    firstName: string;
    @IsString()
    lastName: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    company?: string;
}