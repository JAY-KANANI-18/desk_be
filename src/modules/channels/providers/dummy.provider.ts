// import { ChannelProvider, OutboundPayload, ParsedInbound } from '../channel-provider.interface';

// export class DummyProvider implements ChannelProvider {
//     type = 'dummy';

//     async send(payload: OutboundPayload) {
//         console.log('Sending via DummyProvider:', payload);

//         return {
//             externalId: 'dummy_' + Date.now(),
//         };
//     }

//     async parseWebhook(payload: any): Promise<ParsedInbound> {
//         return {
//             workspaceId: 'dummy',
//             channelId: 'dummy',
//             contactIdentifier: 'dummy',
//             text: 'dummy',
//             raw: payload,
//         };
//     }
// }