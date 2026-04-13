import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { extname, join } from 'node:path';
import { once } from 'node:events';
import {
  ImportExportJob,
  ImportExportJobStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { R2Service } from '../../common/storage/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { WorkspaceRole } from '../../common/constants/permissions';
import { CreateExportJobDto } from './dto/create-export-job.dto';
import { CreateImportJobDto } from './dto/create-import-job.dto';
import { ListImportExportJobsDto } from './dto/list-import-export-jobs.dto';
import { PreviewImportDto } from './dto/preview-import.dto';
import { StartImportDto } from './dto/start-import.dto';
import {
  CONTACT_EXPORT_TYPE,
  CONTACT_IMPORT_TYPE,
  IMPORT_EXPORT_EVENT,
  ImportExportProgressSnapshot,
} from './import-export.types';
import { ImportExportQueue } from './import-export.queue';
import { ImportExportRegistry } from './import-export.registry';

type RequestUser = {
  id: string;
  email: string;
};

type PreviewImportResult = {
  total: number;
  new: number;
  update: number;
  errors: number;
  errorFileUrl?: string | null;
};

@Injectable()
export class ImportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ImportExportQueue,
    private readonly r2: R2Service,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly registry: ImportExportRegistry,
  ) {}

  async uploadImportFile(
    workspaceId: string,
    _user: RequestUser,
    file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    const maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('File size must be 20MB or smaller.');
    }

    const format = this.resolveImportFormat(file.originalname);
    const sample = await this.extractImportSample(file.buffer, file.originalname, format);
    const safeName = this.sanitizeFileName(file.originalname || 'import.csv');
    const key = `files/imports/workspace/${workspaceId}/${Date.now()}-${safeName}`;
    const uploaded = await this.r2.uploadBuffer(key, file.buffer, file.mimetype || 'application/octet-stream');

    return {
      fileId: uploaded.url,
      headers: sample.headers,
      sampleRows: sample.sampleRows,
      rowCountEstimate: sample.rowCountEstimate,
      fileName: safeName,
      size: file.size,
    };
  }

  async previewImport(workspaceId: string, dto: PreviewImportDto) {
    this.validatePreviewOrStartInput(dto.mapping, dto.matchBy);

    const preview = await this.computeImportPreview(workspaceId, dto.fileId, {
      mapping: dto.mapping,
      matchBy: dto.matchBy ?? 'phone',
      importMode: dto.importMode ?? 'upsert',
    });

    return preview;
  }

  async startImportJob(workspaceId: string, user: RequestUser, dto: StartImportDto) {
    this.validatePreviewOrStartInput(dto.mapping, dto.matchBy);

    const idempotencyKey = createHash('sha256')
      .update(JSON.stringify({
        fileId: dto.fileId,
        mapping: dto.mapping,
        matchBy: dto.matchBy ?? 'phone',
        importMode: dto.importMode ?? 'upsert',
        tags: dto.tags ?? [],
        autoGenerateBatchTag: Boolean(dto.autoGenerateBatchTag),
      }))
      .digest('hex');

    const existingJobs = await this.prisma.importExportJob.findMany({
      where: {
        tenantId: workspaceId,
        createdBy: user.id,
        entity: 'contact',
        type: CONTACT_IMPORT_TYPE,
        status: {
          in: [ImportExportJobStatus.PENDING, ImportExportJobStatus.PROCESSING],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    const duplicate = existingJobs.find((job) => {
      const metadata = this.asObject(job.metadata);
      return metadata.idempotencyKey === idempotencyKey;
    });

    if (duplicate) {
      return { jobId: duplicate.id, duplicated: true };
    }

    const tagIds = Array.isArray(dto.tags) ? dto.tags.filter(Boolean) : [];
    let batchTagId: string | null = null;
    let batchTagName: string | null = null;

    if (dto.autoGenerateBatchTag) {
      batchTagName = `imported_${this.formatBatchTagSuffix(new Date())}`;
      const tag = await this.prisma.tag.upsert({
        where: {
          workspaceId_name: {
            workspaceId,
            name: batchTagName,
          },
        },
        update: {},
        create: {
          workspaceId,
          name: batchTagName,
          color: 'tag-indigo',
          emoji: '⬆️',
          description: 'Auto-generated import batch tag',
        },
      });
      batchTagId = tag.id;
    }

    const job = await this.createImportJob(workspaceId, user, {
      entity: 'contact',
      fileUrl: dto.fileId,
      mapping: dto.mapping,
      metadata: {
        matchBy: dto.matchBy ?? 'phone',
        importMode: dto.importMode ?? 'upsert',
        tagIds: batchTagId ? [...tagIds, batchTagId] : tagIds,
        idempotencyKey,
        batchTagId,
        batchTagName,
      },
    });

    return {
      jobId: job.id,
      batchTagId,
      batchTagName,
    };
  }

  async createImportJob(
    workspaceId: string,
    user: RequestUser,
    dto: CreateImportJobDto,
    file?: Express.Multer.File,
  ) {
    const entity = this.normalizeEntity(dto.entity);
    const type = this.resolveImportType(entity);
    const resolvedFile = await this.resolveImportFile(workspaceId, dto, file);

    const existing = await this.prisma.importExportJob.findFirst({
      where: {
        tenantId: workspaceId,
        createdBy: user.id,
        entity,
        type,
        fileUrl: resolvedFile.fileUrl,
        status: {
          in: [ImportExportJobStatus.PENDING, ImportExportJobStatus.PROCESSING],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return this.toJobResponse(existing);
    }

    const job = await this.prisma.importExportJob.create({
      data: {
        tenantId: workspaceId,
        createdBy: user.id,
        entity,
        type,
        fileUrl: resolvedFile.fileUrl,
        metadata: this.toJsonValue({
          ...(dto.metadata ?? {}),
          mapping: dto.mapping ?? {},
          fileName: resolvedFile.fileName,
          contentType: resolvedFile.contentType,
          storageKey: resolvedFile.storageKey,
        }),
      },
    });

    await this.queue.add(job.id);
    await this.emitJobUpdate(job.id);
    return this.toJobResponse(job);
  }

  async createExportJob(workspaceId: string, user: RequestUser, dto: CreateExportJobDto) {
    const entity = this.normalizeEntity(dto.entity);
    const type = this.resolveExportType(entity);

    const job = await this.prisma.importExportJob.create({
      data: {
        tenantId: workspaceId,
        createdBy: user.id,
        entity,
        type,
        metadata: this.toJsonValue({
          ...(dto.metadata ?? {}),
          filters: dto.filters ?? {},
        }),
      },
    });

    await this.queue.add(job.id);
    await this.emitJobUpdate(job.id);
    return this.toJobResponse(job);
  }

  async listJobs(workspaceId: string, userId: string, workspaceRole: string, query: ListImportExportJobsDto) {
    const where: Prisma.ImportExportJobWhereInput = {
      tenantId: workspaceId,
      ...(this.canViewWorkspaceJobs(workspaceRole) ? {} : { createdBy: userId }),
      ...(query.entity ? { entity: this.normalizeEntity(query.entity) } : {}),
      ...(query.type ? { type: query.type.trim() } : {}),
      ...(query.status ? { status: query.status.trim() as ImportExportJobStatus } : {}),
    };

    const jobs = await this.prisma.importExportJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return jobs.map((job) => this.toJobResponse(job));
  }

  async getJob(workspaceId: string, userId: string, workspaceRole: string, jobId: string) {
    const job = await this.getAuthorizedJob(workspaceId, userId, workspaceRole, jobId);
    return this.toJobResponse(job);
  }

  async getDownload(workspaceId: string, userId: string, workspaceRole: string, jobId: string) {
    const job = await this.getAuthorizedJob(workspaceId, userId, workspaceRole, jobId);

    if (!job.resultUrl) {
      throw new BadRequestException('This job does not have a downloadable result yet.');
    }

    return {
      id: job.id,
      type: job.type,
      entity: job.entity,
      downloadUrl: job.resultUrl,
    };
  }

  async processJob(jobId: string) {
    const job = await this.prisma.importExportJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`Import/export job ${jobId} not found`);
    }

    await this.prisma.importExportJob.update({
      where: { id: jobId },
      data: {
        status: ImportExportJobStatus.PROCESSING,
      },
    });
    await this.emitJobUpdate(jobId);

    const reporter = {
      update: async (snapshot: ImportExportProgressSnapshot) => {
        await this.updateProgress(jobId, snapshot);
      },
    };

    try {
      const result = job.type.endsWith('_IMPORT')
        ? await this.registry.getImportHandler(job.entity, job.type).run(job, reporter)
        : await this.registry.getExportHandler(job.entity, job.type).run(job, reporter);

      await this.prisma.importExportJob.update({
        where: { id: jobId },
        data: {
          status: ImportExportJobStatus.COMPLETED,
          totalRecords: result.totalRecords,
          processedRecords: result.processedRecords,
          successCount: result.successCount,
          failureCount: result.failureCount,
          resultUrl: result.resultUrl ?? undefined,
          errorLog: (result.errorLog as Prisma.InputJsonValue | undefined) ?? undefined,
        },
      });

      await this.emitJobUpdate(jobId);
      await this.notifySuccess(jobId);
    } catch (error: any) {
      await this.prisma.importExportJob.update({
        where: { id: jobId },
        data: {
          status: ImportExportJobStatus.FAILED,
          errorLog: this.toJsonValueArray([
            {
              message: error?.message ?? 'Unknown import/export failure',
            },
          ]),
        },
      });

      await this.emitJobUpdate(jobId);
      await this.notifyFailure(jobId, error);
      throw error;
    }
  }

  async updateProgress(jobId: string, snapshot: ImportExportProgressSnapshot) {
    await this.prisma.importExportJob.update({
      where: { id: jobId },
      data: {
        ...(snapshot.status ? { status: snapshot.status as ImportExportJobStatus } : {}),
        ...(snapshot.totalRecords !== undefined ? { totalRecords: snapshot.totalRecords } : {}),
        ...(snapshot.processedRecords !== undefined ? { processedRecords: snapshot.processedRecords } : {}),
        ...(snapshot.successCount !== undefined ? { successCount: snapshot.successCount } : {}),
        ...(snapshot.failureCount !== undefined ? { failureCount: snapshot.failureCount } : {}),
        ...(snapshot.resultUrl !== undefined ? { resultUrl: snapshot.resultUrl } : {}),
        ...(snapshot.errorLog !== undefined
          ? { errorLog: snapshot.errorLog as Prisma.InputJsonValue }
          : {}),
      },
    });

    await this.emitJobUpdate(jobId);
  }

  private async getAuthorizedJob(
    workspaceId: string,
    userId: string,
    workspaceRole: string,
    jobId: string,
  ) {
    const job = await this.prisma.importExportJob.findUnique({
      where: { id: jobId },
    });

    if (!job || job.tenantId !== workspaceId) {
      throw new NotFoundException('Job not found');
    }

    if (!this.canViewWorkspaceJobs(workspaceRole) && job.createdBy !== userId) {
      throw new ForbiddenException('You do not have access to this job');
    }

    return job;
  }

  private canViewWorkspaceJobs(workspaceRole: string) {
    return workspaceRole === WorkspaceRole.OWNER || workspaceRole === WorkspaceRole.MANAGER;
  }

  private normalizeEntity(entity: string) {
    const value = entity?.trim().toLowerCase();
    if (!value) {
      throw new BadRequestException('entity is required');
    }

    return value;
  }

  private resolveImportType(entity: string) {
    if (entity === 'contact') return CONTACT_IMPORT_TYPE;
    throw new BadRequestException(`Import is not supported for ${entity}`);
  }

  private resolveExportType(entity: string) {
    if (entity === 'contact') return CONTACT_EXPORT_TYPE;
    throw new BadRequestException(`Export is not supported for ${entity}`);
  }

  private async resolveImportFile(
    workspaceId: string,
    dto: CreateImportJobDto,
    file?: Express.Multer.File,
  ) {
    if (file) {
      const safeName = this.sanitizeFileName(file.originalname || dto.fileName || 'import.csv');
      const key = `files/imports/workspace/${workspaceId}/${Date.now()}-${safeName}`;
      const uploaded = await this.r2.uploadBuffer(key, file.buffer, file.mimetype || 'application/octet-stream');
      return {
        fileUrl: uploaded.url,
        fileName: safeName,
        contentType: file.mimetype || dto.contentType || 'application/octet-stream',
        storageKey: uploaded.key,
      };
    }

    if (!dto.fileUrl) {
      throw new BadRequestException('Provide either file upload or fileUrl');
    }

    return {
      fileUrl: dto.fileUrl,
      fileName: dto.fileName ?? dto.fileUrl.split('/').pop() ?? 'import.csv',
      contentType: dto.contentType ?? 'application/octet-stream',
      storageKey: this.r2.resolveKey(dto.fileUrl),
    };
  }

  private validatePreviewOrStartInput(
    mapping: Record<string, string>,
    matchBy: 'phone' | 'email' = 'phone',
  ) {
    const normalizedTargets = Object.values(mapping ?? {})
      .map((value) => this.normalizeImportTarget(value))
      .filter(Boolean);

    if (!normalizedTargets.includes(matchBy)) {
      throw new BadRequestException(`Map at least one column to ${matchBy} before continuing.`);
    }

    const duplicates = normalizedTargets.filter((value, index) => normalizedTargets.indexOf(value) !== index);
    if (duplicates.length) {
      throw new BadRequestException(`Duplicate field mappings are not allowed: ${Array.from(new Set(duplicates)).join(', ')}`);
    }
  }

  private async computeImportPreview(
    workspaceId: string,
    fileId: string,
    options: {
      mapping: Record<string, string>;
      matchBy: 'phone' | 'email';
      importMode: 'create' | 'update' | 'upsert' | 'overwrite';
    },
  ): Promise<PreviewImportResult> {
    const format = this.resolveImportFormat(fileId);
    const errorFileInfo = await this.createPreviewErrorFile();
    const errorSamples: Array<{ rowNumber: number; message: string }> = [];
    let total = 0;
    let created = 0;
    let updated = 0;
    let errors = 0;

    try {
      for await (const record of this.iterateStoredImportRows(fileId, format)) {
        total += 1;

        const normalized = this.normalizePreviewRow(record as Record<string, unknown>, total, options.mapping);
        if (!normalized.ok) {
          errors += 1;
          this.writePreviewErrorRow(errorFileInfo.stream, total, normalized.message, record);
          if (errorSamples.length < 200) {
            errorSamples.push({ rowNumber: total, message: normalized.message });
          }
          continue;
        }

        const identifier = options.matchBy === 'email' ? normalized.email : normalized.phone;
        if (!identifier) {
          const message = `${options.matchBy} is required for the selected match rule`;
          errors += 1;
          this.writePreviewErrorRow(errorFileInfo.stream, total, message, record);
          if (errorSamples.length < 200) {
            errorSamples.push({ rowNumber: total, message });
          }
          continue;
        }

        const existing = await this.prisma.contact.findFirst({
          where: {
            workspaceId,
            mergedIntoContactId: null,
            ...(options.matchBy === 'email'
              ? { email: identifier }
              : { phone: identifier }),
          },
          select: { id: true },
        });

        if (existing) {
          if (options.importMode === 'create') {
            const message = 'Matching contact already exists';
            errors += 1;
            this.writePreviewErrorRow(errorFileInfo.stream, total, message, record);
            if (errorSamples.length < 200) {
              errorSamples.push({ rowNumber: total, message });
            }
            continue;
          }
          updated += 1;
          continue;
        }

        if (options.importMode === 'update') {
          const message = 'No matching contact found for update';
          errors += 1;
          this.writePreviewErrorRow(errorFileInfo.stream, total, message, record);
          if (errorSamples.length < 200) {
            errorSamples.push({ rowNumber: total, message });
          }
          continue;
        }

        created += 1;
      }

      errorFileInfo.stream.end();
      await once(errorFileInfo.stream, 'finish');

      let errorFileUrl: string | null = null;
      if (errors > 0) {
        const upload = await this.r2.uploadStream(
          `files/import-previews/workspace/${workspaceId}/${Date.now()}-preview-errors.csv`,
          createReadStream(errorFileInfo.path),
          'text/csv',
        );
        errorFileUrl = upload.url;
      }

      return {
        total,
        new: created,
        update: updated,
        errors,
        errorFileUrl,
      };
    } finally {
      errorFileInfo.stream.destroy();
      await fsPromises.rm(errorFileInfo.path, { force: true }).catch(() => undefined);
    }
  }

  private resolveImportFormat(source?: string | null) {
    const extension = extname(String(source ?? '').toLowerCase());
    if (extension === '.csv') return 'csv' as const;
    if (extension === '.xlsx') return 'xlsx' as const;
    throw new BadRequestException('Only CSV and XLSX imports are supported.');
  }

  private async extractImportSample(
    buffer: Buffer,
    fileName: string,
    format: 'csv' | 'xlsx',
  ) {
    if (format === 'csv') {
      const records = parseCsvSync(buffer, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, unknown>[];

      return {
        headers: records.length ? Object.keys(records[0]) : [],
        sampleRows: records.slice(0, 10),
        rowCountEstimate: records.length,
      };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const worksheet = workbook.worksheets[0];
    const headerRow = worksheet?.getRow(1);
    const headers = (headerRow?.values as any[] | undefined)?.slice(1).map((value) => String(value ?? '').trim()) ?? [];
    const sampleRows: Record<string, unknown>[] = [];

    if (worksheet) {
      for (let index = 2; index <= Math.min(worksheet.rowCount, 11); index += 1) {
        const row = worksheet.getRow(index);
        const record: Record<string, unknown> = {};
        headers.forEach((header, headerIndex) => {
          record[header] = row.getCell(headerIndex + 1).text;
        });
        sampleRows.push(record);
      }
    }

    return {
      headers,
      sampleRows,
      rowCountEstimate: Math.max((worksheet?.rowCount ?? 1) - 1, 0),
    };
  }

  private async *iterateStoredImportRows(fileId: string, format: 'csv' | 'xlsx') {
    const stream = await this.r2.getObjectStream(fileId);

    if (format === 'csv') {
      const rows = parseCsvSync(await this.streamToBuffer(stream), {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, unknown>[];

      for (const row of rows) {
        yield row;
      }
      return;
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(stream as any, {
      sharedStrings: 'cache',
      worksheets: 'emit',
      hyperlinks: 'ignore',
      styles: 'ignore',
    });

    for await (const worksheet of workbook as AsyncIterable<any>) {
      if (worksheet.type !== 'worksheet') continue;

      let headers: string[] = [];
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (!headers.length) {
          headers = values.map((value: unknown, index: number) => String(value ?? '').trim() || `column_${index + 1}`);
          continue;
        }

        const record: Record<string, unknown> = {};
        headers.forEach((header, headerIndex) => {
          record[header] = values[headerIndex];
        });
        yield record;
      }
      break;
    }
  }

  private normalizePreviewRow(
    record: Record<string, unknown>,
    _rowNumber: number,
    mapping: Record<string, string>,
  ) {
    const readMapped = (target: string, fallbacks: string[] = []) => {
      const mappedColumn = Object.entries(mapping).find(([, value]) => this.normalizeImportTarget(value) === target)?.[0];
      const candidates = [mappedColumn, ...fallbacks].filter(Boolean) as string[];

      for (const candidate of candidates) {
        const value = record[candidate];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          return String(value).trim();
        }

        const match = Object.keys(record).find((key) => key.toLowerCase() === candidate.toLowerCase());
        if (match) {
          const matchedValue = record[match];
          if (matchedValue !== undefined && matchedValue !== null && String(matchedValue).trim() !== '') {
            return String(matchedValue).trim();
          }
        }
      }

      return undefined;
    };

    const firstName = readMapped('firstName');
    const fullName = readMapped('name');
    const email = this.normalizeEmail(readMapped('email'));
    const phone = this.normalizePhone(readMapped('phone'));

    if (!firstName && !fullName) {
      return { ok: false as const, message: 'Name is required' };
    }

    if (!email && !phone) {
      return { ok: false as const, message: 'Phone or email is required' };
    }

    return {
      ok: true as const,
      email,
      phone,
    };
  }

  private sanitizeFileName(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private toJsonValue(value: Record<string, unknown>) {
    return value as Prisma.InputJsonValue;
  }

  private toJsonValueArray(value: Array<Record<string, unknown>>) {
    return value as unknown as Prisma.InputJsonValue;
  }

  private normalizeImportTarget(value?: string | null) {
    const normalized = String(value ?? '').trim();
    const map: Record<string, string> = {
      first_name: 'firstName',
      firstName: 'firstName',
      last_name: 'lastName',
      lastName: 'lastName',
      full_name: 'name',
      name: 'name',
      email: 'email',
      phone: 'phone',
      phone_number: 'phone',
      company: 'company',
      status: 'status',
      marketing_opt_out: 'marketingOptOut',
      marketingOptOut: 'marketingOptOut',
      do_not_import: '',
    };

    return map[normalized] ?? normalized;
  }

  private normalizeEmail(value?: string) {
    const email = value?.trim().toLowerCase();
    return email ? email : null;
  }

  private normalizePhone(value?: string) {
    const phone = value?.replace(/[^\d+]/g, '').trim();
    return phone ? phone : null;
  }

  private async streamToBuffer(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async createPreviewErrorFile() {
    const dir = join(process.cwd(), 'tmp', 'import-export');
    await fsPromises.mkdir(dir, { recursive: true });
    const path = join(dir, `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`);
    const stream = createWriteStream(path, { encoding: 'utf8' });
    stream.write('rowNumber,error,raw\n');
    return { path, stream };
  }

  private writePreviewErrorRow(
    stream: NodeJS.WritableStream,
    rowNumber: number,
    message: string,
    raw: unknown,
  ) {
    stream.write(`${rowNumber},${this.escapeCsv(message)},${this.escapeCsv(JSON.stringify(raw ?? {}))}\n`);
  }

  private escapeCsv(value: unknown) {
    const stringValue = String(value ?? '');
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  private formatBatchTagSuffix(date: Date) {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  private asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
  }

  private async emitJobUpdate(jobId: string) {
    const job = await this.prisma.importExportJob.findUnique({
      where: { id: jobId },
    });

    if (!job) return;

    const payload = this.toJobResponse(job);
    this.realtime.emitToUser(job.createdBy, IMPORT_EXPORT_EVENT, payload);
    this.realtime.emitToUser(job.createdBy, 'job:update', {
      jobId: job.id,
      status: job.status,
      progress: payload.progress,
      processedRecords: job.processedRecords,
      totalRecords: job.totalRecords,
      successCount: job.successCount,
      failureCount: job.failureCount,
      resultUrl: job.resultUrl,
      entity: job.entity,
      type: job.type,
    });
  }

  private async notifySuccess(jobId: string) {
    const job = await this.prisma.importExportJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    const isImport = job.type.endsWith('_IMPORT');
    const title = isImport ? 'Contacts import completed' : 'Export file is ready';
    const body = isImport
      ? `${job.successCount} contacts imported${job.failureCount ? `, ${job.failureCount} failed` : ''}.`
      : `Your ${job.entity} export has finished and is ready to download.`;

    await this.notifications.ingest({
      userId: job.createdBy,
      workspaceId: job.tenantId,
      type: isImport ? NotificationType.CONTACTS_IMPORT_COMPLETED : NotificationType.DATA_EXPORT_READY,
      title,
      body,
      metadata: {
        jobId: job.id,
        entity: job.entity,
        resultUrl: job.resultUrl,
      },
      sourceEntityType: 'import_export_job',
      sourceEntityId: job.id,
      dedupeKey: `${job.type}:${job.id}:completed`,
    });
  }

  private async notifyFailure(jobId: string, error: any) {
    const job = await this.prisma.importExportJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    await this.notifications.ingest({
      userId: job.createdBy,
      workspaceId: job.tenantId,
      type: NotificationType.CUSTOM_NOTIFICATION,
      title: `${job.entity} ${job.type.endsWith('_IMPORT') ? 'import' : 'export'} failed`,
      body: error?.message ?? 'The background job failed. Open the job details to review the error log.',
      metadata: {
        jobId: job.id,
        entity: job.entity,
      },
      sourceEntityType: 'import_export_job',
      sourceEntityId: job.id,
      dedupeKey: `${job.type}:${job.id}:failed`,
    });
  }

  private toJobResponse(job: ImportExportJob) {
    const total = job.totalRecords || 0;
    const processed = job.processedRecords || 0;
    const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    return {
      ...job,
      progress,
    };
  }
}
