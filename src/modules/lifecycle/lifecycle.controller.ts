import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LifecycleService } from './lifecycle.service';
import { CreateLifecycleStageDto, ReorderStagesDto, ToggleVisibilityDto, UpdateLifecycleStageDto } from './lifecycle.helper';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { WorkspaceGuard } from 'src/common/guards/workspace.guard';


@Controller('api/workspaces/lifecycle')
@UseGuards(JwtGuard,WorkspaceGuard)
export class LifecycleController {
  constructor(private readonly lifecycleService: LifecycleService) {}

  /** GET /workspaces/:workspaceId/lifecycle */
  @Get()
  findAll(@Req() req) {
    return this.lifecycleService.findAll(req.workspaceId);
  }

  /** GET /workspaces/:workspaceId/lifecycle/:id */
  @Get(':id')
  findOne(
    @Req() req,
    @Param('id', ParseIntPipe) id: string,
  ) {
    return this.lifecycleService.findOne(id, req.workspaceId);
  }

  /** POST /workspaces/:workspaceId/lifecycle */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() req,
    @Body() dto: CreateLifecycleStageDto,
  ) {
    return this.lifecycleService.create(dto, req.workspaceId);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/reorder  ← must come before :id */
  @Patch('reorder')
  reorder(
    @Req() req,
    @Body() dto: any,
  ) { 
    console.log({dto});
    
    return this.lifecycleService.reorder(dto, req.workspaceId);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/visibility */
  @Patch('visibility')
  toggleVisibility(
    @Req() req,
    @Body() dto: ToggleVisibilityDto,
  ) {
    return this.lifecycleService.toggleVisibility(req.workspaceId, dto.enabled);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/:id */
  @Patch(':id')
  update(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateLifecycleStageDto,
  ) {
    return this.lifecycleService.update(id, dto, req.workspaceId);
  }

  /** DELETE /workspaces/:workspaceId/lifecycle/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req,
    @Param('id', ParseIntPipe) id: string,
  ) {
    return this.lifecycleService.remove(id, req.workspaceId);
  }
}