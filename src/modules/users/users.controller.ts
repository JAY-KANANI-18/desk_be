

import { Body, Controller, Get, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtOnly } from 'src/common/auth/route-access.decorator';


@Controller('api/user')
export class UsersController {

    constructor(private usersService: UsersService, private prisma: PrismaService) { }

    @Get()
    @JwtOnly()
    async getMe(@CurrentUser() user: any) {

        return this.usersService.getMe(user.id);
    }

    @Patch()
    @JwtOnly()
    async updateProfile(
        @CurrentUser() user: any,
        @Body() dto: UpdateUserDto,
    ) {
        return this.usersService.updateProfile(user.id, dto);
    }
    @Get('organizations')
    @JwtOnly()
    async getMyOrganizations(
        @CurrentUser() user: any,
    ) {
        return this.usersService.getMyOrganizations(user.id);
    }
    @Get('workspaces')
    @JwtOnly()
    async getMyWorkspaces(
        @CurrentUser() user: any,
    ) {
        return this.usersService.getMyWorkspaces(user.id);
    }

    @Patch('me/availability')
    @JwtOnly()
    async updateAvailability(
        @CurrentUser() user: any,
        @Body('activityStatus') available: string,
    ) {
        return this.usersService.updateAvailability(user.id, available);
    }
    // @Get('/availability')
    // async getAvailability(
    //     @CurrentUser() user: any,
    //     @Req() req: any,
    // ) {
    //     const workspaceId = req.workspaceId;
    //     return this.usersService.getWorkspacesUserAvailability(workspaceId);
    // }

    // @Post("profile-image")
    // async uploadProfileImage(
    //     @Req() req: any,
    //     @Body() body: { avatarUrl: string },
    // ) {


    //    let user =  await this.prisma.user.update({
    //         where: { id: req.user.id },
    //         data: {
    //             avatarUrl: body.avatarUrl
    //         }
    //     })

    //     return user
    // }

    // @Post('invite')
    // async invite(
    //     @Body() dto: InviteUserDto,
    //     @Req() req: any,
    // ) {

    //     return this.usersService.inviteUser(
    //         req.workspaceId,
    //         dto.email,
    //         dto.role,
    //     );
    // }
}
