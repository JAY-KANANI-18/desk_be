// ─── dto/create-lifecycle-stage.dto.ts ───────────────────────────────────────
import {
  IsString, IsOptional, IsBoolean,
  IsEnum, MaxLength, IsNotEmpty,
} from 'class-validator';

// ─── dto/reorder-stages.dto.ts ────────────────────────────────────────────────
import { IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';


export class CreateLifecycleStageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  emoji?: string;

  @IsEnum(['lifecycle', 'lost'])
  type: 'lifecycle' | 'lost';                 // 'lifecycle' | 'lost'


  @IsNumber()
  order: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isWon?: boolean;
}

// ─── dto/update-lifecycle-stage.dto.ts ───────────────────────────────────────
import { PartialType } from '@nestjs/mapped-types';

export class UpdateLifecycleStageDto extends PartialType(CreateLifecycleStageDto) {}

class StageOrderItem {
  @IsString()
  id: string;

  @IsNumber()
  order: number;
}

export class ReorderStagesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StageOrderItem)
  stages: StageOrderItem[];
}

// ─── dto/toggle-visibility.dto.ts ─────────────────────────────────────────────

export class ToggleVisibilityDto {
  @IsBoolean()
  enabled: boolean;
}