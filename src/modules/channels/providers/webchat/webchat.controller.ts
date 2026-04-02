// webchat.controller.ts

import {
    Controller,
    Post,
    Get,
    Body,
    Param,
    Query,
    UploadedFiles,
    UseInterceptors,
    BadRequestException,
    UnauthorizedException,
    Logger,
    HttpCode,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InboundService } from '../../../inbound/inbound.service';
import { PrismaService } from 'prisma/prisma.service';
import { WebchatSessionService } from './webchat-session.service';
import { MediaService } from 'src/modules/media/media.service';

// ─── Event types the widget can send ─────────────────────────────────────────
type WebchatEvent =
    | 'message.send'        // text message
    | 'message.upload'      // file — handled separately via multipart
    | 'status.delivered'    // visitor confirmed message was displayed
    | 'status.read'         // visitor read a message
    | 'typing.start'
    | 'typing.stop'
    | 'session.init'        // widget loaded, resume or create session

@Controller('webchat')
export class WebchatController {
    private readonly logger = new Logger(WebchatController.name);

    constructor(
        private readonly inbound: InboundService,
        private readonly session: WebchatSessionService,
        private readonly mediaService: MediaService,
        private readonly prisma: PrismaService,
        private readonly events: EventEmitter2,
    ) { }

    // ── Unified webhook — all widget events come here ─────────────────────────

    @Post('webhook')
    @HttpCode(200)
    @UseInterceptors(FilesInterceptor('files', 5))
    async webhook(
        @Body() body: {
            event: string;
            widgetToken: string;
            sessionId: string;
            text?: string;
            messageType?: string;
            messageId?: string;
            visitorInfo?: any;
        },
        @UploadedFiles() files?: Express.Multer.File[],
    ) {
        const { event, widgetToken, sessionId } = body;

        if (!event) throw new BadRequestException('event is required');
        if (!widgetToken) throw new BadRequestException('widgetToken is required');

        const channel = await this.resolveChannel(widgetToken);

        switch (event) {

            case 'session.init': {
                const result = await this.session.initSession({
                    channel,
                    sessionId,
                    visitorInfo: body.visitorInfo,
                });
                return result;
            }

            case 'message.send': {
                this.validateSession(sessionId);
                if (!body.text?.trim()) throw new BadRequestException('text is required');
                const contact = await this.session.getOrCreateContact(channel, sessionId);
                await this.inbound.process({
                    channelId: channel.id,
                    workspaceId: channel.workspaceId,
                    channelType: 'webchat',
                    contactIdentifier: sessionId,
                    direction: 'incoming',
                    messageType: body.messageType ?? 'text',
                    text: body.text,
                    profile: contact.profile,
                    metadata: { sessionId },
                });
                return { ok: true };
            }

            // ── File upload — files arrive via multipart FormData ────────────────
            case 'message.upload': {
                this.validateSession(sessionId);
                if (!files?.length) throw new BadRequestException('No files received');

                const attachments: any[] = await Promise.all(
                    files.map(async (file) => {
                        const key = `webchat/${channel.workspaceId}/${Date.now()}-${file.originalname}`;
                        const media = await this.mediaService.uploadBuffer({
                            workspaceId: channel.workspaceId,
                            mediaType: 'image',
                            buffer: file.buffer,
                            mimeType: file.mimetype,
                            filename: file.originalname,
                        }); return {
                            type: this.mimeToType(file.mimetype),
                            url:media.url,
                            key:media.key,
                            mimeType: file.mimetype,
                            filename: file.originalname,
                            size: file.size,
                        };
                    }),
                );

                await this.inbound.process({
                    channelId: channel.id,
                    workspaceId: channel.workspaceId,
                    channelType: 'webchat',
                    contactIdentifier: sessionId,
                    direction: 'incoming',
                    messageType: attachments[0]?.type ?? 'document',
                    text: body.text,
                    attachments,
                    metadata: { sessionId },
                });
                return { ok: true };
            }

            case 'status.delivered': {
                this.validateSession(sessionId);
                if (!body.messageId) throw new BadRequestException('messageId is required');
                await this.updateMessageStatus(body.messageId, channel, 'delivered');
                return { ok: true };
            }

            case 'status.read': {
                this.validateSession(sessionId);
                if (!body.messageId) throw new BadRequestException('messageId is required');
                await this.updateMessageStatus(body.messageId, channel, 'read');
                return { ok: true };
            }

            case 'typing.start':
            case 'typing.stop': {
                this.validateSession(sessionId);
                this.events.emit('webchat.visitor_typing', {
                    workspaceId: channel.workspaceId,
                    channelId: channel.id,
                    sessionId,
                    isTyping: event === 'typing.start',
                });
                return { ok: true };
            }

            default:
                throw new BadRequestException(`Unknown event: ${event}`);
        }
    }



    // ── Poll fallback — GET stays separate (different HTTP method) ────────────
    @Get('messages')
    async pollMessages(
        @Query('sessionId') sessionId: string,
        @Query('widgetToken') widgetToken: string,
        @Query('after') after?: string,
    ) {
        if (!sessionId || !widgetToken) throw new BadRequestException('Missing params');
        const channel = await this.resolveChannel(widgetToken);

        const contactChannel = await this.prisma.contactChannel.findFirst({
            where: { channelId: channel.id, identifier: sessionId },
            select: { contactId: true },
        });

        if (!contactChannel) return { messages: [] };

        const conversation = await this.prisma.conversation.findFirst({
            where: { contactId: contactChannel.contactId },
            orderBy: { updatedAt: 'desc' },
        });

        if (!conversation) return { messages: [] };

        const messages = await this.prisma.message.findMany({
            where: {
                conversationId: conversation.id,
                ...(after ? { createdAt: { gt: new Date(after) } } : {}),
            },
            orderBy: { createdAt: 'asc' },
            take: 50,
            include: { messageAttachments: true },
        });

        return { messages };
    }

    // ── Public config — called by widget on load ──────────────────────────────
    @Get('config/:widgetToken')
    async getConfig(@Param('widgetToken') widgetToken: string) {
        const channel = await this.resolveChannel(widgetToken);
        const config = channel.config as any;
        const appearance = config?.appearance ?? {};

        return {
            widgetToken,
            welcomeMessage: appearance.welcomeMessage ?? 'Hi! How can we help?',
            agentName: appearance.agentName ?? 'Support',
            agentAvatarUrl: appearance.agentAvatarUrl ?? null,
            primaryColor: appearance.primaryColor ?? '#6366f1',
            position: config?.position ?? 'bottom-right',
        };
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private async updateMessageStatus(
        messageId: string,
        channel: any,
        status: 'delivered' | 'read',
    ) {
        // Only update outgoing messages (agent → visitor)
        const message = await this.prisma.message.findFirst({
            where: {
                id: messageId,
                channelId: channel.id,
                channelType: 'webchat',
                direction: 'outgoing',
            },
        });

        if (!message) {
            this.logger.warn(`status.${status} for unknown message ${messageId}`);
            return;
        }

        // Don't downgrade: read > delivered > sent
        const rank = { sent: 0, delivered: 1, read: 2 };
        const current = (message.status ?? 'sent') as string;
        if ((rank[current] ?? 0) >= rank[status]) return;

        await this.prisma.message.update({
            where: { id: message.id },
            data: { status },
        });

        this.events.emit('message.status_updated', {
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            status,
        });

        this.logger.log(`webchat status ${messageId} → ${status}`);
    }

    private async resolveChannel(widgetToken: string) {
        if (!widgetToken) throw new BadRequestException('widgetToken is required');

        const channel = await this.prisma.channel.findFirst({
            where: {
                type: 'webchat',
                status: 'connected',
                identifier: widgetToken,
            },
        });

        if (!channel) throw new UnauthorizedException('Invalid widget token');
        return channel;
    }

    private validateSession(sessionId: string) {
        if (!sessionId || sessionId.length < 8)
            throw new BadRequestException('Invalid sessionId');
    }

    private mimeToType(mimeType: string): string {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        return 'document';
    }
}