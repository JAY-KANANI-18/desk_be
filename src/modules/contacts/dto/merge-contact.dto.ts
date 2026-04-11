import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class MergeResolutionDto {
  @IsOptional()
  @IsString()
  avatarUrl?: string | null;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  lifecycleId?: string | null;

  @IsOptional()
  @IsBoolean()
  marketingOptOut?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class MergeContactsDto {
  @IsUUID()
  secondaryContactId: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reasonCodes?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  confidenceScore?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MergeResolutionDto)
  resolution?: MergeResolutionDto;
}

export class LegacyMergeContactsDto {
  @IsUUID()
  keepId: string;

  @IsUUID()
  removeId: string;

  @IsOptional()
  @IsObject()
  merged?: Record<string, unknown>;
}

export class MergePreviewQueryDto {
  @IsUUID()
  duplicateContactId: string;
}
