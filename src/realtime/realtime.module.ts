import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { WidgetGateway } from './widget.gateway';
import { AuthModule } from 'src/modules/auth/auth.module';

@Module({
    imports: [AuthModule],
    providers: [RealtimeGateway, RealtimeService, WidgetGateway],
    exports: [RealtimeService,RealtimeGateway,WidgetGateway], // 👈 important
})
export class RealtimeModule { }
