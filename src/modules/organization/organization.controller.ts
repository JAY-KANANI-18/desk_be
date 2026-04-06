import { OrganizationService } from './organization.service';
import { SetupOrganizationDto } from './dto/setup-organization.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { InviteUserDto } from './dto/invite-user.dto';
import { get } from 'http';
import { OrgPermission } from 'src/common/constants/permissions';
import { JwtOnly, OrgRoute } from 'src/common/auth/route-access.decorator';
import { Controller, Post, Body, Req, Get, Put, Delete } from '@nestjs/common';

import { IsEmail, IsString, IsArray } from 'class-validator';

@Controller('api/organizations')
export class OrganizationController {
    constructor(private organizationService: OrganizationService


        
    ) { }

    
    @Post('setup')
    @JwtOnly()
    async setup(@Body() dto: SetupOrganizationDto, @Req() req: any) {
        const organization = await this.organizationService.setup(dto, req.user);

        return { data: organization };

    }
    @Put(':id')
        @OrgRoute(OrgPermission.ORG_SETTINGS_MANAGE)

    async update(@Body() dto: any, @Req() req: any) {
        const organization = await this.organizationService.update(dto, req.organizationId);

        return { data: organization };

    }

    // Get my organizations (with workspace and members)
    // @Get('me')
    // async getMyOrganizations(@Req() req: any) {
    //     const data = await this.organizationService.getMyOrganizations(
    //         req.user.id,
    //     );

    //     return data;
    // }
    @Post('invite')
    @OrgRoute(OrgPermission.USERS_MANAGE)
    inviteUser(
        @Req() req: any,
        @Body() dto: InviteUserDto,
    ) {
        const organizationId = req.headers['x-organization-id'] as string;

        return this.organizationService.inviteUser(dto, organizationId);
    }
    @Put('users')
    @OrgRoute(OrgPermission.USERS_MANAGE)
    updateUser(
        @Req() req: any,
        @Body() dto: any,
    ) {
        const organizationId = req.headers['x-organization-id'] as string;

        return this.organizationService.updateUser(dto, organizationId);
    }

    @Get('users')
    @OrgRoute(OrgPermission.USERS_VIEW) 
    async getUsersInWorkspace(@Req() req: any) {
        const workspaceId = req.headers['x-workspace-id'] as string;
        const organizationId = req.headers['x-organization-id'] as string;
        return this.organizationService.getUsersInOrganization(organizationId);
    }   



    @Delete('users/:userId')
    @OrgRoute(OrgPermission.USERS_MANAGE) 
    async removeUserFromOrganization(@Req() req: any) {
        const organizationId = req.headers['x-organization-id'] as string;
        return this.organizationService.removeUserFromOrganization(organizationId, req.params.userId);
    }
}