import { IsIn, IsObject, IsOptional } from 'class-validator';

const resourceStatuses = ['active', 'inactive'] as const;

export class UpdateIntegrationResourceDto {
  @IsOptional()
  @IsIn(resourceStatuses)
  status?: 'active' | 'inactive';

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
