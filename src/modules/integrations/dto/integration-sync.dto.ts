import { IsArray, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

const syncModes = ['manual_sync', 'backfill'] as const;

export class IntegrationSyncDto {
  @IsOptional()
  @IsIn(syncModes)
  mode?: 'manual_sync' | 'backfill';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  resources?: string[];

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;
}
