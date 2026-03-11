import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class SetupWorkspaceDto {

    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    name: string;


    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    organizationId: string;
}