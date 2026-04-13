import { ImportExportJob } from '@prisma/client';
import { ImportExportHandlerResult, ImportExportProgressSnapshot } from '../import-export.types';

export interface ImportProgressReporter {
  update(snapshot: ImportExportProgressSnapshot): Promise<void>;
}

export interface ImportHandler {
  readonly entity: string;
  readonly type: string;
  run(job: ImportExportJob, reporter: ImportProgressReporter): Promise<ImportExportHandlerResult>;
}
