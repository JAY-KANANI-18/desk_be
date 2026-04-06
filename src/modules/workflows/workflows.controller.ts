import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
    UseGuards,
} from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';

@Controller('api/workflows')
@UseGuards(JwtGuard)
export class WorkflowsController {
    constructor(private service: WorkflowsService) { }

    @Get()
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_VIEW)
    list(@Req() req: any) {
        return this.service.list(req.workspaceId);
    }

    @Get(':id')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_VIEW)
    get(@Req() req: any, @Param('id') id: string) {
        return this.service.get(req.workspaceId, id);
    }

    @Post()
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    create(@Req() req: any, @Body() dto: any) {
        return this.service.create(req.workspaceId, dto, req.user.id);
    }

    @Patch(':id')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    update(@Req() req: any, @Param('id') id: string, @Body() dto: any) {
        return this.service.update(req.workspaceId, id, dto);
    }

    @Patch(':id/rename')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    rename(@Req() req: any, @Param('id') id: string, @Body() dto: any) {
        return this.service.rename(req.workspaceId, id, dto);
    }

    @Post(':id/clone')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    clone(@Req() req: any, @Body() dto: any) {
        return this.service.clone(req.workspaceId, dto, req.user.id);
    }

    @Patch(':id/publish')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    publish(@Req() req: any, @Param('id') id: string) {
        return this.service.publish(req.workspaceId, id);
    }

    @Patch(':id/stop')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    stop(@Req() req: any, @Param('id') id: string) {
        return this.service.stop(req.workspaceId, id);
    }

    @Delete(':id')
    @WorkspaceRoute(WorkspacePermission.WORKFLOWS_MANAGE)
    delete(@Req() req: any, @Param('id') id: string) {
        return this.service.delete(req.workspaceId, id);
    }
}