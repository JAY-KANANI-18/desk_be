import { IsOptional, IsUUID } from 'class-validator';

export class AssignContactDto {
    @IsOptional()
    @IsUUID()
    assigneeId?: string;

    @IsOptional()
    @IsUUID()
    teamId?: string;
}