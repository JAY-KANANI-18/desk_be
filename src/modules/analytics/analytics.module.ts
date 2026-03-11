import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
    imports: [PrismaModule],
    providers: [AnalyticsService],
    controllers: [AnalyticsController],
})
export class AnalyticsModule { }