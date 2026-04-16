// modules/channels/providers/whatsapp/whatsapp-templates.controller.ts

import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
// import { JwtGuard } from '../../../../common/guards/jwt.guard';
// import { WorkspaceGuard } from '../../../../common/guards/workspace.guard';

@Controller('api/channels/:channelId/whatsapp/templates')
// @UseGuards(JwtGuard, WorkspaceGuard)
export class WhatsAppTemplatesController {
  constructor(
    private readonly svc: WhatsAppTemplatesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /channels/:channelId/whatsapp/templates/sync
   * Pull all templates from Meta WABA API → upsert to DB
   */
  @Post('sync')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  @HttpCode(HttpStatus.OK)
  async sync(
    @Req() req: any,
    @Param('channelId') channelId: string,
  ) {
    const channel = await this.prisma.channel.findFirstOrThrow({
      where: { id: channelId, workspaceId: req.workspaceId, type: 'whatsapp' },
    });

    return this.svc.sync(channel);
  }

  /**
   * GET /channels/:channelId/whatsapp/templates
   * List templates from DB with optional filters
   *
   * Query params: status, category, language, search
   */
  @Get()
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  list(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Query('status')      status?: string,
    @Query('category')    category?: string,
    @Query('language')    language?: string,
    @Query('search')      search?: string,
  ) {
    return this.svc.list(channelId, req.workspaceId, {
      status,
      category,
      language,
      search,
    });
  }

  /**
   * GET /channels/:channelId/whatsapp/templates/:id/variables
   * Returns variable names needed to send this template
   * Response: { variables: ["1", "2"] }
   */
  @Get(':id/variables')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  async getVariables(@Param('id') id: string) {
    const variables = await this.svc.getVariables(id);
    return { variables };
  }

  /**
   * POST /channels/:channelId/whatsapp/templates/:id/preview
   * Render template with variables substituted
   * Body: { variables: { "1": "John", "2": "Order #999" } }
   *
   * Response: { header, body, footer, buttons, components }
   * `components` is ready to pass to sendMessage as template.components
   */
  @Post(':id/preview')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  preview(
    @Param('id') id: string,
    @Body('variables') variables: Record<string, string>,
  ) {
    return this.svc.preview(id, variables ?? {});
  }
}
