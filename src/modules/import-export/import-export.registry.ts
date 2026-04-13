import { BadRequestException, Injectable } from '@nestjs/common';
import { CONTACT_EXPORT_TYPE, CONTACT_IMPORT_TYPE } from './import-export.types';
import { ContactExportHandler } from './handlers/contact-export.handler';
import { ContactImportHandler } from './handlers/contact-import.handler';
import { ExportHandler } from './handlers/export-handler.interface';
import { ImportHandler } from './handlers/import-handler.interface';

@Injectable()
export class ImportExportRegistry {
  constructor(
    private readonly contactImportHandler: ContactImportHandler,
    private readonly contactExportHandler: ContactExportHandler,
  ) {}

  getImportHandler(entity: string, type: string): ImportHandler {
    if (entity === 'contact' && type === CONTACT_IMPORT_TYPE) {
      return this.contactImportHandler;
    }

    throw new BadRequestException(`No import handler registered for ${entity}/${type}`);
  }

  getExportHandler(entity: string, type: string): ExportHandler {
    if (entity === 'contact' && type === CONTACT_EXPORT_TYPE) {
      return this.contactExportHandler;
    }

    throw new BadRequestException(`No export handler registered for ${entity}/${type}`);
  }
}
