import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { IntegrationSyncDto } from './dto/integration-sync.dto';
import { UpdateIntegrationResourceDto } from './dto/update-integration-resource.dto';
import { IntegrationsService } from './integrations.service';

type WorkspaceRequest = {
  workspaceId: string;
};

@Controller('api/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('catalog')
  @WorkspaceRoute()
  getCatalog(@Req() req: WorkspaceRequest) {
    return this.integrations.listCatalog(req.workspaceId);
  }

  @Delete('providers/:provider')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  disconnect(@Req() req: WorkspaceRequest, @Param('provider') provider: string) {
    return this.integrations.disconnectProvider(req.workspaceId, provider);
  }

  @Get(':integrationId/events')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getEvents(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.integrations.listIntegrationEvents(req.workspaceId, integrationId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Get(':integrationId/jobs')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getJobs(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.integrations.listIntegrationJobs(req.workspaceId, integrationId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Get(':integrationId/commerce/:resourceType')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getCommerceRecords(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Param('resourceType') resourceType: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.integrations.listIntegrationCommerceRecords(
      req.workspaceId,
      integrationId,
      resourceType,
      {
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
    );
  }

  @Post(':integrationId/sync')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  syncIntegration(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Body() dto: IntegrationSyncDto = {},
  ) {
    return this.integrations.syncIntegration(req.workspaceId, integrationId, dto);
  }

  @Get(':integrationId/resources')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getResources(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Query('type') type?: string,
  ) {
    return this.integrations.listIntegrationResources(req.workspaceId, integrationId, { type });
  }

  @Patch(':integrationId/resources/:resourceId')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  updateResource(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: UpdateIntegrationResourceDto,
  ) {
    return this.integrations.updateIntegrationResource(
      req.workspaceId,
      integrationId,
      resourceId,
      dto,
    );
  }

  @Post(':integrationId/actions/:action')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  runAction(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Param('action') action: string,
  ) {
    return this.integrations.runIntegrationAction(req.workspaceId, integrationId, action);
  }

  @Post(':integrationId/jobs/:jobId/retry')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  retryJob(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.integrations.retryIntegrationJob(req.workspaceId, integrationId, jobId);
  }

  @Post(':integrationId/events/:eventId/replay')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  replayEvent(
    @Req() req: WorkspaceRequest,
    @Param('integrationId') integrationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.integrations.replayIntegrationEvent(req.workspaceId, integrationId, eventId);
  }
}
