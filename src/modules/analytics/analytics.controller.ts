import { Controller, Get, Req, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RedisService } from 'src/redis/redis.service';

@Controller('analytics')
@UseGuards(JwtGuard, WorkspaceGuard)
export class AnalyticsController {
    constructor(private service: AnalyticsService, private redis: RedisService) { }

    @Get('overview')
    overview(@Req() req: any) {
        return this.service.overview(req.workspaceId);
    }

    @Get('agents')
    agentWorkload(@Req() req: any) {
        return this.service.agentWorkload(req.workspaceId);
    }

    @Get('volume')
    volume(@Req() req: any, @Query('days') days: string) {
        return this.service.conversationVolume(
            req.workspaceId,
            Number(days) || 7,
        );
    }
    @Get('response-metrics')
    responseMetrics(@Req() req: any) {
        return this.service.responseMetrics(req.workspaceId);
    }
    @Get('dashboard')
    async dashboard(@Req() req: any) {
        const key = `dashboard:${req.workspaceId}`;

        const cached = await this.redis.getJSON(key);

        if (cached) return cached;

        // Fallback rebuild if cache missing
        return this.service.rebuildDashboard(req.workspaceId);
    }
}