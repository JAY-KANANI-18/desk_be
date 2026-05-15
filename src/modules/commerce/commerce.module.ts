import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommerceService } from './commerce.service';

@Module({
  imports: [PrismaModule],
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
