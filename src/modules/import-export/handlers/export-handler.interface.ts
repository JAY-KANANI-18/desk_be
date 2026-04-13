import { ImportExportJob } from '@prisma/client';
import { ImportExportHandlerResult, ImportExportProgressSnapshot } from '../import-export.types';

export interface ExportProgressReporter {
  update(snapshot: ImportExportProgressSnapshot): Promise<void>;
}

export interface ExportHandler {
  readonly entity: string;
  readonly type: string;
  run(job: ImportExportJob, reporter: ExportProgressReporter): Promise<ImportExportHandlerResult>;
}
