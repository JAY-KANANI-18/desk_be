// modules/channels/providers/meta/messenger/messenger-menu.controller.ts

import { Controller, Get, Post, Param, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { MessengerMenuService, PersistentMenuLocale } from './messenger-menu.service';
// import { JwtGuard } from '../../../../../common/guards/jwt.guard';
// import { WorkspaceGuard } from '../../../../../common/guards/workspace.guard';

@Controller('channels/:channelId/messenger/menu')
// @UseGuards(JwtGuard, WorkspaceGuard)
export class MessengerMenuController {
  constructor(private readonly svc: MessengerMenuService) {}

  /**
   * POST /channels/:channelId/messenger/menu/sync
   * Pull persistent menu + get_started + greetings from Meta → DB
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.svc.sync(channelId, workspaceId);
  }

  /**
   * GET /channels/:channelId/messenger/menu?type=persistent_menu
   * List from DB — optional ?type filter
   */
  @Get()
  list(
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
    @Query('type') type?: string,
  ) {
    return this.svc.list(channelId, workspaceId, type);
  }

  /**
   * POST /channels/:channelId/messenger/menu/push
   * Update persistent menu on Meta Page
   * Body: { menu: PersistentMenuLocale[] }
   */
  @Post('push')
  @HttpCode(HttpStatus.OK)
  pushMenu(
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
    @Body('menu') menu: PersistentMenuLocale[],
  ) {
    return this.svc.pushMenu(channelId, workspaceId, menu);
  }

  /**
   * POST /channels/:channelId/messenger/menu/get-started
   * Set Get Started button payload
   * Body: { payload: "GET_STARTED" }
   */
  @Post('get-started')
  @HttpCode(HttpStatus.OK)
  pushGetStarted(
    @Param('channelId') channelId: string,
    @Query('workspaceId') workspaceId: string,
    @Body('payload') payload: string,
  ) {
    return this.svc.pushGetStarted(channelId, workspaceId, payload);
  }
}