import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { AiAssistService } from './ai-assist.service';

@Controller('api/ai-assist')
export class AiAssistController {
  constructor(private readonly aiAssist: AiAssistService) {}

  @Get('conversations/:conversationId')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  conversationAssist(@Req() req: any, @Param('conversationId') conversationId: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.aiAssist.buildConversationAssist(workspaceId, conversationId);
  }

  @Post('conversations/:conversationId/rewrite')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  rewriteDraft(
    @Req() req: any,
    @Param('conversationId') conversationId: string,
    @Body() body: { draft: string; promptId: string; optionValue?: string },
  ) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.aiAssist.rewriteDraft(workspaceId, conversationId, body);
  }

  @Post('conversations/:conversationId/assist-draft')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  assistDraft(@Req() req: any, @Param('conversationId') conversationId: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.aiAssist.generateReplyDraft(workspaceId, conversationId);
  }

  @Post('conversations/:conversationId/summarize')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  summarizeConversation(@Req() req: any, @Param('conversationId') conversationId: string) {
    const workspaceId = req.workspaceId || req.headers['x-workspace-id'];
    return this.aiAssist.summarizeConversation(workspaceId, conversationId);
  }
}
