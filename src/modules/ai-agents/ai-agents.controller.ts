import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { AiAgentsService } from './ai-agents.service';
import { AiAgentsFeatureGuard } from './ai-agents-feature.guard';
import {
  CreateAiAgentDto,
  CreateKnowledgeSourceDto,
  FeedbackDto,
  SandboxRunDto,
  UpdateAiAgentDraftDto,
} from './dto/ai-agent.dto';
import { AiToolRegistryService } from './tools/ai-tool-registry.service';

@Controller('api/ai-agents')
@UseGuards(AiAgentsFeatureGuard)
export class AiAgentsController {
  constructor(
    private readonly service: AiAgentsService,
    private readonly tools: AiToolRegistryService,
  ) {}

  @Get()
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  list(@Req() req: any) {
    return this.service.listAgents(req.workspaceId);
  }

  @Post()
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  create(@Req() req: any, @Body() dto: CreateAiAgentDto) {
    return this.service.createAgent(req.workspaceId, req.user?.id, dto);
  }

  @Get('tools')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  listTools() {
    return this.tools.listTools();
  }

  @Get('knowledge-sources')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  listKnowledgeSources(@Req() req: any) {
    return this.service.listKnowledgeSources(req.workspaceId);
  }

  @Post('knowledge-sources')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  createKnowledgeSource(@Req() req: any, @Body() dto: CreateKnowledgeSourceDto) {
    return this.service.createKnowledgeSource(req.workspaceId, req.user?.id, dto);
  }

  @Post('knowledge-sources/:sourceId/enable')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  enableKnowledgeSource(@Req() req: any, @Param('sourceId') sourceId: string) {
    return this.service.enableKnowledgeSource(req.workspaceId, sourceId);
  }

  @Post('knowledge-sources/:sourceId/disable')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  disableKnowledgeSource(@Req() req: any, @Param('sourceId') sourceId: string) {
    return this.service.disableKnowledgeSource(req.workspaceId, sourceId);
  }

  @Post('knowledge-sources/:sourceId/reindex')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  reindexKnowledgeSource(@Req() req: any, @Param('sourceId') sourceId: string) {
    return this.service.reindexKnowledgeSource(req.workspaceId, sourceId);
  }

  @Get('analytics')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  analytics(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.analytics(req.workspaceId, from, to);
  }

  @Get('approvals')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  listApprovals(@Req() req: any) {
    return this.service.listApprovals(req.workspaceId);
  }

  @Post('approvals/:actionId/approve')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  approveAction(@Req() req: any, @Param('actionId') actionId: string, @Body() body: { input?: Record<string, any> }) {
    return this.service.approveAction(req.workspaceId, actionId, req.user?.id, body?.input);
  }

  @Post('approvals/:actionId/reject')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  rejectAction(@Req() req: any, @Param('actionId') actionId: string, @Body() body: { reason?: string }) {
    return this.service.rejectAction(req.workspaceId, actionId, body?.reason);
  }

  @Get('runs/:runId')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  getRun(@Req() req: any, @Param('runId') runId: string) {
    return this.service.getRun(req.workspaceId, runId);
  }

  @Post('feedback')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  feedback(@Req() req: any, @Body() dto: FeedbackDto) {
    return this.service.createFeedback(req.workspaceId, req.user?.id, dto);
  }

  @Post('conversations/:conversationId/enqueue')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  enqueueConversationRun(
    @Req() req: any,
    @Param('conversationId') conversationId: string,
    @Body() body: { messageId?: string },
  ) {
    return this.service.enqueueConversationRun(req.workspaceId, conversationId, body?.messageId);
  }

  @Get('conversations/:conversationId/status')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  conversationStatus(@Req() req: any, @Param('conversationId') conversationId: string) {
    return this.service.conversationStatus(req.workspaceId, conversationId);
  }

  @Post('conversations/:conversationId/pause')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  pauseConversation(@Req() req: any, @Param('conversationId') conversationId: string) {
    return this.service.pauseConversation(req.workspaceId, conversationId, req.user?.id);
  }

  @Post('conversations/:conversationId/resume')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  resumeConversation(@Req() req: any, @Param('conversationId') conversationId: string) {
    return this.service.resumeConversation(req.workspaceId, conversationId, req.user?.id);
  }

  @Get(':agentId')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_VIEW)
  get(@Req() req: any, @Param('agentId') agentId: string) {
    return this.service.getAgent(req.workspaceId, agentId);
  }

  @Patch(':agentId/draft')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  updateDraft(@Req() req: any, @Param('agentId') agentId: string, @Body() dto: UpdateAiAgentDraftDto) {
    return this.service.updateDraft(req.workspaceId, agentId, dto);
  }

  @Post(':agentId/publish')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  publish(@Req() req: any, @Param('agentId') agentId: string) {
    return this.service.publish(req.workspaceId, agentId, req.user?.id);
  }

  @Post(':agentId/pause')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  pause(@Req() req: any, @Param('agentId') agentId: string) {
    return this.service.pause(req.workspaceId, agentId);
  }

  @Post(':agentId/versions/:versionId/rollback')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  rollback(@Req() req: any, @Param('agentId') agentId: string, @Param('versionId') versionId: string) {
    return this.service.rollback(req.workspaceId, agentId, versionId);
  }

  @Post(':agentId/test-runs')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  sandbox(@Req() req: any, @Param('agentId') agentId: string, @Body() dto: SandboxRunDto) {
    return this.service.sandboxRun(req.workspaceId, agentId, dto);
  }

  @Delete(':agentId')
  @WorkspaceRoute(WorkspacePermission.AI_AGENTS_MANAGE)
  archive(@Req() req: any, @Param('agentId') agentId: string) {
    return this.service.archive(req.workspaceId, agentId);
  }
}
