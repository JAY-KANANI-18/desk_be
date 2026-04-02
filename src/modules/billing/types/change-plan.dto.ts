import { IsIn, IsOptional, IsString } from 'class-validator';

export class ChangePlanDto {
  @IsString()
  @IsIn(['starter', 'growth']) // add your valid plans
  plan: string;

  // 'now' for upgrade, 'cycle_end' for downgrade
  @IsOptional()
  @IsIn(['now', 'cycle_end'])
  effectiveAt?: 'now' | 'cycle_end';
}