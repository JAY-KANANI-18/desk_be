
// import { Injectable } from "@nestjs/common";
// import { PrismaService } from "prisma/prisma.service";
// import { ChannelProvider, OutboundPayload } from "../channel-provider.interface";
// import nodemailer from 'nodemailer';

// @Injectable()
// export class EmailProvider implements ChannelProvider {

//     type = 'email';

//     constructor(private prisma: PrismaService) { }

//     async send(payload: OutboundPayload) {

//         const channel = await this.prisma.channel.findUnique({
//             where: { id: payload.channelId },
//         });

//         const config = channel!.config as any;

//         if (config.provider === 'gmail') {
//             return this.sendViaGmail(config, payload);
//         }

//         if (config.provider === 'smtp') {
//             return this.sendViaSMTP(config, payload);
//         }

//         throw new Error('Unsupported email provider');
//     }
//     async sendViaGmail(config, payload) {

//         const raw = Buffer.from(
//             `From: ${config.fromEmail}
//       To: ${payload.to}
//       Subject: ${payload.text?.slice(0, 100)}
//       Reply-To: ${config.fromEmail}
      
//       ${payload.text}`
//         ).toString('base64');

//         await fetch(
//             `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
//             {
//                 method: 'POST',
//                 headers: {
//                     Authorization: `Bearer ${config.accessToken}`,
//                     'Content-Type': 'application/json',
//                 },
//                 body: JSON.stringify({ raw }),
//             }
//         );

//         return { externalId: 'gmail-id' };
//     }
//     async sendViaSMTP(config, payload) {

//         const transporter = nodemailer.createTransport({
//             host: config.smtpHost,
//             port: config.smtpPort,
//             secure: false,
//             auth: {
//                 user: config.smtpUser,
//                 pass: config.smtpPass,
//             },
//         });

//         const info = await transporter.sendMail({
//             from: config.fromEmail,
//             to: payload.to,
//             subject: payload.text?.slice(0, 100),
//             text: payload.text,
//             replyTo: config.fromEmail, //channel.identifier
//         });

//         return { externalId: info.messageId };
//     }
//     async parseWebhook(payload: any) {
//         return {
//             channelId: payload.channelId,
//             workspaceId: payload.workspaceId,
//             contactIdentifier: payload.contactIdentifier,
//             text: payload.text,
//             attachments: payload.attachments,
//             raw: payload,
//         };
//     }
//     async onModuleInit() {
//         throw new Error('Method not implemented.');
//     }
// }