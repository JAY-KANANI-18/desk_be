import { IsOptional, IsString } from 'class-validator';

export class ListImportExportJobsDto {
  @IsOptional()
  @IsString()
  entity?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
