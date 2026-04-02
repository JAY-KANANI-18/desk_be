import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { WidgetGateway } from './widget.gateway';

@Module({
    providers: [RealtimeGateway, RealtimeService, WidgetGateway],
    exports: [RealtimeService,RealtimeGateway,WidgetGateway], // 👈 important
})
export class RealtimeModule { }