import {
  CallSoundNotificationScope,
  NotificationContactScope,
  NotificationType,
  SoundNotificationScope,
} from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class NotificationListQueryDto {
  @IsOptional()
  @IsEnum(['new', 'archived', 'all'] as const)
  tab?: 'new' | 'archived' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class UpdateNotificationStateDto {
  @IsOptional()
  read?: boolean;

  @IsOptional()
  archived?: boolean;
}

export class UpdateNotificationPreferencesDto {
  @IsEnum(SoundNotificationScope)
  soundScope!: SoundNotificationScope;

  @IsEnum(CallSoundNotificationScope)
  callSoundScope!: CallSoundNotificationScope;

  @IsEnum(NotificationContactScope)
  desktopScope!: NotificationContactScope;

  @IsEnum(NotificationContactScope)
  mobileScope!: NotificationContactScope;

  @IsEnum(NotificationContactScope)
  emailScope!: NotificationContactScope;
}

export class RegisterNotificationDeviceDto {
  @IsString()
  platform!: string;

  @IsOptional()
  @IsString()
  deviceKey?: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsObject()
  subscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };

  @IsOptional()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsString()
  pushPermission?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UnregisterNotificationDeviceDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsString()
  deviceKey?: string;

  @ValidateIf((value) => !value.deviceId && !value.deviceKey)
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ActivityHeartbeatDto {
  @IsOptional()
  @IsString()
  module?: string;
}

export class UpdateNotificationConfigDto {
  @IsInt()
  @Min(60)
  @Max(3600)
  inactivityTimeoutSec!: number;
}

export class CreateCustomNotificationDto {
  @IsArray()
  @IsUUID('4', { each: true })
  userIds!: string[];

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  sourceEntityType?: string;

  @IsOptional()
  @IsString()
  sourceEntityId?: string;

  @IsOptional()
  @IsString()
  dedupeKey?: string;
}

export class MarkNotificationsReadDto {
  @IsArray()
  @IsUUID('4', { each: true })
  ids!: string[];
}

export class IngestNotificationEventDto {
  @IsUUID()
  userId!: string;

  @IsEnum(NotificationType)
  type!: NotificationType;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  sourceEntityType?: string;

  @IsOptional()
  @IsString()
  sourceEntityId?: string;

  @IsOptional()
  @IsString()
  dedupeKey?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
