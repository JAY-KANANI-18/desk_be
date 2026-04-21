import { IsOptional, IsString } from 'class-validator';

export class SelectWorkspaceDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;
}

