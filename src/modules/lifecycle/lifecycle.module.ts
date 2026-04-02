import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';


@Module({
  imports: [PrismaModule],
  controllers: [LifecycleController],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}