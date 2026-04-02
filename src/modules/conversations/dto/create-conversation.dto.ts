// src/conversations/dto/create-conversation.dto.ts

import { IsUUID, IsOptional } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  contactId: string;

  @IsOptional()
  @IsUUID()
  channelId?: string;
}