import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SnippetsController } from './snippets.controller';
import { SnippetsService } from './snippets.service';

@Module({
  imports: [PrismaModule],
  controllers: [SnippetsController],
  providers: [SnippetsService],
  exports: [SnippetsService],
})
export class SnippetsModule {}
