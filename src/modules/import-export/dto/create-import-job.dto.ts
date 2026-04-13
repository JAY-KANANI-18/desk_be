import { IsObject, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateImportJobDto {
  @IsString()
  entity!: string;

  @IsOptional()
  @IsUrl()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  contentType?: string;

  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
