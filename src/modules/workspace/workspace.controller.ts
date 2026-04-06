import { Controller, Post, Body, UseGuards, Req, Get, Delete, Put } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { SetupWorkspaceDto } from './dto/add-workspace.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { OrgPermission, WorkspacePermission } from 'src/common/constants/permissions';
import { JwtOnly, OrgRoute, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { IsEmail, IsString, IsArray } from 'class-validator';

export class InviteUserDto {

    @IsEmail()
    @IsString()
    email: string;

    @IsString()
    role: string;

    @IsArray()
    workspaceAccess?: {
        workspaceId: string;
        role: string;
    }[];


}

@UseGuards(JwtGuard)
@Controller('api/workspaces')
export class WorkspaceController {
    constructor(private workspaceService: WorkspaceService) { }

    @Post()
    @OrgRoute(OrgPermission.WORKSPACES_MANAGE)
    async create(@Body() dto: SetupWorkspaceDto, @Req() req: any) {
        const workspace = await this.workspaceService.create(dto, req.user);

        return { data: workspace };

    }

    // Get my workspaces (with workspace and members)
    // @Get('me')
    // async getMyWorkspaces(@Req() req: any) {
    //     const data = await this.workspaceService.getMyWorkspaces(
    //         req.user.id,
    //     );

    //     return data;
    // }


 @Post('invite')
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)
    inviteUser(
        @Req() req: any,
        @Body() dto: InviteUserDto,
    ) {

        return this.workspaceService.inviteUser(dto, req.workspaceId);
    }
    @Put('users')
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)
    updateUser(
        @Req() req: any,
        @Body() dto: any,
    ) {

        return this.workspaceService.updateUser(dto, req.workspaceId);
    }


    @Get('users')
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)
    async getUsersInWorkspace(@Req() req: any) {
        return this.workspaceService.getWorkspaceusers(req.workspaceId);
    }

    @Get('/availability')
    @JwtOnly()
    async getAvailability(
        @CurrentUser() user: any,
        @Req() req: any,
    ) {
        const workspaceId = req.workspaceId;
        return this.workspaceService.getWorkspacesUserAvailability(workspaceId);
    }

    // Update workspace
    @Put(':id')
    @OrgRoute(OrgPermission.WORKSPACES_MANAGE)
    async updateWorkspace(@Req() req: any) {
        const data = await this.workspaceService.updateWorkspace(
            req.params.id,
            req.body,
        );

        return data;
    }



    // Delete workspace
    @Delete(':id')
    @OrgRoute(OrgPermission.WORKSPACES_MANAGE)
    async deleteWorkspace(@Req() req: any) {
        const data = await this.workspaceService.deleteWorkspace(
            req.params.id,
        );

        return data;
    }

}