import { Controller, Get, Req, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { RedisService } from 'src/redis/redis.service';
import { AnalyticsFilterDto } from './dto/analytics-filter.dto';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';

@Controller('api/analytics')
export class AnalyticsController {
    constructor(private service: AnalyticsService, private redis: RedisService) { }



    @Get('agents')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    agentWorkload(@Req() req: any) {
        return this.service.agentWorkload(req.workspaceId);
    }

    @Get('volume')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)

    volume(@Req() req: any, @Query('days') days: string) {
        return this.service.conversationVolume(
            req.workspaceId,
            Number(days) || 7,
        );
    }
    @Get('response-metrics')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)

    responseMetrics(@Req() req: any) {
        return this.service.responseMetrics(req.workspaceId);
    }
    @Get('dashboard')
    @WorkspaceRoute(WorkspacePermission.DASHBOARD_VIEW)

    async dashboard(@Req() req: any) {
        const key = `dashboard:${req.workspaceId}`;

        const cached = await this.redis.getJSON(key);

        if (cached) return cached;

        // Fallback rebuild if cache missing
        return this.service.rebuildDashboard(req.workspaceId);
    }
    @Get('dashboard/lifecycle')
    @WorkspaceRoute(WorkspacePermission.DASHBOARD_VIEW)

    async dashboardLifecycle(@Req() req: any) {
        return this.service.getLifecycleStats(req.workspaceId);
    }

    @Get('dashboard/contacts')
    @WorkspaceRoute(WorkspacePermission.DASHBOARD_VIEW)

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
    @WorkspaceRoute(WorkspacePermission.DASHBOARD_VIEW)

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
    @WorkspaceRoute(WorkspacePermission.DASHBOARD_VIEW)
    async mergeSuggestions(@Req() req: any) {
        return this.service.findMergeSuggestions(req.workspaceId);
    }
    @Get('overview')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    async overview(@Req() req: any) {
        const workspaceId = req.workspaceId;
        return this.service.overview(workspaceId);
    }

    @Get('messages')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    async messages(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
        const workspaceId = req.workspaceId;
        return this.service.getMessagesAnalytics(workspaceId, filter);
    }

    @Get('messages/failed')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
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
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    async contacts(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
        const workspaceId = req.workspaceId;
        return this.service.getContactsAnalytics(workspaceId, filter);
    }

    @Get('conversations')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    async conversations(@Req() req: any, @Query() filter: AnalyticsFilterDto) {
        const workspaceId = req.workspaceId;
        return this.service.getConversationsAnalytics(workspaceId, filter);
    }

    @Get('lifecycle')
    @WorkspaceRoute(WorkspacePermission.REPORTS_VIEW)
    async lifecycle(@Req() req: any) {
        const workspaceId = req.workspaceId;
        return this.service.getLifecycleStats(workspaceId);
    }
}
