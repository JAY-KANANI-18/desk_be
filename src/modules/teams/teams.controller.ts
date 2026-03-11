import {
    Controller,
    Post,
    Get,
    Delete,
    Param,
    Body,
    Req,
    UseGuards,
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

@Controller('api/teams')
export class TeamsController {
    constructor(private service: TeamsService) { }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('team.manage')
    @Post()
    create(@Req() req: any, @Body() dto: any) {
        return this.service.create(req.workspaceId, dto);
    }

    @UseGuards(JwtGuard, WorkspaceGuard)
    @Get()
    findAll(@Req() req: any) {
        return this.service.findAll(req.workspaceId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('team.manage')
    @Post(':id/members')
    addMember(@Param('id') id: string, @Body() dto: any) {
        return this.service.addMember(id, dto.userId);
    }

    @UseGuards(JwtGuard, WorkspaceGuard, PermissionGuard)
    @RequirePermission('team.manage')
    @Delete(':id/members/:userId')
    removeMember(
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.service.removeMember(id, userId);
    }
}