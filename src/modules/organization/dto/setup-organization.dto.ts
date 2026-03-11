import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class SetupOrganizationDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    organizationName: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    workspaceName: string;
}