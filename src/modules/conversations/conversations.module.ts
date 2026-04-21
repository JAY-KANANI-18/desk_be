import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { ActivityModule } from '../activity/activity.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MentionParserService } from './mention-parser.service';
import { MessageProcessingModule } from '../outbound/message-processing.module';

@Module({
    imports: [
        PrismaModule,
        ActivityModule,
        NotificationsModule,
        MessageProcessingModule,
    ],
    controllers: [ConversationsController],
    providers: [ConversationsService, MentionParserService],
    exports: [ConversationsService],
})
export class ConversationsModule { }
