import { Controller, Post, Body, UseGuards, Req, Get, Delete } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { SetupOrganizationDto } from './dto/setup-organization.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from 'src/common/guards/workspace.guard';
import { PermissionGuard } from 'src/common/guards/permission.guard';
import { InviteUserDto } from './dto/invite-user.dto';
import { get } from 'http';

@Controller('api/organizations')
export class OrganizationController {
    constructor(private organizationService: OrganizationService) { }

    @UseGuards(JwtGuard)
    @Post('setup')
    async setup(@Body() dto: SetupOrganizationDto, @Req() req: any) {
        const organization = await this.organizationService.setup(dto, req.user);

        return { data: organization };

    }

    // Get my organizations (with workspace and members)
    @UseGuards(JwtGuard)
    @Get('me')
    async getMyOrganizations(@Req() req: any) {
        const data = await this.organizationService.getMyOrganizations(
            req.user.id,
        );

        return data;
    }
    @Post('invite')
    inviteUser(
        @Req() req: any,
        @Body() dto: InviteUserDto,
    ) {
        const organizationId = req.headers['x-organization-id'] as string;

        return this.organizationService.inviteUser(dto, organizationId);
    }

    @Get('users')
    @UseGuards(JwtGuard, WorkspaceGuard)
    async getUsersInWorkspace(@Req() req: any) {
        const workspaceId = req.headers['x-workspace-id'] as string;
        const organizationId = req.headers['x-organization-id'] as string;
        return this.organizationService.getusersInOrganization(organizationId);
    }   
    @Delete('users/:userId')
    @UseGuards(JwtGuard, WorkspaceGuard)

    async removeUserFromOrganization(@Req() req: any) {
        const organizationId = req.headers['x-organization-id'] as string;
        return this.organizationService.removeUserFromOrganization(organizationId, req.params.userId);
    }
}