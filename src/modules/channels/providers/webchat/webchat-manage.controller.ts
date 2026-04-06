import {
  Controller,
  Post,
  Patch,
  Delete,
  Get,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtGuard } from '../../../../common/guards/jwt.guard';
import { PrismaService } from '../../../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';

@Controller('api/channels/webchat')
@UseGuards(JwtGuard)
export class WebchatManageController {
  constructor(private readonly prisma: PrismaService) {}

  // ── Create webchat channel ─────────────────────────────────────────────────
  @Post()
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
  
  async create(
    @Req() req: any,
    @Body()
    body: {
      name: string;
      welcomeMessage?: string;
      primaryColor?: string;
      agentName?: string;
      agentAvatarUrl?: string;
      allowedOrigins?: string[];
    },
  ) {
    const widgetToken = `wc_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    const channel = await this.prisma.channel.create({
      data: {
        workspaceId: req.workspaceId,
        type: 'webchat',
        name: body.name ?? 'Website Chat',
        status: 'connected',
        identifier: widgetToken, // for quick lookup when widget connects
        config: {
          widgetToken,
          allowedOrigins: body.allowedOrigins ?? [],
          appearance: {
            primaryColor: body.primaryColor ?? '#6366f1',
            welcomeMessage: body.welcomeMessage ?? 'Hi! How can we help?',
            agentName: body.agentName ?? 'Support',
            agentAvatarUrl: body.agentAvatarUrl ?? null,
          },
        },
        // No credentials needed — no third-party OAuth
        credentials: {},
      },
    });

    return {
      ...channel,
      embedCode: this.buildEmbedCode(widgetToken),
    };
  }

  // ── Update appearance / settings ───────────────────────────────────────────
  @Patch(':channelId')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  async update(
    @Param('channelId') channelId: string,
    @Param('workspaceId') workspaceId: string,
    @Body()
    body: {
      name?: string;
      welcomeMessage?: string;
      primaryColor?: string;
      agentName?: string;
      agentAvatarUrl?: string;
      allowedOrigins?: string[];
    },
  ) {
    const channel = await this.prisma.channel.findFirstOrThrow({
      where: { id: channelId, workspaceId },
    });

    const existingConfig = channel.config as any;

    const updated = await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        name: body.name ?? channel.name,
        config: {
          ...existingConfig,
          allowedOrigins: body.allowedOrigins ?? existingConfig.allowedOrigins,
          appearance: {
            ...existingConfig.appearance,
            ...(body.primaryColor && { primaryColor: body.primaryColor }),
            ...(body.welcomeMessage && { welcomeMessage: body.welcomeMessage }),
            ...(body.agentName && { agentName: body.agentName }),
            ...(body.agentAvatarUrl !== undefined && { agentAvatarUrl: body.agentAvatarUrl }),
          },
        },
      },
    });

    return {
      ...updated,
      embedCode: this.buildEmbedCode(existingConfig.widgetToken),
    };
  }

  // ── Rotate widget token ────────────────────────────────────────────────────
  // Useful if a token is compromised
  @Post(':channelId/rotate-token')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  async rotateToken(
    @Param('channelId') channelId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    const channel = await this.prisma.channel.findFirstOrThrow({
      where: { id: channelId, workspaceId },
    });

    const newToken = `wc_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const existingConfig = channel.config as any;

    await this.prisma.channel.update({
      where: { id: channelId },
      data: { config: { ...existingConfig, widgetToken: newToken } },
    });

    return {
      widgetToken: newToken,
      embedCode: this.buildEmbedCode(newToken),
    };
  }

  // ── Get embed code ─────────────────────────────────────────────────────────
  @Get(':channelId/embed')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  async getEmbed(
    @Param('channelId') channelId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    const channel = await this.prisma.channel.findFirstOrThrow({
      where: { id: channelId, workspaceId },
    });
    const config = channel.config as any;
    return { embedCode: this.buildEmbedCode(config.widgetToken) };
  }

  // ── Delete channel ─────────────────────────────────────────────────────────
  @Delete(':channelId')
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

  async remove(
    @Param('channelId') channelId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    await this.prisma.channel.update({
      where: { id: channelId, workspaceId },
      data: { status: 'inactive' },
    });
    return { ok: true };
  }

  private buildEmbedCode(widgetToken: string): string {
    return `<script src="${process.env.APP_URL}/widget.js" data-token="${widgetToken}" async></script>`;
  }
}