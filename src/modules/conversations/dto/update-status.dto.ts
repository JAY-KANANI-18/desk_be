// src/conversations/dto/update-status.dto.ts

import { IsIn } from 'class-validator';

export class UpdateStatusDto {
  @IsIn(['open', 'pending', 'resolved', 'closed'])
  status: 'open' | 'pending' | 'resolved' | 'closed';
}