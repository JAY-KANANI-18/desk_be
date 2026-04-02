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
import { WorkspaceGuard } from '../../common/guards/workspace.guard';

@Controller('api/workflows')
@UseGuards(JwtGuard, WorkspaceGuard)
export class WorkflowsController {
    constructor(private service: WorkflowsService) { }

    @Get()
    list(@Req() req: any) {
        return this.service.list(req.workspaceId);
    }
    @Get(':id')
    get(@Req() req: any, @Param('id') id: string) {
        return this.service.get(req.workspaceId, id);
    }


    @Post()
    create(@Req() req: any, @Body() dto: any) {
        return this.service.create(req.workspaceId, dto,req.user.id);
    }

    @Patch(':id')
    update(@Req() req: any, @Param('id') id: string, @Body() dto: any) {
        return this.service.update(req.workspaceId, id, dto);
    }
    @Patch(':id/rename')
    rename(@Req() req: any, @Param('id') id: string, @Body() dto: any) {
        return this.service.rename(req.workspaceId, id, dto);
    }
     @Post(':id/clone')
    clone(@Req() req: any, @Body() dto: any) {
        return this.service.clone(req.workspaceId, dto,req.user.id);
    }

    @Patch(':id/publish')
    publish(@Req() req: any, @Param('id') id: string) {
        return this.service.publish(req.workspaceId, id);
    }

    @Patch(':id/stop')
    stop(@Req() req: any, @Param('id') id: string) {
        return this.service.stop(req.workspaceId, id);
    }

    @Delete(':id')
    delete(@Req() req: any, @Param('id') id: string) {
        return this.service.delete(req.workspaceId, id);
    }
}