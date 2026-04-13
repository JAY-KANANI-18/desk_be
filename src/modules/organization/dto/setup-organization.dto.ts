import { Type } from 'class-transformer';
import {
    IsArray,
    IsNotEmpty,
    IsOptional,
    IsString,
    MinLength,
    ValidateNested,
} from 'class-validator';

class SetupOrganizationOnboardingDto {
    @IsString()
    businessType: string;

    @IsOptional()
    @IsString()
    industry?: string;

    @IsString()
    teamSize: string;

    @IsString()
    monthlyConversations: string;

    @IsArray()
    @IsString({ each: true })
    channels: string[];

    @IsString()
    primaryGoal: string;

    @IsString()
    painPoint: string;

    @IsString()
    workspaceName: string;

    @IsString()
    firstName: string;

    @IsString()
    lastName: string;
}

export class SetupOrganizationDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    organizationName: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    workspaceName: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => SetupOrganizationOnboardingDto)
    onboardingData?: SetupOrganizationOnboardingDto;
}
