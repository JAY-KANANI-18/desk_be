import { IsString, IsOptional } from 'class-validator';

export class CreateTeamDto {
    @IsString()
    name: string;

    @IsOptional()
    @IsString()
    description?: string;
}