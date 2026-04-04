// modules/channels/providers/meta/messenger/messenger.controller.ts

import {
    Controller, Get, Post, Put, Delete,
    Query, Req, Res, Body, Param, Headers,
    BadRequestException, NotFoundException, UnauthorizedException,
    Logger, HttpCode,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../../../../prisma/prisma.service';
import { InboundService } from '../../../../inbound/inbound.service';
import { OutboundService } from '../../../../outbound/outbound.service';
import { verifyMetaSignature } from '../meta-signature.util';
import axios from 'axios';
import { IsString } from 'class-validator';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';

// ─── Constants ────────────────────────────────────────────────────────────────

const FB_API = 'https://graph.facebook.com';
const FB_API_VERSION = 'v22.0';
const FB_BASE = `${FB_API}/${FB_API_VERSION}`;

// Long-lived page tokens don't expire UNLESS:
//   - User changes FB password
//   - User removes app permission
//   - Token unused for 60 days
// We proactively re-validate every 7 days and on every outbound send.

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class ConnectMessengerDto {

    @IsString()
    code: string;

    @IsString()
    workspaceId: string;
    @IsString()
    redirectUri: string;
}


// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('api/channels/messenger')
export class MessengerController {
    private readonly logger = new Logger(MessengerController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ChannelAdaptersRegistry,
        private readonly inbound: InboundService,
        private readonly outbound: OutboundService,
    ) { }



    // ─────────────────────────────────────────────────────────────────────────
    // 1. WEBHOOK VERIFICATION
    // GET /webhooks/messenger
    // ─────────────────────────────────────────────────────────────────────────

    @Get('webhook')
    verify(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
        @Res() res: Response,
    ) {
        if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
            this.logger.log('Messenger webhook verified');
            return res.status(200).send(challenge);
        }
        this.logger.warn('Messenger webhook verification failed');
        return res.sendStatus(403);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. WEBHOOK RECEIVER
    // POST /webhooks/messenger
    // ─────────────────────────────────────────────────────────────────────────

    @Post('webhook')
    @HttpCode(200)
    async handle(
        @Req() req: any,
        @Headers('x-hub-signature-256') signature: string,
    ) {
        if (!verifyMetaSignature(req.rawBody, signature, process.env.MESSENGER_APP_SECRET!)) {
            this.logger.warn('Invalid Messenger webhook signature');
            return { status: 'invalid_signature' };
        }

        const body = req.body;
        const pageId = body?.entry?.[0]?.id;
        if (!pageId) return { status: 'ignored' };

        const channel = await this.prisma.channel.findFirst({
            where: { type: 'messenger', identifier: pageId },
        });
        if (!channel) return { status: 'channel_not_found' };

        const provider = this.registry.getProviderByType('messenger');
        const parsedList: any[] = await provider.parseWebhook(body);

        for (const parsed of parsedList) {
            // ── Outgoing echo ──
            if (parsed.contactIdentifier === channel.identifier) {
                await this.outbound.processExternalOutbound({
                    workspaceId: channel.workspaceId,
                    channelId: channel.id,
                    channelType: 'messenger',
                    channelMsgId: parsed.externalId,
                    recipientIdentifier: parsed.recipientIdentifier!,
                    text: parsed.text,
                    attachments: parsed.attachments,
                    timestamp: parsed.timestamp,
                    metadata: parsed.metadata,
                    profile: parsed.profile,
                });
                continue;
            }

            // ── Delivery / Read receipts ──
            if (parsed.direction === 'outgoing') {
                if (parsed.messageType === 'status') {
                    await this.outbound.processMessengerDelivery({
                        channelId: channel.id,
                        externalId: parsed.externalId,
                    });
                }
                if (parsed.messageType === 'status_read') {
                    await this.outbound.processMessengerRead({
                        channelId: channel.id,
                        contactIdentifier: parsed.contactIdentifier,
                        watermark: parsed.watermark,
                    });
                }
                continue;
            }

            // ── Fetch contact profile if not cached ──
            let profile = null;
            const hasProfile = await this.prisma.contactChannel.findFirst({
                where: { identifier: parsed.contactIdentifier, channelId: channel.id },
                select: { id: true, avatarUrl: true },
            });

            if (!hasProfile?.avatarUrl && provider.getContactProfile) {
                try {
                    profile = await provider.getContactProfile(parsed.contactIdentifier, channel);
                } catch (e) {
                    this.logger.warn('Failed to fetch contact profile', e);
                }
            }

            // ── Process inbound ──
            await this.inbound.process({
                channelId: channel.id,
                workspaceId: channel.workspaceId,
                channelType: 'messenger',
                contactIdentifier: parsed.contactIdentifier,
                direction: parsed.direction,
                messageType: parsed.messageType,
                text: parsed.text,
                attachments: parsed.attachments,
                metadata: parsed.metadata,
                raw: parsed.raw,
                profile,
            });
        }

        return { status: 'ok' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. OAUTH — Generate Facebook Login URL
    // GET /webhooks/messenger/auth/url?workspaceId=xxx&redirectUri=xxx
    // ─────────────────────────────────────────────────────────────────────────

    @Get('auth/url')
    async getAuthUrl(
        @Query('workspaceId') workspaceId: string,
        @Query('redirectUri') redirectUri: string,
    ) {
        if (!workspaceId || !redirectUri) {
            throw new BadRequestException('workspaceId and redirectUri are required');
        }

        const state = Buffer.from(JSON.stringify({ workspaceId })).toString('base64');

        const params = new URLSearchParams({
            client_id: process.env.MESSENGER_APP_ID!,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: [
                // "business_management",
                'pages_manage_metadata',

                // 'pages_show_list', // respond --
                'pages_messaging', // repond ++ 2Cpages_messaging_phone_number 2Cpages_utility_messaging email
                // 'pages_read_engagement',
                'public_profile',
            ].join(','),
            state,
        });

        const url = `https://www.facebook.com/dialog/oauth?${params.toString()}`;
        return { url };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. OAUTH — Callback: code → user token → page token → save all pages
    // POST /webhooks/messenger/auth/callback
    // ─────────────────────────────────────────────────────────────────────────

    @Post('auth/callback')
    async handleCallback(@Body() dto: ConnectMessengerDto) {
        const { code, workspaceId, redirectUri } = dto;
        if (!code || !workspaceId || !redirectUri) {
            throw new BadRequestException('code, workspaceId, redirectUri are required');
        }

        // Step 1: Exchange code for short-lived user token
        const shortLivedUserToken = await this.exchangeCodeForUserToken(code, redirectUri);
        this.logger.log(`Short-lived token: ${shortLivedUserToken}`);

        // Step 2: Exchange for long-lived user token (60 days)
        const longLivedUserToken = await this.exchangeLongLivedUserToken(shortLivedUserToken);
        this.logger.log(`long-lived token: ${{ longLivedUserToken }}`);

        // Step 3: Get all pages this user manages
        const pages = await this.getUserPages(longLivedUserToken);
        if (!pages.length) {
            throw new BadRequestException('No Facebook Pages found. Create a Page and link your Instagram first.');
        }

        // Step 4: For each page, get never-expiring page token + subscribe to webhooks
        const connectedChannels: any[] = [];

        for (const page of pages) {
            try {
                // Page token from /me/accounts is already long-lived (never expires unless revoked)
                const pageToken = page.access_token;
                const pageId = page.id;
                const pageName = page.name;

                // Get page profile picture
                const pageInfo = await this.getPageInfo(pageId, pageToken);

                // Subscribe page to webhook
                await this.subscribePageToWebhook(pageId, pageToken);

                // Upsert channel
                const channel = await this.prisma.channel.upsert({
                    where: {
                        workspaceId,
                        type: 'messenger',
                        identifier: pageId,

                    },
                    update: {
                        credentials: { accessToken: pageToken, tokenLastValidatedAt: new Date() },
                        name: pageName,
                        status: 'connected',
                        config: {
                            pageName,
                            pageCategory: page.category,
                            pagePicture: pageInfo?.picture?.data?.url,
                            pageFollowers: pageInfo?.fan_count,
                            tokenNeverExpires: true,
                        },
                    },
                    create: {
                        workspaceId,
                        type: 'messenger',
                        identifier: pageId,
                        name: pageName,
                        credentials: { accessToken: pageToken, tokenLastValidatedAt: new Date() },
                        status: 'connected',
                        config: {
                            pageName,

                            pageCategory: page.category,
                            pagePicture: pageInfo?.picture?.data?.url,
                            pageFollowers: pageInfo?.fan_count,
                            tokenNeverExpires: true,
                        },
                    },
                });

                connectedChannels.push(channel);
                this.logger.log(`Messenger page connected: ${pageName} (${pageId})`);
            } catch (e) {
                this.logger.error(`Failed to connect page ${page.id}`, e);
            }
        }

        return { success: true, channels: connectedChannels };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. DISCONNECT channel
    // DELETE /webhooks/messenger/channel/:channelId
    // ─────────────────────────────────────────────────────────────────────────

    @Delete('channel/:channelId')
    async disconnectChannel(@Param('channelId') channelId: string) {
        const channel: any = await this.findChannelOrThrow(channelId);

        // Unsubscribe page from webhooks
        try {
            await axios.delete(`${FB_BASE}/${channel.identifier}/subscribed_apps`, {
                params: { access_token: channel.credentials.accessToken },
            });
        } catch (e) {
            this.logger.warn('Failed to unsubscribe page from webhooks', e);
        }

        await this.prisma.channel.update({
            where: { id: channelId },
            data: { status: 'disconnected', credentials: { accessToken: null, tokenLastValidatedAt: null } },
        });

        this.logger.log(`Messenger channel disconnected: ${channelId}`);
        return { success: true };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. GET CHANNEL INFO
    // GET /webhooks/messenger/channel/:channelId/info
    // ─────────────────────────────────────────────────────────────────────────

    @Get('channel/:channelId/info')
    async getChannelInfo(@Param('channelId') channelId: string) {
        const channel: any = await this.findChannelOrThrow(channelId);
        const info = await this.getPageInfo(channel.identifier, channel.credentials.accessToken);
        return { success: true, data: info };
    }


    // ─────────────────────────────────────────────────────────────────────────
    // 11. GET CONTACT PROFILE (by PSID)
    // GET /webhooks/messenger/channel/:channelId/contact/:psid
    // ─────────────────────────────────────────────────────────────────────────

    @Get('channel/:channelId/contact/:psid')
    async getContactProfile(
        @Param('channelId') channelId: string,
        @Param('psid') psid: string,
    ) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.get(`${FB_BASE}/${psid}`, {
            params: {
                fields: 'name,first_name,last_name,profile_pic,locale,timezone,gender',
                access_token: channel.credentials.accessToken,
            },
        });
        return { success: true, data };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 12. MARK AS READ
    // POST /webhooks/messenger/channel/:channelId/mark-read
    // ─────────────────────────────────────────────────────────────────────────

    @Post('channel/:channelId/mark-read')
    async markAsRead(
        @Param('channelId') channelId: string,
        @Body('recipientPsid') recipientPsid: string,
    ) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.post(
            `${FB_BASE}/${channel.identifier}/messages`,
            { recipient: { id: recipientPsid }, sender_action: 'mark_seen' },
            { params: { access_token: channel.credentials.accessToken } },
        );
        return { success: true, data };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 13. TYPING INDICATOR
    // POST /webhooks/messenger/channel/:channelId/typing
    // ─────────────────────────────────────────────────────────────────────────

    @Post('channel/:channelId/typing')
    async sendTyping(
        @Param('channelId') channelId: string,
        @Body('recipientPsid') recipientPsid: string,
        @Body('action') action: 'typing_on' | 'typing_off' = 'typing_on',
    ) {
        const channel: any = await this.findChannelOrThrow(channelId);

        const { data } = await axios.post(
            `${FB_BASE}/${channel.identifier}/messages`,
            { recipient: { id: recipientPsid }, sender_action: action },
            { params: { access_token: channel.credentials.accessToken } },
        );
        return { success: true, data };
    }


    // ─────────────────────────────────────────────────────────────────────────
    // 20. CRON — Auto token health check every day at 2am
    //     Marks channels as token_warning 7 days before issues
    //     Page tokens don't expire but can be revoked — we detect early
    // ─────────────────────────────────────────────────────────────────────────


    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Check token + heal if possible
    //
    // Strategy:
    //   1. Debug token via /debug_token
    //   2. If valid → update tokenLastValidatedAt, return valid
    //   3. If invalid → mark channel as token_expired + notify workspace
    //   4. Page tokens can't be auto-refreshed (need user re-auth)
    //      BUT we can detect early and alert before users hit errors
    // ─────────────────────────────────────────────────────────────────────────



    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private async findChannelOrThrow(channelId: string) {
        const channel: any = await this.prisma.channel.findUnique({
            where: { id: channelId },
        });
        if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
        if (!channel.credentials?.accessToken) throw new UnauthorizedException(`Channel ${channelId} has no access token. Please reconnect.`);
        return channel;
    }

    private async exchangeCodeForUserToken(code: string, redirectUri: string): Promise<string> {
        const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
            params: {
                client_id: process.env.MESSENGER_APP_ID!,
                client_secret: process.env.MESSENGER_APP_SECRET!,
                redirect_uri: redirectUri,
                code,
            },
        });
        return data.access_token;
    }

    private async exchangeLongLivedUserToken(shortLivedToken: string): Promise<string> {
        const { data } = await axios.get(`${FB_BASE}/oauth/access_token`, {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: process.env.MESSENGER_APP_ID!,
                client_secret: process.env.MESSENGER_APP_SECRET!,
                fb_exchange_token: shortLivedToken,
            },
        });
        return data.access_token;
    }

    private async getUserPages(userToken: string): Promise<any[]> {
        // /me/accounts returns pages with their never-expiring page tokens directly
        const { data } = await axios.get(`${FB_BASE}/me/accounts`, {
            params: {
                fields: 'id,name,access_token,category,tasks',
                access_token: userToken,
            },
        });
        this.logger.debug(`user Pages  found: ${JSON.stringify(data)}`)

        return data.data ?? [];
    }

    private async getPageInfo(pageId: string, pageToken: string): Promise<any> {
        try {
            const { data } = await axios.get(`${FB_BASE}/${pageId}`, {
                params: {
                    fields: 'id,name,picture,category',
                    access_token: pageToken,
                },
            });
            this.logger.debug(`Page Info found: ${JSON.stringify(data)}`)
            return data;
        } catch {
            return null;
        }
    }

    private async subscribePageToWebhook(pageId: string, pageToken: string): Promise<void> {
        await axios.post(
            `${FB_BASE}/${pageId}/subscribed_apps`,
            {
                subscribed_fields: [
                    'messages',
                    'messaging_postbacks',
                    'messaging_optins',
                    'message_deliveries',
                    'message_reads',
                    'messaging_referrals',
                ],
            },
            { params: { access_token: pageToken } },
        );
        this.logger.log(`Page ${pageId} subscribed to webhook`);
    }


}