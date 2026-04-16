import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { MessengerTemplatesService } from './messenger-templates.service';

@Controller('api/channels/:channelId/messenger/templates')
export class MessengerTemplatesController {
  constructor(private readonly templates: MessengerTemplatesService) {}

  @Post('sync')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  @HttpCode(HttpStatus.OK)
  sync(@Req() req: any, @Param('channelId') channelId: string) {
    return this.templates.sync(channelId, req.workspaceId);
  }

  @Get()
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  list(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Query('category') category?: string,
    @Query('language') language?: string,
    @Query('search') search?: string,
  ) {
    return this.templates.list(channelId, req.workspaceId, {
      category,
      language,
      search,
    });
  }

  @Post(':id/preview')
  @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  preview(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Param('id') id: string,
    @Body('variables') variables: Record<string, string>,
  ) {
    return this.templates.preview(
      channelId,
      req.workspaceId,
      id,
      variables ?? {},
    );
  }
}
