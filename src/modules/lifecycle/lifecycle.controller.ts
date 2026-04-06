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
import { JwtOnly, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';


@Controller('api/workspaces/lifecycle')
export class LifecycleController {
  constructor(private readonly lifecycleService: LifecycleService) {}

  /** GET /workspaces/:workspaceId/lifecycle */
  @Get()
  @JwtOnly()
  findAll(@Req() req) {
    return this.lifecycleService.findAll(req.workspaceId);
  }

  /** GET /workspaces/:workspaceId/lifecycle/:id */
  @Get(':id')
    @JwtOnly()

  findOne(
    @Req() req,
    @Param('id', ParseIntPipe) id: string,
  ) {
    return this.lifecycleService.findOne(id, req.workspaceId);
  }

  /** POST /workspaces/:workspaceId/lifecycle */
  @Post()
  @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() req,
    @Body() dto: CreateLifecycleStageDto,
  ) {
    return this.lifecycleService.create(dto, req.workspaceId);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/reorder  ← must come before :id */
  @Patch('reorder')
    @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)

  reorder(
    @Req() req,
    @Body() dto: any,
  ) { 
    console.log({dto});
    
    return this.lifecycleService.reorder(dto, req.workspaceId);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/visibility */
  @Patch('visibility')
    @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)

  toggleVisibility(
    @Req() req,
    @Body() dto: ToggleVisibilityDto,
  ) {
    return this.lifecycleService.toggleVisibility(req.workspaceId, dto.enabled);
  }

  /** PATCH /workspaces/:workspaceId/lifecycle/:id */
  @Patch(':id')
    @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)

  update(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateLifecycleStageDto,
  ) {
    return this.lifecycleService.update(id, dto, req.workspaceId);
  }

  /** DELETE /workspaces/:workspaceId/lifecycle/:id */
  @Delete(':id')
    @WorkspaceRoute(WorkspacePermission.SETTINGS_MANAGE)

  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req,
    @Param('id', ParseIntPipe) id: string,
  ) {
    return this.lifecycleService.remove(id, req.workspaceId);
  }
}