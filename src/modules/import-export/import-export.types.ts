export const CONTACT_IMPORT_TYPE = 'CONTACT_IMPORT';
export const CONTACT_EXPORT_TYPE = 'CONTACT_EXPORT';

export const IMPORT_EXPORT_EVENT = 'import-export:job.updated';

export type ImportExportProgressSnapshot = {
  totalRecords?: number;
  processedRecords?: number;
  successCount?: number;
  failureCount?: number;
  status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  resultUrl?: string | null;
  errorLog?: unknown;
};

export type ImportExportHandlerResult = {
  totalRecords: number;
  processedRecords: number;
  successCount: number;
  failureCount: number;
  resultUrl?: string | null;
  errorLog?: unknown;
};
