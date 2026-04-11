import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTagDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
