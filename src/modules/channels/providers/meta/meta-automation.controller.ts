import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { MetaAutomationService } from './meta-automation.service';

@Controller('api/channels/:channelId/meta/automation')
export class MetaAutomationController {
  constructor(private readonly automation: MetaAutomationService) {}

  @Get('private-replies')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getPrivateReplies(@Req() req: any, @Param('channelId') channelId: string) {
    return this.automation.getPrivateRepliesConfig(channelId, req.workspaceId);
  }

  @Put('private-replies')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  savePrivateReplies(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Body() body: any,
  ) {
    return this.automation.savePrivateRepliesConfig(
      channelId,
      req.workspaceId,
      body ?? {},
    );
  }

  @Get('story-replies')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  getStoryReplies(@Req() req: any, @Param('channelId') channelId: string) {
    return this.automation.getStoryRepliesConfig(channelId, req.workspaceId);
  }

  @Put('story-replies')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  saveStoryReplies(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Body() body: any,
  ) {
    return this.automation.saveStoryRepliesConfig(
      channelId,
      req.workspaceId,
      body ?? {},
    );
  }

  @Get('targets')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  listTargets(@Req() req: any, @Param('channelId') channelId: string) {
    return this.automation.listTargets(channelId, req.workspaceId);
  }
}
