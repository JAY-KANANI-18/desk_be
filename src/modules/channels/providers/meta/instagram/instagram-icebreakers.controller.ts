// modules/channels/providers/meta/instagram/instagram-icebreakers.controller.ts

import { Controller, Get, Post, Param, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { InstagramIcebreakersService, IceBreakerItem } from './instagram-icebreakers.service';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
// import { JwtGuard } from '../../../../../common/guards/jwt.guard';
// import { WorkspaceGuard } from '../../../../../common/guards/workspace.guard';

@Controller('api/channels/:channelId/instagram/icebreakers')
// @UseGuards(JwtGuard, WorkspaceGuard)
export class InstagramIcebreakersController {
  constructor(private readonly svc: InstagramIcebreakersService) {}

  /**
   * POST /channels/:channelId/instagram/icebreakers/sync
   * Pull ice-breakers from Meta API → store in DB
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  sync(
    @Req() req: any,
    @Param('channelId') channelId: string,
  ) {
    return this.svc.sync(channelId, req.workspaceId);
  }

  /**
   * GET /channels/:channelId/instagram/icebreakers
   * List ice-breakers from DB
   */
  @Get()
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  list(
    @Req() req: any,
    @Param('channelId') channelId: string,
  ) {
    return this.svc.list(channelId, req.workspaceId);
  }

  /**
   * POST /channels/:channelId/instagram/icebreakers/push
   * Update ice-breakers on Meta Page
   * Body: { items: [{ question, payload }] }
   */
  @Post('push')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  @HttpCode(HttpStatus.OK)
  push(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Body('items') items: IceBreakerItem[],
  ) {
    return this.svc.push(channelId, req.workspaceId, items);
  }
}
