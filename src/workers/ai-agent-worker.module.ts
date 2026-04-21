import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AiAgentsModule } from '../modules/ai-agents/ai-agents.module';

@Module({
  imports: [EventEmitterModule.forRoot(), AiAgentsModule],
})
export class AiAgentWorkerModule {}
