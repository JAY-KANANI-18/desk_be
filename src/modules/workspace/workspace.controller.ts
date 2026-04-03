import { Controller, Post, Body, UseGuards, Req, Get, Delete, Put } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { SetupWorkspaceDto } from './dto/add-workspace.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from 'src/common/guards/workspace.guard';
import { PermissionGuard } from 'src/common/guards/permission.guard';


@UseGuards(JwtGuard, WorkspaceGuard)
@Controller('api/workspaces')
export class WorkspaceController {
    constructor(private workspaceService: WorkspaceService) { }

    @Post()
    async create(@Body() dto: SetupWorkspaceDto, @Req() req: any) {
        const workspace = await this.workspaceService.create(dto, req.user);

        return { data: workspace };

    }

    // Get my workspaces (with workspace and members)
    @Get('me')
    async getMyWorkspaces(@Req() req: any) {
        const data = await this.workspaceService.getMyWorkspaces(
            req.user.id,
        );

        return data;
    }

    @Get('users')
    async getUsersInWorkspace(@Req() req: any) {
        return this.workspaceService.getWorkspaceusers(req.workspaceId);
    }

    // Update workspace
    @Put(':id')
    async updateWorkspace(@Req() req: any) {
        const data = await this.workspaceService.updateWorkspace(
            req.params.id,
            req.body,
        );

        return data;
    }



    // Delete workspace
    @Delete(':id')
    async deleteWorkspace(@Req() req: any) {
        const data = await this.workspaceService.deleteWorkspace(
            req.params.id,
        );

        return data;
    }

}