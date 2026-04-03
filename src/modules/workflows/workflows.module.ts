import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowsController } from './workflows.controller';
import { ChannelAdaptersModule } from '../channel-adapters/channel-adapters.module';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
    imports: [PrismaModule, ConversationsModule,OutboundModule],
    controllers: [WorkflowsController],
    providers: [WorkflowsService, WorkflowEngineService],
    exports: [WorkflowEngineService],
})
export class WorkflowsModule { }