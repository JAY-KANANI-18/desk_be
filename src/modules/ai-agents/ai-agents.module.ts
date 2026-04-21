import { Module } from '@nestjs/common';
import { R2Service } from 'src/common/storage/r2.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RedisModule } from 'src/redis/redis.module';
import { MessageProcessingModule } from '../outbound/message-processing.module';
import { AiAgentInboundListener } from './ai-agent-inbound.listener';
import { AiAgentsController } from './ai-agents.controller';
import { AiAgentsFeatureGuard } from './ai-agents-feature.guard';
import { AiAgentsFeatureService } from './ai-agents-feature.service';
import { AiAgentsService } from './ai-agents.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { AiGatewayService } from './gateway/ai-gateway.service';
import { AgentGuardrailsService } from './guardrails/agent-guardrails.service';
import { HumanHandoffService } from './handoff/human-handoff.service';
import { KnowledgeCrawlerService } from './knowledge/knowledge-crawler.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { AiAgentOutboundService } from './runtime/ai-agent-outbound.service';
import { AgentRuntimeService } from './runtime/agent-runtime.service';
import { AiToolRegistryService } from './tools/ai-tool-registry.service';

@Module({
  imports: [PrismaModule, RedisModule, MessageProcessingModule],
  controllers: [AiAgentsController, FeatureFlagsController],
  providers: [
    AiAgentsFeatureService,
    AiAgentsFeatureGuard,
    AiAgentsService,
    AiGatewayService,
    AgentRuntimeService,
    AiAgentOutboundService,
    KnowledgeService,
    KnowledgeCrawlerService,
    R2Service,
    AiToolRegistryService,
    AgentGuardrailsService,
    HumanHandoffService,
    AiAgentInboundListener,
  ],
  exports: [
    AiAgentsFeatureService,
    AiAgentsService,
    AgentRuntimeService,
    AiAgentOutboundService,
    AiGatewayService,
    KnowledgeService,
    KnowledgeCrawlerService,
    R2Service,
    AiToolRegistryService,
  ],
})
export class AiAgentsModule {}
