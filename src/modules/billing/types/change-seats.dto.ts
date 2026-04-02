import { IsInt, Min, IsOptional, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class ChangeSeatsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsIn(['now', 'cycle_end'])
  effectiveAt?: 'now' | 'cycle_end';
}