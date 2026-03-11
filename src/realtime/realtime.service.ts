import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

@Injectable()
export class RealtimeService {
    constructor(private gateway: RealtimeGateway) { }

    emitToWorkspace(workspaceId: string, event: string, payload: any) {
        this.gateway.server
            .to(`workspace:${workspaceId}`)
            .emit(event, payload);
    }
}