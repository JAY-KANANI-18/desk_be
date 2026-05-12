import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { CreateSnippetDto, UpdateSnippetDto } from './dto/snippet.dto';
import { SnippetsService } from './snippets.service';

interface WorkspaceRequest {
  workspaceId: string;
  user?: { id?: string };
}

@Controller('api/workspaces/snippets')
export class SnippetsController {
  constructor(private readonly snippetsService: SnippetsService) {}

  @Get()
  @WorkspaceRoute(WorkspacePermission.SHORTCUTS_USE)
  findAll(
    @Req() req: WorkspaceRequest,
    @Query('search') search?: string,
    @Query('topic') topic?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.snippetsService.findAll(req.workspaceId, {
      search,
      topic,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @WorkspaceRoute(WorkspacePermission.SHORTCUTS_USE)
  findOne(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.snippetsService.findOne(req.workspaceId, id);
  }

  @Post()
  @WorkspaceRoute(WorkspacePermission.SHORTCUTS_MANAGE)
  create(@Req() req: WorkspaceRequest, @Body() dto: CreateSnippetDto) {
    return this.snippetsService.create(req.workspaceId, dto, req.user?.id);
  }

  @Patch(':id')
  @WorkspaceRoute(WorkspacePermission.SHORTCUTS_MANAGE)
  update(
    @Req() req: WorkspaceRequest,
    @Param('id') id: string,
    @Body() dto: UpdateSnippetDto,
  ) {
    return this.snippetsService.update(req.workspaceId, id, dto, req.user?.id);
  }

  @Delete(':id')
  @WorkspaceRoute(WorkspacePermission.SHORTCUTS_MANAGE)
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.snippetsService.remove(req.workspaceId, id);
  }
}
