import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { PrismaModule } from 'prisma/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module'; // 👈 ADD THIS
import { RedisService } from 'src/redis/redis.service';
import { RedisModule } from 'src/redis/redis.module';
import { PrismaService } from 'prisma/prisma.service';
import { ActivityModule } from '../activity/activity.module';

@Module({
    imports: [
        PrismaModule,
        RedisModule,
        RealtimeModule, // 👈 VERY IMPORTANT
        ActivityModule, // 👈 FOR EMITTING ACTIVITIES
    ],
    controllers: [ConversationsController],
    providers: [ConversationsService, RealtimeModule,RedisService,PrismaService], // 👈 ADD THIS
})
export class ConversationsModule { }