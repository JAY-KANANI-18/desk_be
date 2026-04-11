import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { AiAssistService } from './ai-assist.service';

@Controller('api/workspaces')
export class WorkspaceAiController {
  constructor(private readonly aiAssist: AiAssistService) {}

  @Get('ai-settings')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  getSettings(@Req() req: any) {
    return this.aiAssist.getWorkspaceSettings(req.workspaceId);
  }

  @Put('ai-settings')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  updateSettings(@Req() req: any, @Body() body: any) {
    return this.aiAssist.updateWorkspaceSettings(req.workspaceId, body);
  }

  @Get('ai-prompts')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  listPrompts(@Req() req: any) {
    return this.aiAssist.listWorkspacePrompts(req.workspaceId);
  }

  @Get('ai-assist-prompt')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  getAssistPrompt(@Req() req: any) {
    return this.aiAssist.getWorkspaceAssistPrompt(req.workspaceId);
  }

  @Put('ai-assist-prompt')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  updateAssistPrompt(@Req() req: any, @Body() body: any) {
    return this.aiAssist.updateWorkspaceAssistPrompt(req.workspaceId, body);
  }

  @Post('ai-prompts')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  createPrompt(@Req() req: any, @Body() body: any) {
    return this.aiAssist.createWorkspacePrompt(req.workspaceId, body);
  }

  @Put('ai-prompts/:promptId')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  updatePrompt(@Req() req: any, @Param('promptId') promptId: string, @Body() body: any) {
    return this.aiAssist.updateWorkspacePrompt(req.workspaceId, promptId, body);
  }

  @Delete('ai-prompts/:promptId')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  deletePrompt(@Req() req: any, @Param('promptId') promptId: string) {
    return this.aiAssist.deleteWorkspacePrompt(req.workspaceId, promptId);
  }

  @Post('ai-prompts/:promptId/activate')
  @WorkspaceRoute(WorkspacePermission.MESSAGES_VIEW)
  activatePrompt(@Req() req: any, @Param('promptId') promptId: string) {
    return this.aiAssist.activatePrompt(req.workspaceId, promptId);
  }
}
