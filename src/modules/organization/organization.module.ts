import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
    imports: [AuthModule, AnalyticsModule],
    controllers: [OrganizationController],
    providers: [OrganizationService],

})
export class OrganizationModule { }
