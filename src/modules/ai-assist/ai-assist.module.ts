import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AiAssistController } from './ai-assist.controller';
import { AiProviderService } from './ai-provider.service';
import { AiAssistService } from './ai-assist.service';
import { WorkspaceAiController } from './workspace-ai.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AiAssistController, WorkspaceAiController],
  providers: [AiAssistService, AiProviderService],
})
export class AiAssistModule {}
