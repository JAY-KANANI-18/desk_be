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
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { WorkspaceGuard } from 'src/common/guards/workspace.guard';
import { TagsService } from './tags.service';

@Controller('api/workspaces/tags')
@UseGuards(JwtGuard, WorkspaceGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  create(@Req() req: any, @Body() body: { name: string; color?: string }) {
    return this.tagsService.create(req.workspaceId, body);
  }

  @Get()
  findAll(@Req() req: any, @Query('search') search?: string) {
    return this.tagsService.findAll(req.workspaceId, search);
  }

  @Get(':id')
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.tagsService.findOne(req.workspaceId, id);
  }

  @Patch(':id')
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name?: string; color?: string },
  ) {
    return this.tagsService.update(req.workspaceId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.tagsService.remove(req.workspaceId, id);
  }
}