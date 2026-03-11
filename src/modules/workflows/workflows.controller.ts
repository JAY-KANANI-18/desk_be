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

@Controller('workflows')
@UseGuards(JwtGuard, WorkspaceGuard)
export class WorkflowsController {
    constructor(private service: WorkflowsService) { }

    @Get()
    list(@Req() req: any) {
        return this.service.list(req.workspaceId);
    }

    @Post()
    create(@Req() req: any, @Body() dto: any) {
        return this.service.create(req.workspaceId, dto);
    }

    @Patch(':id')
    update(@Req() req: any, @Param('id') id: string, @Body() dto: any) {
        return this.service.update(req.workspaceId, id, dto);
    }

    @Patch(':id/activate')
    activate(@Req() req: any, @Param('id') id: string) {
        return this.service.activate(req.workspaceId, id);
    }

    @Patch(':id/deactivate')
    deactivate(@Req() req: any, @Param('id') id: string) {
        return this.service.deactivate(req.workspaceId, id);
    }

    @Delete(':id')
    delete(@Req() req: any, @Param('id') id: string) {
        return this.service.delete(req.workspaceId, id);
    }
}