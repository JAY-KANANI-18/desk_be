import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { NotificationsService } from './notifications.service';
import {
  ActivityHeartbeatDto,
  CreateCustomNotificationDto,
  IngestNotificationEventDto,
  NotificationListQueryDto,
  RegisterNotificationDeviceDto,
  UnregisterNotificationDeviceDto,
  UpdateNotificationConfigDto,
  UpdateNotificationPreferencesDto,
  UpdateNotificationStateDto,
} from './notification.dto';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationActivityService } from './notification-activity.service';
import { NotificationDeviceService } from './notification-device.service';

@WorkspaceRoute(WorkspacePermission.NOTIFICATIONS_MANAGE)
@Controller('api/notifications')
export class NotificationsController {
  constructor(
    private notifications: NotificationsService,
    private preferences: NotificationPreferencesService,
    private activity: NotificationActivityService,
    private devices: NotificationDeviceService,
  ) {}

  @Get()
  async list(@Req() req: any, @Query() query: NotificationListQueryDto) {
    return this.notifications.listForUser(
      req.user.id,
      req.workspaceId,
      query.tab ?? 'new',
      query.limit ?? 20,
      query.cursor,
    );
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    return {
      unreadCount: await this.notifications.getUnreadCount(req.user.id, req.workspaceId),
    };
  }

  @Patch(':id/state')
  async updateState(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateNotificationStateDto,
  ) {
    return this.notifications.markState(req.user.id, id, body);
  }

  @Post('mark-all-read')
  async markAllRead(@Req() req: any) {
    return this.notifications.markAllRead(req.user.id, req.workspaceId);
  }

  @Post('archive-all')
  async archiveAll(
    @Req() req: any,
    @Body('tab') tab: 'new' | 'archived' | 'all' | undefined,
  ) {
    return this.notifications.archiveAll(req.user.id, req.workspaceId, tab ?? 'new');
  }

  @Get('preferences')
  async getPreferences(@Req() req: any) {
    return this.preferences.getUserPreferences(req.user.id, req.workspaceId);
  }

  @Put('preferences')
  async updatePreferences(
    @Req() req: any,
    @Body() body: UpdateNotificationPreferencesDto,
  ) {
    return this.preferences.updateUserPreferences(req.user.id, req.workspaceId, body);
  }

  @Get('push/config')
  async getPushConfig() {
    return this.devices.getPushConfig();
  }

  @Get('devices')
  async listDevices(@Req() req: any) {
    return this.devices.listForUser(req.user.id);
  }

  @Post('devices')
  async registerDevice(@Req() req: any, @Body() body: RegisterNotificationDeviceDto) {
    return this.devices.register(req.user.id, req.workspaceId, body);
  }

  @Post('devices/unregister')
  async unregisterDevice(@Req() req: any, @Body() body: UnregisterNotificationDeviceDto) {
    return this.devices.unregister(req.user.id, body);
  }

  @Delete('devices/:id')
  async disableDevice(@Req() req: any, @Param('id') id: string) {
    return this.devices.disableById(req.user.id, id);
  }

  @Post('activity/heartbeat')
  async heartbeat(@Req() req: any, @Body() body: ActivityHeartbeatDto) {
    return this.activity.heartbeat(req.user.id, req.workspaceId, body.module);
  }

  @Patch('config')
  async updateConfig(@Req() req: any, @Body() body: UpdateNotificationConfigDto) {
    return this.activity.updateInactivityTimeout(
      req.workspaceId,
      body.inactivityTimeoutSec,
    );
  }

  @Post('custom')
  async createCustom(@Req() req: any, @Body() body: CreateCustomNotificationDto) {
    return this.notifications.createCustom(body, req.workspaceId, req.organizationId);
  }

  @Post('ingest')
  async ingest(@Req() req: any, @Body() body: IngestNotificationEventDto) {
    return this.notifications.ingestFromDto(body, req.workspaceId, req.organizationId);
  }
}
