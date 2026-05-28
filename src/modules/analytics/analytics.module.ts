import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { Ga4AnalyticsService } from './ga4-analytics.service';

@Module({
    imports: [PrismaModule],
    providers: [AnalyticsService, Ga4AnalyticsService],
    controllers: [AnalyticsController],
    exports: [Ga4AnalyticsService],
})
export class AnalyticsModule { }
