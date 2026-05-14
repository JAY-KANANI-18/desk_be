import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Public, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { BroadcastsService } from './broadcasts.service';

@Controller('api/broadcasts')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get()
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_VIEW)
  async list(
    @Req() req: any,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    const n = take ? parseInt(take, 10) : 50;
    return this.broadcasts.listRuns(workspaceId, {
      take: Number.isFinite(n) ? n : 50,
      cursor,
      search,
      status,
      sortBy,
      sortOrder,
    });
  }

  /** Approved WhatsApp templates for the selected channel (send permission). */
  @Get('whatsapp-templates/:channelId')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_SEND)
  async whatsappTemplates(@Req() req: any, @Param('channelId') channelId: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.listApprovedWhatsAppTemplates(workspaceId, channelId);
  }

  @Post('audience-preview')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_SEND)
  async audiencePreview(
    @Req() req: any,
    @Body()
    dto: {
      channelId: string;
      tagIds?: string[];
      lifecycleId?: string;
      respectMarketingOptOut?: boolean;
      limit?: number;
    },
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.previewAudience({
      workspaceId,
      channelId: dto.channelId,
      filters: {
        tagIds: dto.tagIds,
        lifecycleId: dto.lifecycleId,
        respectMarketingOptOut: dto.respectMarketingOptOut,
      },
      limit: dto.limit,
    });
  }

  @Post('send')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_SEND)
  async send(
    @Req() req: any,
    @Body()
    dto: {
      name: string;
      channelId: string;
      text?: string;
      template?: { name: string; language: string; variables?: Record<string, string> };
      tagIds?: string[];
      lifecycleId?: string;
      respectMarketingOptOut?: boolean;
      limit?: number;
      scheduledAt?: string;
    },
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.sendBroadcast({
      workspaceId,
      name: dto.name,
      channelId: dto.channelId,
      text: dto.text,
      template: dto.template,
      filters: {
        tagIds: dto.tagIds || [],
        lifecycleId: dto.lifecycleId,
        respectMarketingOptOut: dto.respectMarketingOptOut,
      },
      limit: dto.limit || 200,
      scheduledAt: dto.scheduledAt,
      authorId: req.user?.id,
    });
  }

  @Get('unsubscribe/:token')
  @Public()
  async unsubscribeGet(@Param('token') token: string) {
    return this.broadcasts.unsubscribeEmailToken(token);
  }

  @Post('unsubscribe/:token')
  @Public()
  async unsubscribePost(@Param('token') token: string) {
    return this.broadcasts.unsubscribeEmailToken(token);
  }

  @Get(':id/trace')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_VIEW)
  async trace(
    @Req() req: any,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('take') take?: string,
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedTake = take ? parseInt(take, 10) : 20;
    return this.broadcasts.getRunTrace(workspaceId, id, {
      status,
      page: Number.isFinite(parsedPage) ? parsedPage : 1,
      take: Number.isFinite(parsedTake) ? parsedTake : 20,
    });
  }

  @Patch(':id')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_SEND)
  async updateScheduled(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: { name?: string; scheduledAt?: string },
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.updateScheduledBroadcast({
      workspaceId,
      id,
      name: dto.name,
      scheduledAt: dto.scheduledAt,
    });
  }

  @Post(':id/send-now')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_SEND)
  async sendNow(@Req() req: any, @Param('id') id: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.sendScheduledNow(workspaceId, id);
  }

  @Get(':id/analytics')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_VIEW)
  async analytics(@Req() req: any, @Param('id') id: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.getRunAnalytics(workspaceId, id);
  }

  @Get(':id')
  @WorkspaceRoute(WorkspacePermission.BROADCASTS_VIEW)
  async one(@Req() req: any, @Param('id') id: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.broadcasts.getRun(workspaceId, id);
  }
}
