// modules/channels/providers/meta/instagram/instagram-icebreakers.controller.ts

import { Controller, Get, Post, Param, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { InstagramIcebreakersService, IceBreakerItem } from './instagram-icebreakers.service';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
// import { JwtGuard } from '../../../../../common/guards/jwt.guard';
// import { WorkspaceGuard } from '../../../../../common/guards/workspace.guard';

@Controller('channels/:channelId/instagram/icebreakers')
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
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.svc.sync(channelId, workspaceId);
  }

  /**
   * GET /channels/:channelId/instagram/icebreakers
   * List ice-breakers from DB
   */
  @Get()
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  list(
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.svc.list(channelId, workspaceId);
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
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
    @Body('items') items: IceBreakerItem[],
  ) {
    return this.svc.push(channelId, workspaceId, items);
  }
}