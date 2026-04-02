import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class WebchatSessionService {
  private readonly logger = new Logger(WebchatSessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async initSession(opts: {
    channel: any;
    sessionId?: string;
    visitorInfo?: {
      name?: string;
      email?: string;
      phone?: string;
      customAttributes?: Record<string, any>;
    };
  }): Promise<{
    sessionId: string;
    conversationId: string | null;
    messages: any[];
    config: any;
  }> {
    const { channel, visitorInfo } = opts;
    const sessionId = opts.sessionId ?? uuidv4();
    const config = channel.config as any;

   const contactChannel = await this.prisma.contactChannel.findFirst({
            where: {
                channelId: channel.id,
                identifier: sessionId,
            },
            select: { contactId: true },
        });    // Find existing conversation for this session
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        contactId: contactChannel?.contactId,
      },
      orderBy: { createdAt: 'desc' },
    });

    let messages: any[] = [];

    if (conversation) {
      messages = await this.prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
        take: 50,
        include: { messageAttachments: true },
      });

      // Update visitor info if provided on returning session
      if (visitorInfo?.name || visitorInfo?.email) {
        await this.updateContactProfile(channel, sessionId, visitorInfo);
      }
    }

    return {
      sessionId,
      conversationId: conversation?.id ?? null,
      messages,
      config: {
        welcomeMessage: config?.appearance?.welcomeMessage ?? 'Hi! How can we help?',
        primaryColor: config?.appearance?.primaryColor ?? '#6366f1',
        agentName: config?.appearance?.agentName ?? 'Support',
        agentAvatarUrl: config?.appearance?.agentAvatarUrl ?? null,
      },
    };
  }

  async getOrCreateContact(
    channel: any,
    sessionId: string,
  ): Promise<{ profile: { name?: string; avatarUrl?: string } | null }> {
    const existing = await this.prisma.contactChannel.findFirst({
      where: {
        channelId: channel.id,
        identifier: sessionId,
      },
      include: { contact: true },
    });

    if (existing) {
      return {
        profile: {
          name: existing.displayName ?? existing.contact.firstName,
          avatarUrl: existing.avatarUrl ?? existing.contact.avatarUrl ?? undefined,
        },
      };
    }

    // New visitor — InboundService will create the contact
    return { profile: null };
  }

  async updateContactProfile(
    channel: any,
    sessionId: string,
    visitorInfo: { name?: string; email?: string; phone?: string },
  ) {
    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { channelId: channel.id, identifier: sessionId },
      include: { contact: true },
    });

    if (!contactChannel) return;

    if (visitorInfo.name) {
      const parts = visitorInfo.name.trim().split(' ');
      await this.prisma.contact.update({
        where: { id: contactChannel.contact.id },
        data: {
          firstName: parts[0],
          lastName: parts.slice(1).join(' ') || undefined,
          email: visitorInfo.email ?? contactChannel.contact.email ?? undefined,
          phone: visitorInfo.phone ?? contactChannel.contact.phone ?? undefined,
        },
      });
      await this.prisma.contactChannel.update({
        where: { id: contactChannel.id },
        data: { displayName: visitorInfo.name },
      });
    }
  }
}