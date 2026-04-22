import { Transform } from 'class-transformer';
import {
    IsBoolean,
    IsEmail,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

const blankStringToNull = ({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

export class CreateContactDto {
    @Transform(trimString)
    @IsString()
    @IsNotEmpty()
    firstName: string;

    @Transform(blankStringToNull)
    @IsOptional()
    @IsString()
    lastName?: string | null;

    @Transform(blankStringToNull)
    @IsOptional()
    @IsEmail()
    email?: string | null;

    @Transform(blankStringToNull)
    @IsOptional()
    @IsString()
    phone?: string | null;

    @Transform(blankStringToNull)
    @IsOptional()
    @IsString()
    company?: string | null;

    @Transform(blankStringToNull)
    @IsOptional()
    @IsUUID()
    lifecycleId?: string | null;

    @IsOptional()
    @IsBoolean()
    marketingOptOut?: boolean;
}
