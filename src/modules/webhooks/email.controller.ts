
// import { Controller, Post } from "@nestjs/common";
// import { PrismaService } from "prisma/prisma.service";
// import { Body } from "@nestjs/common";
// import { InboundService } from "../inbound/inbound.service";

// @Controller('webhooks/email')
// export class EmailWebhookController {

//     constructor(
//         private prisma: PrismaService,
//         private inbound: InboundService,
//     ) { }

//     @Post()
//     async handle(@Body() body: any) {

//         const to = body.to;       // inbound email address
//         const from = body.from;
//         const subject = body.subject;
//         const text = body.text;
//         const messageId = body.headers?.['message-id'];
//         const inReplyTo = body.headers?.['in-reply-to'];

//         const channel = await this.prisma.channel.findFirst({
//             where: {
//                 type: 'email',
//                 identifier: to,
//             },
//         });

//         if (!channel) return { status: 'ignored' };

//         await this.inbound.process({
//             channelId: channel.id,
//             workspaceId: channel.workspaceId,
//             contactIdentifier: from,
//             text: text || subject,
//             metadata: {
//                 messageId,
//                 inReplyTo,
//             },
//             raw: body,
//         });

//         return { status: 'ok' };
//     }
// }