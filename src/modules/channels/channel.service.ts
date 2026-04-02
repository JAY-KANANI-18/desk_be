import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { validateTemplateVariables, buildTemplateComponents, extractTemplateVariables } from './utils/template-validator';
import { SendMessageDto } from './dto/send-message.dto';


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

    async exchangeCode(code: string) {
        const res = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token
           ?client_id=${process.env.META_APP_ID}
           &redirect_uri=${process.env.META_REDIRECT_URI}
           &client_secret=${process.env.META_APP_SECRET}
           &code=${code}`
        );

        const data = await res.json();

        if (!data.access_token) {
            throw new Error('OAuth failed');
        }

        return data.access_token;
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

        const inboundEmail =
            `support-${workspaceId}@inbound.yourapp.com`;

        return this.prisma.channel.create({
            data: {
                workspaceId,
                type: 'email',
                name: 'Gmail',
                identifier: inboundEmail,
                status: 'connected',
                config: {
                    provider: 'gmail',
                    accessToken,
                    refreshToken,
                    fromEmail: user.email,
                },
            },
        });
    }

    async connectSMTPEmail(dto: any) {

        const inboundEmail =
            `support-${dto.workspaceId}@inbound.yourapp.com`;

        return this.prisma.channel.create({
            data: {
                workspaceId: dto.workspaceId,
                type: 'email',
                name: 'SMTP Email',
                identifier: inboundEmail,
                status: 'connected',
                config: {
                    provider: 'smtp',
                    smtpHost: dto.smtpHost,
                    smtpPort: dto.smtpPort,
                    smtpUser: dto.smtpUser,
                    smtpPass: dto.smtpPass,
                    fromEmail: dto.fromEmail,
                },
            },
        });
    }

    async getChannels(workspaceId: string) {
        return this.prisma.channel.findMany({
            where: { workspaceId },
        });
    }
}