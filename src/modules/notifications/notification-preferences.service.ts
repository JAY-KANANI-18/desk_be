import { Injectable } from '@nestjs/common';
import {
  CallSoundNotificationScope,
  NotificationContactScope,
  SoundNotificationScope,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateNotificationPreferencesDto } from './notification.dto';

@Injectable()
export class NotificationPreferencesService {
  constructor(private prisma: PrismaService) {}

  async getUserPreferences(userId: string, workspaceId: string) {
    let prefs = await this.prisma.notificationPreference.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
    });

    if (!prefs) {
      prefs = await this.prisma.notificationPreference.create({
        data: {
          userId,
          workspaceId,
          ...await this.buildDefaultPreferences(userId, workspaceId),
        },
      });
    }

    return prefs;
  }

  async updateUserPreferences(
    userId: string,
    workspaceId: string,
    payload: UpdateNotificationPreferencesDto,
  ) {
    await this.getUserPreferences(userId, workspaceId);

    return this.prisma.notificationPreference.update({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
      data: payload,
    });
  }

  private async buildDefaultPreferences(userId: string, workspaceId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: {
        role: true,
        joinedAt: true,
      },
    });

    const role = membership?.role?.toLowerCase() ?? '';
    const isCreator =
      role.includes('owner') ||
      role.includes('admin') ||
      role.includes('ws_owner') ||
      role.includes('org_admin');

    if (isCreator) {
      return {
        soundScope: SoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
        callSoundScope: CallSoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
        desktopScope: NotificationContactScope.ALL_CONTACTS,
        mobileScope: NotificationContactScope.ALL_CONTACTS,
        emailScope: NotificationContactScope.ALL_CONTACTS,
      };
    }

    return {
      soundScope: SoundNotificationScope.ASSIGNED_ONLY,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_ONLY,
      desktopScope: NotificationContactScope.ASSIGNED_ONLY,
      mobileScope: NotificationContactScope.ASSIGNED_ONLY,
      emailScope: NotificationContactScope.ASSIGNED_ONLY,
    };
  }
}
