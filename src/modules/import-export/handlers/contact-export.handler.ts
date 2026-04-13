import { Injectable } from '@nestjs/common';
import { ImportExportJob, Prisma } from '@prisma/client';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { PrismaService } from '../../../prisma/prisma.service';
import { R2Service } from '../../../common/storage/r2.service';
import { CONTACT_EXPORT_TYPE, ImportExportHandlerResult } from '../import-export.types';
import { ExportHandler, ExportProgressReporter } from './export-handler.interface';

@Injectable()
export class ContactExportHandler implements ExportHandler {
  readonly entity = 'contact';
  readonly type = CONTACT_EXPORT_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  async run(job: ImportExportJob, reporter: ExportProgressReporter): Promise<ImportExportHandlerResult> {
    const metadata = this.asObject(job.metadata);
    const filters = this.asObject(metadata.filters);
    const totalRecords = await this.prisma.contact.count({
      where: this.buildWhere(job.tenantId, filters),
    });

    await reporter.update({
      totalRecords,
      processedRecords: 0,
      successCount: 0,
      failureCount: 0,
      status: 'PROCESSING',
    });

    const file = await this.createExportFile(job.id);
    let processedRecords = 0;
    let cursor: string | undefined;

    try {
      file.stream.write([
        'Name',
        'First Name',
        'Last Name',
        'Email',
        'Phone',
        'Company',
        'Status',
        'Lifecycle',
        'Assignee',
        'Tags',
        'Channels',
        'Marketing Opt Out',
        'Created At',
      ].join(',') + '\n');

      while (true) {
        const rows = await this.prisma.contact.findMany({
          where: this.buildWhere(job.tenantId, filters),
          orderBy: { id: 'asc' },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: {
            lifecycle: { select: { name: true } },
            assignee: { select: { firstName: true, lastName: true, email: true } },
            tags: { include: { tag: { select: { name: true } } } },
            contactChannels: { select: { channelType: true, identifier: true } },
          },
        });

        if (!rows.length) break;

        for (const row of rows) {
          const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
          const assignee = row.assignee
            ? [row.assignee.firstName, row.assignee.lastName].filter(Boolean).join(' ').trim() || row.assignee.email
            : '';
          const tags = row.tags.map((tag) => tag.tag.name).join(' | ');
          const channels = row.contactChannels
            .map((channel) => `${channel.channelType}:${channel.identifier}`)
            .join(' | ');

          file.stream.write([
            this.escapeCsv(name),
            this.escapeCsv(row.firstName),
            this.escapeCsv(row.lastName),
            this.escapeCsv(row.email),
            this.escapeCsv(row.phone),
            this.escapeCsv(row.company),
            this.escapeCsv(row.status),
            this.escapeCsv(row.lifecycle?.name),
            this.escapeCsv(assignee),
            this.escapeCsv(tags),
            this.escapeCsv(channels),
            this.escapeCsv(row.marketingOptOut ? 'true' : 'false'),
            this.escapeCsv(row.createdAt.toISOString()),
          ].join(',') + '\n');
        }

        processedRecords += rows.length;
        cursor = rows[rows.length - 1]?.id;

        await reporter.update({
          totalRecords,
          processedRecords,
          successCount: processedRecords,
          failureCount: 0,
        });
      }

      file.stream.end();
      await once(file.stream, 'finish');

      const upload = await this.r2.uploadStream(
        `files/exports/workspace/${job.tenantId}/${job.id}-contacts.csv`,
        createReadStream(file.path),
        'text/csv',
      );

      return {
        totalRecords,
        processedRecords,
        successCount: processedRecords,
        failureCount: 0,
        resultUrl: upload.url,
      };
    } finally {
      file.stream.destroy();
      await fsPromises.rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  private buildWhere(workspaceId: string, filters: Record<string, any>): Prisma.ContactWhereInput {
    const where: Prisma.ContactWhereInput = {
      workspaceId,
      mergedIntoContactId: null,
    };

    const search = String(filters.search ?? '').trim();
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (filters.lifecycleId) {
      where.lifecycleId = String(filters.lifecycleId);
    }

    if (filters.assigneeId) {
      where.assigneeId = String(filters.assigneeId);
    }

    if (Array.isArray(filters.tagIds) && filters.tagIds.length) {
      where.tags = {
        some: {
          tagId: { in: filters.tagIds.map((value: unknown) => String(value)) },
        },
      };
    }

    if (filters.marketingOptOut !== undefined) {
      where.marketingOptOut = Boolean(filters.marketingOptOut);
    }

    return where;
  }

  private async createExportFile(jobId: string) {
    const dir = join(process.cwd(), 'tmp', 'import-export');
    await fsPromises.mkdir(dir, { recursive: true });
    const path = join(dir, `${jobId}-export.csv`);
    const stream = createWriteStream(path, { encoding: 'utf8' });
    return { path, stream };
  }

  private escapeCsv(value: unknown) {
    const stringValue = String(value ?? '');
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  private asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
  }
}
