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
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Controller('api/workspaces/tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) { }

  @Post()
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  create(@Req() req: any, @Body() body: CreateTagDto) {
    return this.tagsService.create(req.workspaceId, body, req.user?.id);
  }

  @Get()
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tagsService.findAll(req.workspaceId, {
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
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
    @Body() body: UpdateTagDto,
  ) {
    return this.tagsService.update(req.workspaceId, id, body, req.user?.id);
  }

  @Delete(':id')
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.tagsService.remove(req.workspaceId, id);
  }
}
