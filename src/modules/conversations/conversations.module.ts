import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { RedisService } from 'src/redis/redis.service';
import { RedisModule } from 'src/redis/redis.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityModule } from '../activity/activity.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MentionParserService } from './mention-parser.service';

@Module({
    imports: [
        PrismaModule,
        RedisModule,
        RealtimeModule,
        ActivityModule,
        NotificationsModule,
    ],
    controllers: [ConversationsController],
    providers: [ConversationsService, RealtimeModule, RedisService, PrismaService, MentionParserService],
})
export class ConversationsModule { }
