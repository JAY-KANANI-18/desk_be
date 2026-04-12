// modules/channels/providers/whatsapp/whatsapp.controller.ts

import {
    Controller, Get, Post, Put, Delete,
    Query, Req, Res, Body, Param, Headers,
    BadRequestException, NotFoundException, UnauthorizedException,
    Logger, HttpCode, OnModuleInit,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InboundService } from '../../../inbound/inbound.service';
import { OutboundService } from '../../../outbound/outbound.service';
import { verifyMetaSignature } from '../meta/meta-signature.util';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { IsString } from 'class-validator';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';
import { Public, WorkspaceRoute } from 'src/common/auth/route-access.decorator';
import { WorkspacePermission } from 'src/common/constants/permissions';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const FB_BASE = 'https://graph.facebook.com/v22.0';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class ConnectWhatsAppDto {
    @IsString()
    code: string;
    @IsString()
    workspaceId: string;
    @IsString()
    redirectUri: string;
}

// Manual connect (for users who set up WABA manually via Meta Business Suite)
class ManualConnectDto {
    workspaceId: string;
    accessToken: string;       // permanent system user token or temp token
    phoneNumberId: string;     // from Meta Business Suite
    wabaId: string;            // WhatsApp Business Account ID
    displayName?: string;
}

class SendTextDto {
    channelId: string;
    to: string;               // phone number with country code e.g. 919876543210
    text: string;
    previewUrl?: boolean;
}

class SendMediaDto {
    channelId: string;
    to: string;
    type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    mediaUrl?: string;
    mediaId?: string;          // if already uploaded to Meta
    caption?: string;
    filename?: string;         // for documents
}

class SendTemplateDto {
    channelId: string;
    to: string;
    templateName: string;
    languageCode: string;      // e.g. 'en_US'
    components?: any[];        // header, body, button variable substitutions
}

class SendInteractiveDto {
    channelId: string;
    to: string;
    type: 'button' | 'list';
    body: string;
    header?: string;
    footer?: string;
    buttons?: { id: string; title: string }[];
    sections?: { title: string; rows: { id: string; title: string; description?: string }[] }[];
    buttonText?: string;       // for list type
}

class SendReactionDto {
    channelId: string;
    to: string;
    messageId: string;
    emoji: string;
}

class UploadMediaDto {
    channelId: string;
    fileUrl: string;
    mimeType: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('api/channels/whatsapp')
export class WhatsAppController implements OnModuleInit {
    private readonly logger = new Logger(WhatsAppController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ChannelAdaptersRegistry,
        private readonly inbound: InboundService,
        private readonly outbound: OutboundService,
        private readonly processingQueue: MessageProcessingQueueService,
    ) { }

    async onModuleInit() {
        this.logger.log('WhatsApp: running startup token validation...');
        await this.validateAllChannelTokens();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. WEBHOOK VERIFICATION
    // GET /webhooks/whatsapp
    // ─────────────────────────────────────────────────────────────────────────

    @Get('webhook')
    @Public()
    verify(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
        @Res() res: Response,
    ) {
        if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
            this.logger.log('WhatsApp webhook verified');
            return res.status(200).send(challenge);
        }
        this.logger.warn('WhatsApp webhook verification failed');
        return res.sendStatus(403);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. WEBHOOK RECEIVER
    // POST /webhooks/whatsapp
    // ─────────────────────────────────────────────────────────────────────────

    @Post('webhook')
        @Public()

    @HttpCode(200)
    async handle(
        @Req() req: any,
        @Headers('x-hub-signature-256') signature: string,
    ) {
        if (!verifyMetaSignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET!)) {
            this.logger.warn('Invalid WhatsApp webhook signature');
            return { status: 'invalid_signature' };
        }

        const body = req.body;
        console.dir({ whatsappWebhook: body }), { depth: null };
        const phoneNumberId: string =
            body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

        if (!phoneNumberId) return { status: 'ignored' };

        const channel = await this.prisma.channel.findFirst({
            where: { type: 'whatsapp', identifier: phoneNumberId },
        });
        if (!channel) {
            this.logger.warn(`No whatsapp channel found for phoneNumberId: ${phoneNumberId}`);
            return { status: 'channel_not_found' };
        }

        const provider = this.registry.getProviderByType('whatsapp');
        const parsedList: any[] = await provider.parseWebhook(body);

        for (const parsed of parsedList) {
            if (parsed.direction === 'outgoing') {
                await this.processingQueue.enqueueWhatsappStatusUpdate({
                    channelId: channel.id,
                    channelType: 'whatsapp',
                    externalId: parsed.externalId,
                    status: parsed.metadata?.status,
                });
            } else {
                await this.processingQueue.enqueueInboundProcess({
                    channelId: channel.id,
                    workspaceId: channel.workspaceId,
                    channelType: 'whatsapp',
                    contactIdentifier: parsed.contactIdentifier,
                    channelMsgId: parsed.externalId,
                    direction: parsed.direction,
                    messageType: parsed.messageType,
                    text: parsed.text,
                    attachments: parsed.attachments,
                    replyToChannelMsgId: parsed.replyToChannelMsgId,
                    metadata: parsed.metadata,
                    raw: parsed.raw,
                });
            }
        }

        return { status: 'ok' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. OAUTH — Generate Facebook Login URL (Embedded Signup)
    //
    // WhatsApp uses "Facebook Login for Business" / "Embedded Signup"
    // This gives access to WABA (WhatsApp Business Account) + phone numbers
    //
    // GET /webhooks/whatsapp/auth/url?workspaceId=xxx&redirectUri=xxx
    // ─────────────────────────────────────────────────────────────────────────

    @Get('auth/url')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
    
    getAuthUrl(
        @Query('workspaceId') workspaceId: string,
        @Query('redirectUri') redirectUri: string,
    ) {
        if (!workspaceId || !redirectUri) {
            throw new BadRequestException('workspaceId and redirectUri are required');
        }

        const state = Buffer.from(JSON.stringify({ workspaceId })).toString('base64');

        const params = new URLSearchParams({
            client_id: process.env.WHATSAPP_APP_ID!,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: [
                'whatsapp_business_management',
                'whatsapp_business_messaging',
                'business_management',
            ].join(','),
            state,
        });

        const url = `https://www.facebook.com/dialog/oauth?${params.toString()}`;
        return { url };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. OAUTH — Callback: code → token → WABA → phone numbers → save channels
    // POST /webhooks/whatsapp/auth/callback
    // ─────────────────────────────────────────────────────────────────────────

    @Post('auth/callback')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async handleCallback(@Body() dto: ConnectWhatsAppDto) {
        const { code, workspaceId, redirectUri } = dto;
        if (!code || !workspaceId || !redirectUri) {
            throw new BadRequestException('code, workspaceId, redirectUri are required');
        }

        // Step 1: Exchange code for user token
        const userToken = await this.exchangeCodeForToken(code, redirectUri);
        this.logger.debug(`Obtained user token: ${userToken}`);

        // Step 2: Get WhatsApp Business Accounts linked to this user
        const wabas = await this.getWABAs(userToken);
        this.logger.debug(`Found ${wabas.length} WABA(s) for user`);
        if (!wabas.length) {
            throw new BadRequestException('No WhatsApp Business Accounts found.');
        }

        const connectedChannels: any[] = [];

        for (const waba of wabas) {
            try {
                // Step 3: Get phone numbers under this WABA
                const phoneNumbers = await this.getPhoneNumbers(waba.id, userToken);
                this.logger.debug(`WABA ${waba.id} has ${JSON.stringify(phoneNumbers)} phone number(s)`);
                for (const phone of phoneNumbers) {
                    // Step 4: Subscribe WABA to webhook
                    await this.subscribeWABAToWebhook(waba.id, userToken);

                    // Step 5: Upsert channel per phone number
                    const channel = await this.prisma.channel.upsert({
                        where: {
                            workspaceId,
                            type: 'whatsapp',
                            identifier: phone.id, // phone_number_id
                        },
                        update: {
                            name: phone.display_phone_number ?? phone.verified_name,
                            status: 'connected',
                            credentials: {
                                accessToken: userToken,
                                tokenLastValidatedAt: new Date(),

                            },
                            config: {
                                wabaId: waba.id,
                                wabaName: waba.name,
                                phoneNumber: phone.display_phone_number,
                                phoneNumberId:phone.id,
                                verifiedName: phone.verified_name,
                                qualityRating: phone.quality_rating,
                                codeVerificationStatus: phone.code_verification_status,
                            },
                        },
                        create: {
                            workspaceId,
                            type: 'whatsapp',
                            identifier: phone.id,
                            name: phone.display_phone_number ?? phone.verified_name,
                            credentials: {
                                accessToken: userToken,
                                tokenLastValidatedAt: new Date(),
                            },
                            status: 'connected',
                            config: {
                                wabaId: waba.id,
                                wabaName: waba.name,
                                phoneNumber: phone.display_phone_number,
                                phoneNumberId:phone.id,

                                verifiedName: phone.verified_name,
                                qualityRating: phone.quality_rating,
                                codeVerificationStatus: phone.code_verification_status,
                            },
                        },
                    });

                    connectedChannels.push(channel);
                    this.logger.log(`WhatsApp channel connected: ${phone.display_phone_number} (${phone.id})`);
                }
            } catch (e) {
                this.logger.error(`Failed to connect WABA ${waba.id}`, e);
            }
        }

        return { success: true, channels: connectedChannels };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. MANUAL CONNECT (for users who set up via Meta Business Suite directly)
    // POST /webhooks/whatsapp/connect/manual
    // ─────────────────────────────────────────────────────────────────────────

    @Post('connect/manual')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async manualConnect(@Body() dto: ManualConnectDto) {
        const { workspaceId, accessToken, phoneNumberId, wabaId, displayName } = dto;

        // Validate the token works
        try {
            await axios.get(`${FB_BASE}/${phoneNumberId}`, {
                params: { fields: 'display_phone_number,verified_name', access_token: accessToken },
            });
        } catch {
            throw new BadRequestException('Invalid access token or phone number ID');
        }

        // Subscribe to webhook
        await this.subscribeWABAToWebhook(wabaId, accessToken);

        const channel = await this.prisma.channel.upsert({
            where: {
                workspaceId, type: 'whatsapp', identifier: phoneNumberId,
            },
            update: { credentials: { accessToken, tokenLastValidatedAt: new Date() }, status: 'connected' },
            create: {
                workspaceId,
                type: 'whatsapp',
                identifier: phoneNumberId,
                name: displayName ?? phoneNumberId,
                credentials: {
                    accessToken,
                    tokenLastValidatedAt: new Date(),
                },
                status: 'connected',
                config: { wabaId, manualConnect: true },
            },
        });

        return { success: true, channel };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. REFRESH TOKEN
    //
    // Unlike Messenger, WhatsApp user tokens expire in 60 days.
    // System User tokens (from Meta Business Suite) never expire.
    // We handle both cases here.
    // POST /webhooks/whatsapp/channel/:channelId/refresh-token
    // ─────────────────────────────────────────────────────────────────────────

    @Post('channel/:channelId/refresh-token')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async refreshToken(
        @Param('channelId') channelId: string,
        @Body('newAccessToken') newAccessToken?: string,
    ) {
        const channel: any = await this.findChannelOrThrow(channelId);
        const meta = channel.config as any;

        // If system user token provided manually (never-expiring flow)
        if (newAccessToken) {
            await this.prisma.channel.update({
                where: { id: channelId },
                data: {
                    credentials: {
                        accessToken: newAccessToken,
                        tokenLastValidatedAt: new Date(),
                    },
                    status: 'connected',
                },
            });
            this.logger.log(`WhatsApp token manually updated for channel ${channelId}`);
            return { success: true, message: 'Token updated successfully' };
        }

        // Try to extend current token via fb_exchange_token
        try {
            const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: process.env.WHATSAPP_APP_ID!,
                    client_secret: process.env.WHATSAPP_APP_SECRET!,
                    fb_exchange_token: channel.credentials.accessToken,
                },
            });

            const expiresAt = data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null;

            await this.prisma.channel.update({
                where: { id: channelId },
                data: {
                    credentials: {
                        accessToken: data.access_token,
                        tokenLastValidatedAt: new Date(),
                        tokenExpiresAt: expiresAt,

                    },
                    status: 'connected',
                },
            });

            this.logger.log(`WhatsApp token refreshed for channel ${channelId}`);
            return { success: true, expiresAt };
        } catch (e) {
            // Token can't be extended — user needs to re-auth
            await this.prisma.channel.update({
                where: { id: channelId },
                data: { status: 'token_expired' },
            });
            throw new UnauthorizedException('Token expired. Please reconnect your WhatsApp account.');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. DISCONNECT
    // DELETE /webhooks/whatsapp/channel/:channelId
    // ─────────────────────────────────────────────────────────────────────────

    @Delete('channel/:channelId')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async disconnectChannel(@Param('channelId') channelId: string) {
        const channel = await this.findChannelOrThrow(channelId);

        await this.prisma.channel.update({
            where: { id: channelId },
            data: { status: 'disconnected', credentials: null },
        });

        this.logger.log(`WhatsApp channel disconnected: ${channelId}`);
        return { success: true };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. GET CHANNEL INFO (phone number details from Meta)
    // GET /webhooks/whatsapp/channel/:channelId/info
    // ─────────────────────────────────────────────────────────────────────────

    @Get('channel/:channelId/info'
        
    )
    @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)
    async getChannelInfo(@Param('channelId') channelId: string) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.get(`${FB_BASE}/${channel.identifier}`, {
            params: {
                fields: 'display_phone_number,verified_name,quality_rating,platform_type,throughput,code_verification_status',
                access_token: channel.credentials.accessToken,
            },
        });

        return { success: true, data };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. VALIDATE TOKEN
    // GET /webhooks/whatsapp/channel/:channelId/validate-token
    // ─────────────────────────────────────────────────────────────────────────

    @Get('channel/:channelId/validate-token')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async validateToken(@Param('channelId') channelId: string) {
        const channel = await this.findChannelOrThrow(channelId);
        const result = await this.checkAndHealToken(channel);
        return { success: true, ...result };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 15. MARK MESSAGE AS READ
    // POST /webhooks/whatsapp/channel/:channelId/mark-read
    // ─────────────────────────────────────────────────────────────────────────

    @Post('channel/:channelId/mark-read')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async markAsRead(
        @Param('channelId') channelId: string,
        @Body('messageId') messageId: string,
    ) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.post(
            `${FB_BASE}/${channel.identifier}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
            },
            { params: { access_token: channel.credentials.accessToken } },
        );

        return { success: true, data };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 18. GET PHONE NUMBER QUALITY & LIMITS
    // GET /webhooks/whatsapp/channel/:channelId/quality
    // ─────────────────────────────────────────────────────────────────────────

    @Get('channel/:channelId/quality')
      @WorkspaceRoute(WorkspacePermission.CHANNELS_MANAGE)

    async getQuality(@Param('channelId') channelId: string) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.get(`${FB_BASE}/${channel.identifier}`, {
            params: {
                fields: 'quality_rating,messaging_limit_tier,throughput',
                access_token: channel.credentials.accessToken,
            },
        });

        return { success: true, data };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 19. CRON — Auto token health check + auto-refresh daily at 3am
    // ─────────────────────────────────────────────────────────────────────────

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async scheduledTokenHealthCheck() {
        this.logger.log('Running scheduled WhatsApp token health check...');
        await this.validateAllChannelTokens();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Validate + auto-refresh all active channels
    // ─────────────────────────────────────────────────────────────────────────

    private async validateAllChannelTokens() {
        const channels = await this.prisma.channel.findMany({
            where: { type: 'whatsapp', status: { in: ['connected', 'token_warning'] } },
        });

        this.logger.log(`Validating ${channels.length} WhatsApp channels...`);

        for (const channel of channels) {
            try {
                await this.checkAndHealToken(channel);
            } catch (e) {
                this.logger.error(`Token check failed for channel ${channel.id}`, e);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Check token health + auto-refresh if expiring soon
    //
    // WhatsApp token strategy:
    //   - User tokens (from OAuth): expire in 60 days, CAN be refreshed
    //   - System user tokens (manual): never expire
    //   - We auto-refresh 10 days before expiry
    //   - If refresh fails → mark token_expired + alert workspace
    // ─────────────────────────────────────────────────────────────────────────

    private async checkAndHealToken(channel: any): Promise<{ valid: boolean; reason?: string; refreshed?: boolean }> {
        // Skip if recently checked (within 3 days)
        if (channel.tokenLastValidatedAt) {
            const daysSinceCheck = (Date.now() - new Date(channel.tokenLastValidatedAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceCheck < 3) return { valid: true };
        }

        try {
            const appToken = `${process.env.WHATSAPP_APP_ID}|${process.env.WHATSAPP_APP_SECRET}`;

            const { data } = await axios.get(`${FB_BASE}/debug_token`, {
                params: { input_token: channel.credentials.accessToken, access_token: appToken },
            });

            const tokenData = data?.data;

            if (!tokenData?.is_valid) {
                await this.markTokenExpired(channel, tokenData?.error?.message);
                return { valid: false, reason: tokenData?.error?.message ?? 'token_invalid' };
            }

            // Check if expiring within 10 days — auto-refresh
            const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at * 1000) : null;
            const daysUntilExpiry = expiresAt
                ? (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                : null;

            let refreshed = false;

            if (daysUntilExpiry !== null && daysUntilExpiry < 10) {
                this.logger.warn(`WhatsApp token expiring in ${Math.round(daysUntilExpiry)} days for channel ${channel.id}. Auto-refreshing...`);

                try {
                    const { data: refreshData } = await axios.get(`${FB_BASE}/oauth/access_token`, {
                        params: {
                            grant_type: 'fb_exchange_token',
                            client_id: process.env.WHATSAPP_APP_ID!,
                            client_secret: process.env.WHATSAPP_APP_SECRET!,
                            fb_exchange_token: channel.accessToken,
                        },
                    });

                    const newExpiresAt = refreshData.expires_in
                        ? new Date(Date.now() + refreshData.expires_in * 1000)
                        : null;

                    await this.prisma.channel.update({
                        where: { id: channel.id },
                        data: {
                            credentials: {
                                accessToken: refreshData.access_token, tokenExpiresAt: newExpiresAt,
                                tokenLastValidatedAt: new Date()
                            },
                            status: 'connected',

                        },
                    });

                    refreshed = true;
                    this.logger.log(`WhatsApp token auto-refreshed for channel ${channel.id}`);
                } catch (refreshErr) {
                    // Auto-refresh failed — warn user but don't break yet
                    await this.prisma.channel.update({
                        where: { id: channel.id },
                        data: {
                            status: 'token_warning',
                            credentials: {
                                ...((channel.credentials) as any),
                                tokenLastValidatedAt: new Date(),
                            },
                        },
                    });

                    // TODO: fire notification → "Your WhatsApp token expires in X days. Please reconnect."
                    this.logger.error(`Auto-refresh failed for channel ${channel.id}`, refreshErr);
                    return { valid: true, refreshed: false, reason: 'auto_refresh_failed_reconnect_soon' };
                }
            } else {
                // Token healthy — just update validated timestamp
                await this.prisma.channel.update({
                    where: { id: channel.id },
                    data: { status: 'connected', credentials: { ...((channel.credentials) as any), tokenLastValidatedAt: new Date() } },
                });
            }

            return { valid: true, refreshed };
        } catch (e) {
            this.logger.error(`debug_token call failed for channel ${channel.id}`, e);
            return { valid: false, reason: 'api_error' };
        }
    }

    private async markTokenExpired(channel: any, reason?: string) {
        await this.prisma.channel.update({
            where: { id: channel.id },
            data: { status: 'token_expired', credentials: { ...((channel.credentials) as any), tokenLastValidatedAt: new Date() } },
        });

        this.logger.error(`WhatsApp token EXPIRED for channel ${channel.id} (${channel.name}). Reason: ${reason}`);

        // TODO: fire notification event
        // await this.notifications.send({ type: 'channel_token_expired', channelId: channel.id });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    // Get channel + auto-heal token before any send operation
    private async getHealthyChannel(channelId: string) {
        const channel = await this.findChannelOrThrow(channelId);
        await this.checkAndHealToken(channel);
        // Re-fetch in case token was refreshed
        return this.findChannelOrThrow(channelId);
    }

    private async findChannelOrThrow(channelId: string) {
        const channel: any = await this.prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
        if (!channel.credentials?.accessToken) throw new UnauthorizedException(`Channel ${channelId} has no access token. Please reconnect.`);
        return channel;
    }

    private async exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
        const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
            params: {
                client_id: process.env.WHATSAPP_APP_ID!,
                client_secret: process.env.WHATSAPP_APP_SECRET!,
                redirect_uri: redirectUri,
                code,
            },
        });
        this.logger.debug(`Token exchange response: ${JSON.stringify(data)}`);
        return data.access_token;
    }

    private async getWABAs(userToken: string): Promise<any[]> {
        // Get all businesses this user manages
        const { data: bizData } = await axios.get(`${FB_BASE}/me/businesses`, {
            params: { access_token: userToken },
        });
        this.logger.debug(`User manages ${JSON.stringify(bizData.data)} businesses`);

        const businesses = bizData.data ?? [];
        this.logger.debug(`Found ${businesses.length} businesses`);

        const wabas: any[] = [];

        for (const biz of businesses) {
            // Owned WABAs (created under this business)
            try {
                const { data } = await axios.get(
                    `${FB_BASE}/${biz.id}/owned_whatsapp_business_accounts`,
                    { params: { access_token: userToken } },
                );
                wabas.push(...(data.data ?? []));
            } catch { /* business has no owned WABAs */ }

            // Client WABAs (shared by a solution provider)
            try {
                const { data } = await axios.get(
                    `${FB_BASE}/${biz.id}/client_whatsapp_business_accounts`,
                    { params: { access_token: userToken } },
                );
                wabas.push(...(data.data ?? []));
            } catch { /* business has no client WABAs */ }
        }

        this.logger.debug(`Total WABAs found: ${JSON.stringify(wabas)}`);

        if (!wabas.length) {
            throw new BadRequestException(
                'No WhatsApp Business Accounts found. Make sure your Meta App has the WhatsApp product added and your business has a WABA.',
            );
        }

        return wabas;
    }

    private async getPhoneNumbers(wabaId: string, token: string): Promise<any[]> {
        const { data } = await axios.get(
            `${FB_BASE}/${wabaId}/phone_numbers`,
            {
                params: {
                    fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,phone_number_id',
                    access_token: token,
                },
            },
        );
        return data.data ?? [];
    }

    private async subscribeWABAToWebhook(wabaId: string, token: string): Promise<void> {
        await axios.post(
            `${FB_BASE}/${wabaId}/subscribed_apps`,
            {},
            { params: { access_token: token } },
        );
        this.logger.log(`WABA ${wabaId} subscribed to webhook`);
    }
}
