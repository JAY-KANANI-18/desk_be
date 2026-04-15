import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { toJsonSafe } from '../common/utils/json-safe';

@Injectable()
export class RealtimeService {
    constructor(private gateway: RealtimeGateway) { }

   async hasUserConnection(userId: string) {
  const sockets =  await this.gateway.server
    .in(`user:${userId}`)
    .fetchSockets();

  return sockets.length > 0;
}

    emitToUser(userId: string, event: string, payload: any) {
        this.gateway.server
            .to(`user:${userId}`)
            .emit(event, toJsonSafe(payload));
    }

    emitToWorkspace(workspaceId: string, event: string, payload: any) {
        this.gateway.server
            .to(`workspace:${workspaceId}`)
            .emit(event, toJsonSafe(payload));
    }
}
