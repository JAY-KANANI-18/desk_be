import { Controller, Param, Put, Req, UseGuards } from "@nestjs/common";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { WorkspaceGuard } from "../../common/guards/workspace.guard";
import { PrismaService } from "../../prisma/prisma.service";
import { Get, Query } from "@nestjs/common";
import { Post, Body } from "@nestjs/common";
import { ChannelService } from "./channel.service";
import { SendMessageDto } from "./dto/send-message.dto";


@Controller('api/channels')
@UseGuards(JwtGuard, WorkspaceGuard)
export class ChannelsController {
    constructor(private prisma: PrismaService,
        private channelService: ChannelService) { }
    @Get('whatsapp/oauth')
    async startOAuth(@Query('workspaceId') workspaceId: string) {
        const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}
    &redirect_uri=${process.env.META_REDIRECT_URI}
    &scope=whatsapp_business_management,whatsapp_business_messaging
    &state=${workspaceId}`;

        return { url };
    }


    @Get('whatsapp/oauth/callback')
    async handleCallback(
        @Query('code') code: string,
        @Query('state') workspaceId: string,
    ) {
        const channel =
            await this.channelService.connectWhatsAppOAuth(code, workspaceId);

        return {
            success: true,
            channelId: channel.id,
        };
    }

    @Post('whatsapp/connect-manual')
    async connectManual(@Body() dto: {
        workspaceId: string;
        phoneNumberId: string;
        wabaId: string;
        accessToken: string;
    }, @Req() req: any) {
        const workspaceId = req.headers['x-workspace-id'] as string;

        return this.prisma.channel.create({
            data: {
                workspaceId: workspaceId,
                type: 'whatsapp',
                name: 'WhatsApp',
                identifier: dto.phoneNumberId,
                config: {
                    accessToken: dto.accessToken,
                    wabaId: dto.wabaId,
                },
                status: 'connected',
            },
        });
    }

    @Put('whatsapp/:channelId')
    async UpdateWhatsAppChannel(@Param('channelId') channelId: string, @Body() dto: {
        accessToken: string;
        phoneNumberId: string;
        wabaId: string;
    }) {

        return this.prisma.channel.update({

            where: { id: channelId },
            data: {

                config: {

                    accessToken: dto.accessToken,
                    phoneNumber: dto.phoneNumberId,
                    "waba_account_name": '',
                    wabaId: dto.wabaId,
                    qaulityRating: '',


                    messagingLimitTier: '',
                    verifiedName: '',
                    allowedMessageTypes: [],
                    templates: {},
                    webhookUrl: '',
                    webhookStatus: '',
                    subscribedEvents: [],
                    veriytoken: '',
                    graphApiVersion: '',
                    metaappname: '',
                    systemUserName: '',
                    tokenExpiry: '',
                    conversationwindow: '24h',
                    lastIncomingMessageAt: new Date(),
                    lastOutgoingMessageAt: new Date(),
                    lastError: "",


                },
            },
        });
    }
    @Put('instagram/:channelId')
    async UpdateInstagramChannel(@Param('channelId') channelId: string, @Body() dto: {
        accessToken: string;
    }) {

        return this.prisma.channel.update({
            where: { id: channelId },
            data: {

                config: {

                    connectionStatus: 'connected',
                    accessToken: dto.accessToken,
                    pageId: '',
                    pageName: '',
                    instagramId: '',
                    instagramUsername: '',
                    accountType: '',
                    followersCount: 0,
                    followingCount: 0,
                    mediaCount: 0,
                    allowedMessageTypes: [],
                    webhookUrl: '',
                    webhookStatus: '',
                    subscribedEvents: [],
                    veriytoken: '',
                    graphApiVersion: '',
                    metaappname: '',
                    systemUserName: '',
                    tokenExpiry: '',
                    insta_business_account_id: '',

                    conversationwindow: '24h',
                    recievedMessage: true,
                    reciveStoryReplies: true,
                    recievepostreplies: true,
                    auto_create_contact_from_dm: true,

                    lastIncomingMessageAt: new Date(),
                    lastOutgoingMessageAt: new Date(),
                    lastError: "",

                },
            },
        });
    }
    @Put('messenger/:channelId')
    async UpdateMessengerChannel(@Param('channelId') channelId: string, @Body() dto: {
        accessToken: string;
    }) {

        return this.prisma.channel.update({
            where: { id: channelId },
            data: {

                config: {

                    connectionStatus: 'connected',
                    accessToken: dto.accessToken,

                    facebookPageId: '',
                    facebookPageName: '',
                    pageusername: '',

                    followersCount: 0,
                    followingCount: 0,
                    likesCount: 0,
                    channelcreatedAt: new Date(),
                    allowedMessageTypes: [],
                    conversationWindow: '24h',



                    webhookUrl: '',
                    webhookStatus: '',
                    subscribedEvents: [],

                    veriytoken: '',
                    graphApiVersion: '',
                    metaappname: '',
                    systemUserName: '',
                    pageAccessToken: '',

                    tokenExpiry: '',
                    insta_business_account_id: '',



                    lastIncomingMessageAt: new Date(),
                    lastOutgoingMessageAt: new Date(),
                    lastError: "",

                },
            },
        });
    }
    @Put('email/:channelId')
    async UpdateEmailChannel(
        @Param('channelId') channelId: string,
        @Body() dto: {
            displayname: string
            emailaddress: string
            encryption: string
            imapEncryption: string
            imapFolder: string
            imapPassword: string
            imapUsername: string
            imapport: number
            imapserver: string
            password: string
            smtpport: number
            smtpserver: string
            userId: string
        },
    ) {

        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
        });

        const existingConfig: any = channel?.config || {};

        return this.prisma.channel.update({
            where: { id: channelId },
            data: {
                config: {
                    ...existingConfig,

                    displayname: dto.displayname,
                    emailaddress: dto.emailaddress,

                    userId: dto.userId,
                    password: dto.password,

                    imapserver: dto.imapserver,
                    imapport: dto.imapport,
                    imapUsername: dto.imapUsername,
                    imapPassword: dto.imapPassword,
                    imapEncryption: dto.imapEncryption,
                    imapFolder: dto.imapFolder,

                    smtpserver: dto.smtpserver,
                    smtpport: dto.smtpport,
                    encryption: dto.encryption,

                    connectionStatus: 'connected',
                    updatedAt: new Date(),
                },
            },
        });
    }



    @Get('instagram/oauth')
    async startInstagramOAuth(@Query('workspaceId') workspaceId: string) {

        const state = JSON.stringify({
            workspaceId,
            type: 'instagram',
        });

        const url =
            `https://www.facebook.com/v19.0/dialog/oauth` +
            `?client_id=${process.env.META_APP_ID}` +
            `&redirect_uri=${process.env.META_REDIRECT_URI}` +
            `&scope=pages_show_list,pages_messaging,instagram_basic,instagram_manage_messages` +
            `&state=${encodeURIComponent(state)}`;

        return { url };
    }


    @Get('instagram/oauth/callback')
    async handleInstagramCallback(
        @Query('code') code: string,
        @Query('state') workspaceId: string,
    ) {
        const channel =
            await this.channelService.connectInstagramOAuth(code, workspaceId);

        return {
            success: true,
            channelId: channel.id,
        };
    }



    @Get('messenger/oauth')
    async startMessengerOAuth(@Query('workspaceId') workspaceId: string) {

        const state = JSON.stringify({
            workspaceId,
            type: 'messenger',
        });

        const url =
            `https://www.facebook.com/v19.0/dialog/oauth` +
            `?client_id=${process.env.META_APP_ID}` +
            `&redirect_uri=${process.env.META_REDIRECT_URI}` +
            `&scope=pages_show_list,pages_messaging` +
            `&state=${encodeURIComponent(state)}`;

        return { url };
    }
    @Get('messenger/oauth/callback')
    async handleMessengerCallback(
        @Query('code') code: string,
        @Query('state') workspaceId: string,
    ) {
        const channel =
            await this.channelService.connectMessengerOAuth(code, workspaceId);

        return {
            success: true,
            channelId: channel.id,
        };
    }

    // @Post('whatsapp/:channelId/sync-templates')
    // async syncTemplates(@Param('channelId') channelId: string) {
    //     return this.channelService.syncWhatsAppTemplates(channelId);
    // }

    @Get('whatsapp/:workspaceId/templates')
    async listTemplates(@Param('workspaceId') workspaceId: string) {
        return this.prisma.whatsAppTemplate.findMany({
            where: { workspaceId, status: 'APPROVED' },
        });
    }

    @Get('email/gmail/oauth')
    async startGmailOAuth(@Query('workspaceId') workspaceId: string) {

        const state = JSON.stringify({
            workspaceId,
            type: 'gmail',
        });

        const url =
            `https://accounts.google.com/o/oauth2/v2/auth` +
            `?client_id=${process.env.GOOGLE_CLIENT_ID}` +
            `&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}` +
            `&response_type=code` +
            `&scope=https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email` +
            `&access_type=offline` +
            `&prompt=consent` +
            `&state=${encodeURIComponent(state)}`;

        return { url };
    }

    // @Get('email/gmail/oauth')
    // async startGmailOAuth(@Query('workspaceId') workspaceId: string) {

    //     const state = JSON.stringify({
    //         workspaceId,
    //         type: 'gmail',
    //     });

    //     const url =
    //         `https://accounts.google.com/o/oauth2/v2/auth` +
    //         `?client_id=${process.env.GOOGLE_CLIENT_ID}` +
    //         `&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}` +
    //         `&response_type=code` +
    //         `&scope=https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email` +
    //         `&access_type=offline` +
    //         `&prompt=consent` +
    //         `&state=${encodeURIComponent(state)}`;

    //     return { url };
    // }
    @Post('email/smtp/connect')
    async connectSMTP(@Body() dto: {
        workspaceId: string;
        smtpHost: string;
        smtpPort: number;
        smtpUser: string;
        smtpPass: string;
        fromEmail: string;
    }) {
        return this.channelService.connectSMTPEmail(dto);
    }

    @Get()
    async getChannels(@Req() req: any) {
        const workspaceId = req.headers['x-workspace-id'] as string;
        return this.channelService.getChannels(workspaceId);
    }

    // @Post("message")
    // async sendMessage(@Body() dto: any, @Req() req) {
    //     console.log({ dto });

    //     return this.channelService.sendMessage({
    //         ...dto,
    //         metadata :{sender:{ userId : req.user.id , type : 'user' }},
    //         // authorId: req.user.id,
    //     });
    // }

    // {
    //   "payload": {
    //     "workspaceId": "workspace_uuid",
    //     "conversationId": "conversation_uuid",
    //     "channelId": "channel_uuid",
    //     "type": "text",
    //     "text": "Hello how can I help you?",
    //     "attachments": [],
    //     "metadata": {}
    //   }
    // }

}