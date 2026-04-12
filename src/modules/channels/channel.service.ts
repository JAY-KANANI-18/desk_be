import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { validateTemplateVariables, buildTemplateComponents, extractTemplateVariables } from './utils/template-validator';
import { SendMessageDto } from './dto/send-message.dto';
import * as nodemailer from 'nodemailer';


@Injectable()
export class ChannelService {
    constructor(private prisma: PrismaService,
        ) { }


// email sending example
//     async send(payload) {
//   return this.mailer.sendMail({
//     to: payload.to,
//     subject: "Message",
//     text: payload.text,
//     attachments: payload.attachments?.map(a => ({
//       path: a.url,
//     })),
//   });
// }


// Instagram sending example
// async send(payload) {
//   return this.instagramApi.sendMessage({
//     recipient: payload.to,
//     message: payload.text,
//   });
// }

// WhatsApp sending example
// async send(payload) {
//   if (payload.template) {
//     return this.api.sendTemplate(payload);
//   }

//   if (payload.attachments) {
//     return this.api.sendMedia(payload);
//   }

//   return this.api.sendText(payload);
// }

//  async sendMessage(params: SendMessageDto) {
//   const conversation = await this.prisma.conversation.findUnique({
//     where: { id: params.conversationId },
//     include: {
//       contact: true,
//     },
//   });

  


//   if (!conversation) {
//     throw new Error("Conversation not found");
//   }

//   const contact = conversation.contact;
//   const channel = await this.prisma.channel.findUnique({
//     where: { id: params.channelId },
//   });

//   if (!channel) {
//     throw new Error("Channel not found");
//   }

//   const provider = this.registry.getProviderByType(channel.type);

//   if (!provider) {
//     throw new Error(`Provider not found for ${channel.type}`);
//   }

//   /* ========================================
//      CREATE MESSAGE (pending)
//   ======================================== */

//   const message = await this.prisma.message.create({
//     data: {
//       workspaceId: conversation.workspaceId,
//       conversationId: conversation.id,
//       channelId: channel.id,
//       channelType: channel.type,

//       text: params.text,

//       direction: "outgoing",
//       type: "reply",

//       status: "pending",

//     //   authorId: params.authorId,

//       metadata: params.metadata,
//     },
//   });

//   /* ========================================
//      WHATSAPP TEMPLATE
//   ======================================== */

//   if (params.metadata?.template) {
//     const templateMeta = params.metadata.template;

//     const template = await this.prisma.whatsAppTemplate.findFirst({
//       where: {
//         workspaceId: conversation.workspaceId,
//         name: templateMeta.name,
//         language: templateMeta.language,
//         status: "APPROVED",
//       },
//     });

//     if (!template) {
//       throw new Error("Template not found or not approved");
//     }

//     validateTemplateVariables(
//       template.components as any[],
//       templateMeta.variables
//     );

//     const components = buildTemplateComponents(
//       template.components as any[],
//       templateMeta.variables
//     );
//     console.log({
//       channelId: channel.id,
//       conversationId: conversation.id,
//       to: contact.phone || contact.email ,//|| contact.externalId,

//       template: {
//         name: template.name,
//         language: { code: template.language },
//         components,
//       },
//     });
    

//     const result :any= await provider.send({
//       channelId: channel.id,
//       conversationId: conversation.id,
//       to: contact.phone || contact.email ,//|| contact.externalId,

//       template: {
//         name: template.name,
//         language: { code: template.language },
//         components,
//       },
//     });
// console.log({result});

//     await this.prisma.message.update({
//       where: { id: message.id },
//       data: {
//         status: "sent",
//         channelMsgId: result?.id,
//       },
//     });

//     return message;
//   }

//   /* ========================================
//      ATTACHMENTS
//   ======================================== */

//   let attachments;

//   if (params.attachments?.length) {
//     attachments = [];

//     for (const att of params.attachments) {
//       let mediaId = att.url;

//       if (provider.uploadMedia) {
//         mediaId = await provider.uploadMedia(channel, {
//           url: att.url,
//           mimeType: att.mimeType,
//         //   type: att.type,
//         });
//       }

//       attachments.push({
//         type: att.type,
//         url: mediaId,
//         mimeType: att.mimeType,
//       });
//     }
//   }

//   /* ========================================
//      SEND MESSAGE
//   ======================================== */

// console.log({
//     channelId: channel.id,
//     conversationId: conversation.id,
//     to: contact.phone || contact.email ,

//     text: params.text,
//     attachments,
//   });


//   const result:any = await provider.send({
//     channelId: channel.id,
//     conversationId: conversation.id,
//     to: contact.phone || contact.email ,

//     text: params.text,
//     attachments,
//   });

//   /* ========================================
//      UPDATE MESSAGE STATUS
//   ======================================== */

//   await this.prisma.message.update({
//     where: { id: message.id },
//     data: {
//       status: "sent",
//       channelMsgId: result?.id,
//     },
//   });

//   /* ========================================
//      UPDATE CONVERSATION
//   ======================================== */

//   await this.prisma.conversation.update({
//     where: { id: conversation.id },
//     data: {
//       lastMessageId: message.id,
//       lastMessageAt: new Date(),
//     },
//   });

//   return message;
// }
    async syncWhatsAppTemplates(channelId: string) {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
        });

        if (!channel) throw new Error('Channel not found');

        const config = channel.config as any;

        const response = await fetch(
            `https://graph.facebook.com/v19.0/${config.wabaId}/message_templates`,
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                },
            },
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(JSON.stringify(data));
        }

        const templates = data.data;

        // for (const template of templates) {
        //     await this.prisma.whatsAppTemplate.upsert({
        //         where: {
        //             workspaceId_name_language: {
        //                 workspaceId: channel.workspaceId,
        //                 name: template.name,
        //                 language: template.language,
        //             },
        //         },
        //         update: {
        //             category: template.category,
        //             status: template.status,
        //             components: template.components,
        //         },
        //         create: {
        //             workspaceId: channel.workspaceId,
        //             channelId: channel.id,
        //             name: template.name,
        //             language: template.language,
        //             category: template.category,
        //             status: template.status,
        //             components: template.components,
        //         },
        //     });
        // }

        return { success: true, count: templates.length };
    }



    async connectWhatsAppOAuth(code: string, workspaceId: string) {

        // 1️⃣ Exchange code for access token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token
          ?client_id=${process.env.META_APP_ID}
          &redirect_uri=${process.env.META_REDIRECT_URI}
          &client_secret=${process.env.META_APP_SECRET}
          &code=${code}`
        );

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            throw new Error('Failed to get access token');
        }

        const accessToken = tokenData.access_token;

        // 2️⃣ Get WABA accounts
        const wabaRes = await fetch(
            `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${accessToken}`
        );

        const wabaData = await wabaRes.json();

        const wabaId = wabaData.data?.[0]?.id;
        if (!wabaId) throw new Error('No WABA found');

        // 3️⃣ Get phone numbers
        const phoneRes = await fetch(
            `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers?access_token=${accessToken}`
        );

        const phoneData = await phoneRes.json();

        const phoneNumber = phoneData.data?.[0];

        if (!phoneNumber) throw new Error('No phone number found');

        const phoneNumberId = phoneNumber.id;

        // 4️⃣ Prevent duplicate
        const existing = await this.prisma.channel.findFirst({
            where: {
                workspaceId,
                type: 'whatsapp',
                identifier: phoneNumberId,
            },
        });

        if (existing) {
            return existing;
        }

        // 5️⃣ Create channel
        const channel = await this.prisma.channel.create({
            data: {
                workspaceId,
                type: 'whatsapp',
                name: `WhatsApp ${phoneNumber.display_phone_number}`,
                identifier: phoneNumberId,
                config: {
                    accessToken,
                    wabaId,
                },
                status: 'connected',
            },
        });

        await fetch(
            `https://graph.facebook.com/v19.0/${phoneNumberId}/subscribed_apps`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        return channel;
    }
    async connectInstagramOAuth(code: string, workspaceId: string) {

        const userToken = await this.exchangeCode(code);

        const pagesRes = await fetch(
            `https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`
        );

        const pages = (await pagesRes.json()).data;

        for (const page of pages) {

            const igRes = await fetch(
                `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
            );

            const igData = await igRes.json();

            if (igData.instagram_business_account) {

                return this.createChannel({
                    workspaceId,
                    type: 'instagram',
                    identifier: page.id,
                    name: `Instagram - ${page.name}`,
                    config: {
                        pageAccessToken: page.access_token,
                    },
                });
            }
        }

        throw new Error('No Instagram business account linked');
    }

    async connectMessengerOAuth(code: string, workspaceId: string) {

        const userToken = await this.exchangeCode(code);

        const pagesRes = await fetch(
            `https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`
        );

        const pages = (await pagesRes.json()).data;

        const page = pages[0];

        return this.createChannel({
            workspaceId,
            type: 'messenger',
            identifier: page.id,
            name: `Messenger - ${page.name}`,
            config: {
                pageAccessToken: page.access_token,
            },
        });
    }

    async exchangeCode(code: string, redirectUri?: string) {
        const uri = redirectUri || process.env.META_REDIRECT_URI;
        if (!uri) {
            throw new Error('META_REDIRECT_URI or META_ADS_REDIRECT_URI is not configured');
        }
        const q = new URLSearchParams({
            client_id: process.env.META_APP_ID || '',
            redirect_uri: uri,
            client_secret: process.env.META_APP_SECRET || '',
            code,
        });
        const res = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?${q.toString()}`,
        );

        const data = await res.json();

        if (!data.access_token) {
            throw new Error(data?.error?.message || 'OAuth failed');
        }

        return data.access_token as string;
    }

    /** Meta Ads (Marketing API) — one hidden channel row per workspace for webhooks & inbox routing; excluded from channel picker APIs. */
    async connectMetaAdsOAuthCode(code: string, workspaceId: string) {
        const redirectUri = process.env.META_ADS_REDIRECT_URI || process.env.META_REDIRECT_URI;
        const userToken = await this.exchangeCode(code, redirectUri);

        const adsRes = await fetch(
            `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id,account_status,currency&access_token=${userToken}`,
        );
        const adsJson = await adsRes.json();
        const acct = adsJson.data?.[0];
        if (!acct) {
            throw new Error(
                'No ad accounts found. Ensure this Facebook user has access to an ad account and that ads_read is granted.',
            );
        }

        let campaignCount: number | undefined;
        try {
            const cRes = await fetch(
                `https://graph.facebook.com/v19.0/${acct.id}/campaigns?fields=id&limit=1&summary=true&access_token=${userToken}`,
            );
            const cJson = await cRes.json();
            campaignCount = cJson.summary?.total_count;
        } catch {
            campaignCount = undefined;
        }

        const credentials = { accessToken: userToken };
        const config = {
            accountId: acct.id,
            accountName: acct.name,
            accountStatus: acct.account_status,
            currency: acct.currency,
            campaignCount,
            provider: 'meta_ads',
        };

        const existing = await this.prisma.channel.findFirst({
            where: { workspaceId, type: 'meta_ads' },
        });

        if (existing) {
            const prev = (existing.config || {}) as Record<string, unknown>;
            return this.prisma.channel.update({
                where: { id: existing.id },
                data: {
                    identifier: acct.id,
                    name: `Meta Ads — ${acct.name}`,
                    credentials,
                    config: { ...prev, ...config },
                    status: 'connected',
                },
            });
        }

        return this.prisma.channel.create({
            data: {
                workspaceId,
                type: 'meta_ads',
                name: `Meta Ads — ${acct.name}`,
                identifier: acct.id,
                status: 'connected',
                credentials,
                config,
            },
        });
    }

    async createChannel(data: {
        workspaceId: string;
        type: string;
        identifier: string;
        name: string;
        config: any;
    }) {

        const existing = await this.prisma.channel.findFirst({
            where: {
                workspaceId: data.workspaceId,
                type: data.type,
                identifier: data.identifier,
            },
        });

        if (existing) return existing;

        return this.prisma.channel.create({
            data: {
                ...data,
                status: 'connected',
            },
        });
    }


    async connectWhatsAppManual(dto: any) {

        const existing = await this.prisma.channel.findFirst({
            where: {
                workspaceId: dto.workspaceId,
                type: 'whatsapp',
                identifier: dto.phoneNumberId,
            },
        });

        if (existing) return existing;

        const channel = await this.prisma.channel.create({
            data: {
                workspaceId: dto.workspaceId,
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

        await fetch(
            `https://graph.facebook.com/v19.0/${dto.phoneNumberId}/subscribed_apps`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${dto.accessToken}`,
                },
            }
        );

        return channel;
    }

    async connectGmailEmail(code: string, workspaceId: string) {

        const tokenRes = await fetch(
            `https://oauth2.googleapis.com/token`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code,
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
                    grant_type: 'authorization_code',
                }),
            }
        );

        const tokenData = await tokenRes.json();

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        const userRes = await fetch(
            `https://www.googleapis.com/oauth2/v2/userinfo`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        const user = await userRes.json();

        return this.prisma.channel.create({
            data: {
                workspaceId,
                type: 'email',
                name: 'Gmail',
                identifier: user.email,
                status: 'connected',
                config: {
                    provider: 'gmail',
                    accessToken,
                    refreshToken,
                    fromEmail: user.email,
                    emailaddress: user.email,
                    userId: user.email,
                    forwardingEmail: `support-${workspaceId}@inbound.yourapp.com`,
                    forwardingConfirmed: false,
                },
            },
        });
    }

    async connectSMTPEmail(dto: any) {

        const inboundEmail =
            `support-${dto.workspaceId}@inbound.yourapp.com`;

        const emailAddress = dto.emailaddress ?? dto.fromEmail ?? dto.smtpUser ?? dto.userId ?? '';
        const displayName = dto.displayname ?? dto.fromName ?? dto.name ?? emailAddress;
        const smtpServer = dto.smtpserver ?? dto.smtpHost ?? '';
        const smtpPort = Number(dto.smtpport ?? dto.smtpPort ?? 587);
        const username = dto.userId ?? dto.smtpUser ?? emailAddress;
        const password = dto.password ?? dto.smtpPass ?? '';
        const encryption = dto.encryption ?? 'STARTTLS';

        return this.prisma.channel.create({
            data: {
                workspaceId: dto.workspaceId,
                type: 'email',
                name: dto.name || displayName || 'SMTP Email',
                identifier: username,
                status: 'connected',
                config: {
                    provider: 'smtp',
                    smtpHost: smtpServer,
                    smtpPort,
                    smtpUser: username,
                    smtpPass: password,
                    fromEmail: emailAddress,
                    fromName: displayName,
                    smtpserver: smtpServer,
                    smtpport: smtpPort,
                    userId: username,
                    password,
                    emailaddress: emailAddress,
                    displayname: displayName,
                    encryption,
                    forwardingEmail: inboundEmail,
                    forwardingConfirmed: Boolean(dto.forwardingConfirmed),
                    signatureHtml: dto.signatureHtml ?? '<p>Regards,<br />{{agent_name}}</p>',
                    signatureEnabled: dto.signatureEnabled !== false,
                },
            },
        });
    }

    async testSMTPConnection(channelId: string) {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
        });

        if (!channel) {
            return { success: false, error: 'Channel not found' };
        }

        const config: any = channel.config ?? {};
        const host = config.smtpserver ?? config.smtpHost;
        const port = Number(config.smtpport ?? config.smtpPort ?? 587);
        const user = config.userId ?? config.smtpUser ?? config.emailaddress;
        const pass = config.password ?? config.smtpPass;

        if (!host || !port || !user || !pass) {
            return { success: false, error: 'SMTP credentials are incomplete' };
        }

        try {
            const transporter = nodemailer.createTransport({
                host,
                port,
                secure: String(config.encryption ?? '').toLowerCase() === 'ssl/tls',
                auth: { user, pass },
            });
            await transporter.verify();
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error?.message ?? 'SMTP verification failed' };
        }
    }

    async getChannels(workspaceId: string) {
        return this.prisma.channel.findMany({
            where: {
                workspaceId,
                type: { not: 'meta_ads' },
            },
        });
    }
    async deleteChannels(workspaceId: string,channelId:string){
        return await this.prisma.channel.delete({
            where:{
                workspaceId,
                id:channelId
            }
        })
    }
}
