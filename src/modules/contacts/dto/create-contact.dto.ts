import { IsOptional, IsString, IsEmail, IsBoolean } from 'class-validator';

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

    @IsOptional()
    @IsString()
    lifecycleId?: string;

    @IsOptional()
    @IsBoolean()
    marketingOptOut?: boolean;
}