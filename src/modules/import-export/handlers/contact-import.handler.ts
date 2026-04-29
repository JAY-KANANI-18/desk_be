import { BadRequestException, Injectable } from '@nestjs/common';
import { ImportExportJob, Prisma } from '@prisma/client';
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';
import { once } from 'node:events';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { extname, join } from 'node:path';
import { PrismaService } from '../../../prisma/prisma.service';
import { R2Service } from '../../../common/storage/r2.service';
import { resolveContactAvatarUrl } from '../../../common/contacts/static-contact-avatar';
import { CONTACT_IMPORT_TYPE, ImportExportHandlerResult } from '../import-export.types';
import { ImportHandler, ImportProgressReporter } from './import-handler.interface';

type ParsedContactRow = {
  rowNumber: number;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string | null;
  marketingOptOut: boolean;
  mappedFields: string[];
};

type RawRecord = Record<string, unknown>;

@Injectable()
export class ContactImportHandler implements ImportHandler {
  readonly entity = 'contact';
  readonly type = CONTACT_IMPORT_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  async run(job: ImportExportJob, reporter: ImportProgressReporter): Promise<ImportExportHandlerResult> {
    const metadata = this.asObject(job.metadata);
    const format = this.resolveFormat(job.fileUrl, metadata.fileName);
    const totalRecords = await this.countRows(job, format);
    const errorSamples: Array<{ rowNumber: number; message: string }> = [];
    const importMode = this.resolveImportMode(metadata.importMode);
    const matchBy = this.resolveMatchBy(metadata.matchBy);
    const tagIds = await this.resolveTagIds(job.tenantId, metadata.tagIds);

    await reporter.update({
      totalRecords,
      processedRecords: 0,
      successCount: 0,
      failureCount: 0,
      status: 'PROCESSING',
    });

    const batchSize = this.resolveBatchSize(metadata.batchSize);
    const errorFileInfo = await this.createErrorFile(job.id);
    let processedRecords = 0;
    let successCount = 0;
    let failureCount = 0;
    let batch: ParsedContactRow[] = [];

    try {
      for await (const record of this.iterateRows(job, format)) {
        processedRecords += 1;

        try {
          const parsed = this.normalizeRow(
            record,
            processedRecords,
            metadata.mapping as Record<string, string> | undefined,
          );
          batch.push(parsed);
        } catch (error: any) {
          failureCount += 1;
          if (errorSamples.length < 200) {
            errorSamples.push({ rowNumber: processedRecords, message: error.message });
          }
          this.writeErrorRow(errorFileInfo.stream, processedRecords, error.message, record);
        }

        if (batch.length >= batchSize) {
          const result = await this.flushBatch(
            job,
            batch,
            errorFileInfo.stream,
            errorSamples,
            importMode,
            matchBy,
            tagIds,
          );
          batch = [];
          successCount += result.successCount;
          failureCount += result.failureCount;
        }

        await reporter.update({
          totalRecords,
          processedRecords,
          successCount,
          failureCount,
          errorLog: errorSamples,
        });
      }

      if (batch.length > 0) {
        const result = await this.flushBatch(
          job,
          batch,
          errorFileInfo.stream,
          errorSamples,
          importMode,
          matchBy,
          tagIds,
        );
        successCount += result.successCount;
        failureCount += result.failureCount;
      }

      errorFileInfo.stream.end();
      await once(errorFileInfo.stream, 'finish');

      let resultUrl: string | null = null;
      if (failureCount > 0) {
        const upload = await this.r2.uploadStream(
          `files/import-results/workspace/${job.tenantId}/${job.id}-errors.csv`,
          createReadStream(errorFileInfo.path),
          'text/csv',
        );
        resultUrl = upload.url;
      }

      return {
        totalRecords,
        processedRecords,
        successCount,
        failureCount,
        resultUrl,
        errorLog: errorSamples,
      };
    } finally {
      errorFileInfo.stream.destroy();
      await fsPromises.rm(errorFileInfo.path, { force: true }).catch(() => undefined);
    }
  }

  private async flushBatch(
    job: ImportExportJob,
    rows: ParsedContactRow[],
    errorStream: NodeJS.WritableStream,
    errorSamples: Array<{ rowNumber: number; message: string }>,
    importMode: 'create' | 'update' | 'upsert' | 'overwrite',
    matchBy: 'phone' | 'email',
    tagIds: string[],
  ) {
    const existing = await this.findExistingContacts(job.tenantId, rows, matchBy);
    let successCount = 0;
    let failureCount = 0;

    for (const row of rows) {
      const identifier = matchBy === 'email' ? row.email : row.phone;
      if (!identifier) {
        failureCount += 1;
        const message = `${matchBy} is required for the selected match rule`;
        if (errorSamples.length < 200) {
          errorSamples.push({ rowNumber: row.rowNumber, message });
        }
        this.writeErrorRow(errorStream, row.rowNumber, message, row);
        continue;
      }

      const existingContact = existing.get(identifier);

      if (existingContact && importMode === 'create') {
        failureCount += 1;
        const message = 'Matching contact already exists';
        if (errorSamples.length < 200) {
          errorSamples.push({ rowNumber: row.rowNumber, message });
        }
        this.writeErrorRow(errorStream, row.rowNumber, message, row);
        continue;
      }

      if (!existingContact && importMode === 'update') {
        failureCount += 1;
        const message = 'No matching contact found for update';
        if (errorSamples.length < 200) {
          errorSamples.push({ rowNumber: row.rowNumber, message });
        }
        this.writeErrorRow(errorStream, row.rowNumber, message, row);
        continue;
      }

      try {
        const payload = this.toWritePayload(row, importMode);
        const payloadAvatarUrl = typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null;
        const contact = existingContact
          ? await this.prisma.contact.update({
              where: { id: existingContact.id },
              data: payload as Prisma.ContactUncheckedUpdateInput,
              select: { id: true },
            })
          : await this.prisma.contact.create({
              data: {
                workspaceId: job.tenantId,
                ...payload,
                avatarUrl: resolveContactAvatarUrl(payloadAvatarUrl),
              } as Prisma.ContactUncheckedCreateInput,
              select: { id: true },
            });

        if (tagIds.length) {
          await this.prisma.contactTag.createMany({
            data: tagIds.map((tagId) => ({
              contactId: contact.id,
              tagId,
            })),
            skipDuplicates: true,
          });
        }

        successCount += 1;
      } catch (error: any) {
        failureCount += 1;
        const message = error?.message ?? 'Failed to import contact row';
        if (errorSamples.length < 200) {
          errorSamples.push({ rowNumber: row.rowNumber, message });
        }
        this.writeErrorRow(errorStream, row.rowNumber, message, row);
      }
    }

    return { successCount, failureCount };
  }

  private async findExistingContacts(
    workspaceId: string,
    rows: ParsedContactRow[],
    matchBy: 'phone' | 'email',
  ) {
    const identifiers = Array.from(
      new Set(
        rows
          .map((row) => (matchBy === 'email' ? row.email : row.phone))
          .filter(Boolean) as string[],
      ),
    );

    if (!identifiers.length) {
      return new Map<string, { id: string }>();
    }

    const existing = await this.prisma.contact.findMany({
      where: {
        workspaceId,
        mergedIntoContactId: null,
        ...(matchBy === 'email'
          ? { email: { in: identifiers } }
          : { phone: { in: identifiers } }),
      },
      select: {
        id: true,
        email: true,
        phone: true,
      },
    });

    return new Map(
      existing.map((row) => [
        matchBy === 'email' ? row.email : row.phone,
        { id: row.id },
      ]).filter((entry): entry is [string, { id: string }] => Boolean(entry[0])),
    );
  }

  private normalizeRow(
    record: RawRecord,
    rowNumber: number,
    mapping?: Record<string, string>,
  ): ParsedContactRow {
    const nameValue = this.readField(record, mapping, 'name', ['name', 'full_name', 'fullName']);
    const firstNameValue = this.readField(record, mapping, 'firstName', ['firstName', 'first_name']);
    const lastNameValue = this.readField(record, mapping, 'lastName', ['lastName', 'last_name']);
    const email = this.normalizeEmail(this.readField(record, mapping, 'email', ['email', 'emailAddress', 'email_address']));
    const phone = this.normalizePhone(this.readField(record, mapping, 'phone', ['phone', 'phoneNumber', 'phone_number', 'mobile']));
    const company = this.normalizeOptional(this.readField(record, mapping, 'company', ['company', 'organization']));
    const status = this.normalizeOptional(this.readField(record, mapping, 'status', ['status']));
    const marketingOptOut = this.normalizeBoolean(this.readField(record, mapping, 'marketingOptOut', ['marketingOptOut', 'marketing_opt_out']));

    const derivedName = this.deriveName(firstNameValue, lastNameValue, nameValue);
    if (!derivedName.firstName) {
      throw new BadRequestException('Name is required');
    }

    if (!email && !phone) {
      throw new BadRequestException('Phone or email is required');
    }

    return {
      rowNumber,
      firstName: derivedName.firstName,
      lastName: derivedName.lastName,
      email,
      phone,
      company,
      status,
      marketingOptOut,
      mappedFields: Array.from(new Set(
        Object.values(mapping ?? {})
          .map((value) => this.normalizeImportTarget(value))
          .filter(Boolean),
      )),
    };
  }

  private readField(
    record: RawRecord,
    mapping: Record<string, string> | undefined,
    target: string,
    fallbacks: string[],
  ) {
    const mappedColumn = Object.entries(mapping ?? {}).find(
      ([, value]) => this.normalizeImportTarget(value) === target,
    )?.[0];
    const candidates = [mappedColumn, mapping?.[target], ...fallbacks].filter(Boolean) as string[];

    for (const candidate of candidates) {
      const directValue = record[candidate];
      if (directValue !== undefined && directValue !== null && String(directValue).trim() !== '') {
        return String(directValue).trim();
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
  }

  private deriveName(firstName?: string, lastName?: string, fullName?: string) {
    const normalizedFirst = this.normalizeOptional(firstName);
    const normalizedLast = this.normalizeOptional(lastName);
    if (normalizedFirst) {
      return {
        firstName: normalizedFirst,
        lastName: normalizedLast,
      };
    }

    const full = this.normalizeOptional(fullName);
    if (!full) {
      return { firstName: null, lastName: null };
    }

    const parts = full.split(/\s+/).filter(Boolean);
    return {
      firstName: parts.shift() ?? null,
      lastName: parts.length ? parts.join(' ') : null,
    };
  }

  private normalizeOptional(value?: string) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeEmail(value?: string) {
    const email = value?.trim().toLowerCase();
    return email ? email : null;
  }

  private normalizePhone(value?: string) {
    const phone = value?.replace(/[^\d+]/g, '').trim();
    return phone ? phone : null;
  }

  private normalizeBoolean(value?: string) {
    if (!value) return false;
    return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
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

  private resolveBatchSize(input: unknown) {
    const parsed = Number(input);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 1000) {
      return parsed;
    }
    return 500;
  }

  private resolveImportMode(value: unknown) {
    return ['create', 'update', 'upsert', 'overwrite'].includes(String(value))
      ? (String(value) as 'create' | 'update' | 'upsert' | 'overwrite')
      : 'upsert';
  }

  private resolveMatchBy(value: unknown) {
    return String(value) === 'email' ? 'email' : 'phone';
  }

  private async resolveTagIds(workspaceId: string, value: unknown) {
    const requested = Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
    if (!requested.length) return [];

    const tags = await this.prisma.tag.findMany({
      where: {
        workspaceId,
        id: { in: requested },
      },
      select: { id: true },
    });

    return tags.map((tag) => tag.id);
  }

  private toWritePayload(
    row: ParsedContactRow,
    importMode: 'create' | 'update' | 'upsert' | 'overwrite',
  ): Record<string, unknown> {
    const includeNulls = importMode === 'overwrite';
    const payload: Record<string, unknown> = {};

    const assign = (key: string, value: unknown) => {
      if (!row.mappedFields.includes(key)) return;
      if (value === null || value === undefined) {
        if (includeNulls) payload[key] = null;
        return;
      }
      payload[key] = value;
    };

    if (row.mappedFields.includes('firstName') || row.mappedFields.includes('name')) {
      payload.firstName = row.firstName;
    }
    if (row.mappedFields.includes('lastName') || row.mappedFields.includes('name')) {
      if (row.lastName !== null || includeNulls) {
        payload.lastName = row.lastName;
      }
    }
    assign('email', row.email);
    assign('phone', row.phone);
    assign('company', row.company);
    assign('status', row.status);
    if (row.mappedFields.includes('marketingOptOut')) {
      payload.marketingOptOut = row.marketingOptOut;
    }

    return payload;
  }

  private resolveFormat(fileUrl?: string | null, fileName?: unknown) {
    const source = String(fileName || fileUrl || '').toLowerCase();
    const extension = extname(source);
    if (extension === '.csv') return 'csv';
    if (extension === '.xlsx') return 'xlsx';
    throw new BadRequestException('Unsupported import file format. Use CSV or XLSX.');
  }

  private async countRows(job: ImportExportJob, format: 'csv' | 'xlsx') {
    let count = 0;
    for await (const _ of this.iterateRows(job, format)) {
      count += 1;
    }
    return count;
  }

  private async *iterateRows(job: ImportExportJob, format: 'csv' | 'xlsx') {
    const stream = await this.r2.getObjectStream(job.fileUrl ?? '');

    if (format === 'csv') {
      const parser = parse({
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      });
      stream.pipe(parser);

      for await (const record of parser) {
        yield record as RawRecord;
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
      if (worksheet.type !== 'worksheet') {
        continue;
      }

      let headers: string[] = [];
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (!headers.length) {
          headers = values.map((value: unknown, index: number) => {
            const normalized = String(value ?? '').trim();
            return normalized || `column_${index + 1}`;
          });
          continue;
        }

        const record: RawRecord = {};
        headers.forEach((header, index) => {
          record[header] = values[index];
        });
        yield record;
      }
      break;
    }
  }

  private asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
  }

  private async createErrorFile(jobId: string) {
    const dir = join(process.cwd(), 'tmp', 'import-export');
    await fsPromises.mkdir(dir, { recursive: true });
    const path = join(dir, `${jobId}-errors.csv`);
    const stream = createWriteStream(path, { encoding: 'utf8' });
    stream.write('rowNumber,error,raw\n');
    return { path, stream };
  }

  private writeErrorRow(stream: NodeJS.WritableStream, rowNumber: number, message: string, raw: unknown) {
    const serialized = JSON.stringify(raw ?? {});
    const line = `${rowNumber},${this.escapeCsv(message)},${this.escapeCsv(serialized)}\n`;
    stream.write(line);
  }

  private escapeCsv(value: unknown) {
    const stringValue = String(value ?? '');
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
}
