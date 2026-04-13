import { IsObject, IsOptional, IsString } from 'class-validator';

export class CreateExportJobDto {
  @IsString()
  entity!: string;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
