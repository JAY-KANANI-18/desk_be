import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { ContactExportHandler } from './handlers/contact-export.handler';
import { ContactImportHandler } from './handlers/contact-import.handler';
import { ImportExportController } from './import-export.controller';
import { ImportExportQueue } from './import-export.queue';
import { ImportExportRegistry } from './import-export.registry';
import { ImportExportService } from './import-export.service';
import { ImportExportWorker } from './import-export.worker';

@Module({
  imports: [PrismaModule, FilesModule, RealtimeModule, NotificationsModule],
  controllers: [ImportExportController],
  providers: [
    ImportExportQueue,
    ImportExportService,
    ImportExportRegistry,
    ContactImportHandler,
    ContactExportHandler,
    ImportExportWorker,
  ],
  exports: [ImportExportService],
})
export class ImportExportModule {}
