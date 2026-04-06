import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { TagsService } from './tags.service';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';

@Controller('api/workspaces/tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) { }

  @Post()
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  create(@Req() req: any, @Body() body: { name: string; color?: string }) {
    return this.tagsService.create(req.workspaceId, body);
  }

  @Get()
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  findAll(@Req() req: any, @Query('search') search?: string) {
    return this.tagsService.findAll(req.workspaceId, search);
  }

  @Get(':id')
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.tagsService.findOne(req.workspaceId, id);
  }

  @Patch(':id')
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name?: string; color?: string },
  ) {
    return this.tagsService.update(req.workspaceId, id, body);
  }

  @Delete(':id')
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.tagsService.remove(req.workspaceId, id);
  }
}