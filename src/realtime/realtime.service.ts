import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { toJsonSafe } from '../common/utils/json-safe';

@Injectable()
export class RealtimeService {
    constructor(private gateway: RealtimeGateway) { }

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
