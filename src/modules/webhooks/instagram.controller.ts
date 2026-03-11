// // instagram.controller.ts

// import {
//   Controller,
//   Get,
//   Post,
//   Query,
//   Headers,
//   Req,
//   Res,
// } from '@nestjs/common';
// import { Response } from 'express';
// import { ChannelRegistry } from '../channels/channel-registry.service';
// import { InboundService } from '../inbound/inbound.service';
// import { PrismaService } from 'prisma/prisma.service';
// import { verifyMetaSignature } from '../channels/utils/meta-signature.util';

// @Controller('webhooks/instagram')
// export class WebhookInstagramController {
//   constructor(
//     private registry: ChannelRegistry,
//     private inbound: InboundService,
//     private prisma: PrismaService,
//   ) {}

//   // 🔹 Webhook verification (Meta requirement)
//   @Get()
//   verify(
//     @Query('hub.mode') mode: string,
//     @Query('hub.challenge') challenge: string,
//     @Query('hub.verify_token') token: string,
//     @Res() res: Response,
//   ) {
//     if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
//       return res.status(200).send(challenge);
//     }

//     return res.sendStatus(403);
//   }

//   // 🔹 Incoming Instagram messages
//   @Post()
//   async handle(
//     @Req() req: any,
//     @Headers('x-hub-signature-256') signature: string,
//   ) {

//     const isValid = verifyMetaSignature(
//       req.rawBody,
//       signature,
//       process.env.META_APP_SECRET!,
//     );

//     if (!isValid) {
//       return { status: 'invalid_signature' };
//     }

//     const body = req.body;
//     console.dir({ body }, { depth: null });

//     if (body.object !== 'instagram') {
//       return { status: 'ignored' };
//     }

//     const igBusinessId = body.entry?.[0]?.id;

//     if (!igBusinessId) return { status: 'ignored' };

//     // 🔎 find connected channel
//     const channel = await this.prisma.channel.findFirst({
//       where: {
//         type: 'instagram',
//         identifier: igBusinessId,
//       },
//     });

//     if (!channel) return { status: 'channel_not_found' };

//     const provider = this.registry.getProviderByType(channel.type);

//     const parsed = await provider.parseWebhook(body);

//     await this.inbound.process({
//       ...parsed,
//       channelId: channel.id,
//       workspaceId: channel.workspaceId,
//     });

//     return { status: 'ok' };
//   }
// }