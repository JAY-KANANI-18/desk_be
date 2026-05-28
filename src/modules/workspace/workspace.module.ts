import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
    imports: [AuthModule, IntegrationsModule, AnalyticsModule],
    controllers: [WorkspaceController],
    providers: [WorkspaceService],
})
export class WorkspaceModule { }
