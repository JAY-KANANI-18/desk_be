import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class StartImportDto {
  @IsString()
  fileId!: string;

  @IsObject()
  mapping!: Record<string, string>;

  @IsOptional()
  @IsIn(['phone', 'email'])
  matchBy?: 'phone' | 'email';

  @IsOptional()
  @IsIn(['create', 'update', 'upsert', 'overwrite'])
  importMode?: 'create' | 'update' | 'upsert' | 'overwrite';

  @IsOptional()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  autoGenerateBatchTag?: boolean;
}
