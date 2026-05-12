import { Module } from '@nestjs/common';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

@Module({
  controllers: [PlatformAdminController],
  providers: [PlatformAdminGuard, PlatformAdminService],
})
export class PlatformAdminModule {}
