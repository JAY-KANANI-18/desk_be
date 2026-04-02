// src/conversations/dto/send-message.dto.ts

import {
  IsUUID, IsOptional, IsString, IsArray,
  ValidateNested, IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AttachmentDto {
  @IsString()
  type: string;      // image | video | audio | document

  @IsString()
  url: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class SendMessageDto {
  @IsUUID()
  channelId: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}