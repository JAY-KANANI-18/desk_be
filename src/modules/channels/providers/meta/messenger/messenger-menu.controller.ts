// modules/channels/providers/meta/messenger/messenger-menu.controller.ts

import { Controller, Get, Post, Param, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { MessengerMenuService, PersistentMenuLocale } from './messenger-menu.service';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
// import { JwtGuard } from '../../../../../common/guards/jwt.guard';
// import { WorkspaceGuard } from '../../../../../common/guards/workspace.guard';

@Controller('api/channels/:channelId/messenger/menu')
// @UseGuards(JwtGuard, WorkspaceGuard)
export class MessengerMenuController {
  constructor(private readonly svc: MessengerMenuService) {}

  /**
   * POST /channels/:channelId/messenger/menu/sync
   * Pull persistent menu + get_started + greetings from Meta → DB
   */
  @Post('sync')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  sync(
    @Req() req: any,
    @Param('channelId') channelId: string,
  ) {
    return this.svc.sync(channelId, req.workspaceId);
  }

  /**
   * GET /channels/:channelId/messenger/menu?type=persistent_menu
   * List from DB — optional ?type filter
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
   * POST /channels/:channelId/messenger/menu/push
   * Update persistent menu on Meta Page
   * Body: { menu: PersistentMenuLocale[] }
   */
  @Post('push')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  @HttpCode(HttpStatus.OK)
  pushMenu(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Body('menu') menu: PersistentMenuLocale[],
  ) {
    return this.svc.pushMenu(channelId, req.workspaceId, menu);
  }

  /**
   * POST /channels/:channelId/messenger/menu/get-started
   * Set Get Started button payload
   * Body: { payload: "GET_STARTED" }
   */
  @Post('get-started')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  @HttpCode(HttpStatus.OK)
  pushGetStarted(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Body('payload') payload: string,
  ) {
    return this.svc.pushGetStarted(channelId, req.workspaceId, payload);
  }
}
