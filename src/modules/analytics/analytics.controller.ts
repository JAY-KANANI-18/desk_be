import { Controller, Get, Req, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RedisService } from 'src/redis/redis.service';
import { AnalyticsFilterDto } from './dto/analytics-filter.dto';

@Controller('api/analytics')
@UseGuards(JwtGuard, WorkspaceGuard)
export class AnalyticsController {
    constructor(private service: AnalyticsService, private redis: RedisService) { }



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
    @Get('dashboard/lifecycle')
    async dashboardLifecycle(@Req() req: any) {
        return this.service.getLifecycleStats(req.workspaceId);
    }

    @Get('dashboard/contacts')
    async dashboardContacts(
        @Req() req: any,
        @Query('tab') tab: 'open' | 'assigned' | 'unassigned' = 'open',
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
    ) {
        return this.service.getDashboardContacts(
            req.workspaceId,
            tab,
            cursor,
            Number(limit) || 10,
        );
    }

    @Get('dashboard/members')
    async dashboardMembers(
        @Req() req: any,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('status') status?: string,
    ) {
        return this.service.getDashboardMembers(
            req.workspaceId,
            Number(page) || 1,
            Number(limit) || 10,
            status,
        );
    }

    @Get('dashboard/merge-suggestions')
    async mergeSuggestions(@Req() req: any) {
        return this.service.findMergeSuggestions(req.workspaceId);
    }
    @Get('overview')
  async overview(@Req() req: any) {
    const workspaceId = req.workspaceId;
    return this.service.overview(workspaceId);
  }

  @Get('messages')
  async messages(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
    const workspaceId = req.workspaceId;
    return this.service.getMessagesAnalytics(workspaceId, filter);
  }

  @Get('messages/failed')
  async failedMessages(@Req() req: any, @Query() query: any) {
    const workspaceId = req.workspaceId;
    return this.service.getFailedMessageLogs(
      workspaceId,
      query,
      Number(query.page || 1),
      Number(query.limit || 20),
    );
  }

  @Get('contacts')
  async contacts(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
    const workspaceId = req.workspaceId;
    return this.service.getContactsAnalytics(workspaceId, filter);
  }

  @Get('conversations')
  async conversations(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
    const workspaceId = req.workspaceId;
    return this.service.getConversationsAnalytics(workspaceId, filter);
  }

  @Get('lifecycle')
  async lifecycle(@Req() req: any) {
    const workspaceId = req.workspaceId;
    return this.service.getLifecycleStats(workspaceId);
  }
}