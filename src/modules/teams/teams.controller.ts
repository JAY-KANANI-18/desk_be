import {
    Controller,
    Post,
    Get,
    Delete,
    Param,
    Body,
    Req,
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';

@Controller('api/teams')
export class TeamsController {
    constructor(private service: TeamsService) { }

    @Post()
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)

    create(@Req() req: any, @Body() dto: any) {
        return this.service.create(req.workspaceId, dto);
    }

    @Get()
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)

    findAll(@Req() req: any) {
        return this.service.findAll(req.workspaceId);
    }

    @Post(':id/members')
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)

    addMember(@Param('id') id: string, @Body() dto: any) {
        return this.service.addMember(id, dto.userId);
    }

    @Delete(':id/members/:userId')
    @WorkspaceRoute(WorkspacePermission.TEAMS_MANAGE)

    removeMember(
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.service.removeMember(id, userId);
    }
}