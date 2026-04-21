import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { inflateRawSync } from 'zlib';
import { parse as parseCsv } from 'csv-parse/sync';
import { R2Service } from 'src/common/storage/r2.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { aiKnowledgeQueue } from 'src/queues/ai-agent.queue';
import { aiAgentsDebug } from '../ai-agents-debug.logger';
import { AiGatewayService } from '../gateway/ai-gateway.service';
import { KnowledgeHit } from '../runtime/agent-runtime.types';
import { CrawlStats, KnowledgeCrawlerService } from './knowledge-crawler.service';
import { KnowledgeContentType } from './content-type.util';
import { KnowledgeChunkInput, KnowledgeDocument, KnowledgeSmartChunker } from './smart-chunker.util';
import { KnowledgeTextSanitizer } from './text-sanitizer.util';

type KnowledgeSourceStatus =
  | 'queued'
  | 'pending'
  | 'fetching'
  | 'extracting'
  | 'embedding'
  | 'indexing'
  | 'ready'
  | 'completed'
  | 'partial_success'
  | 'failed'
  | 'disabled';

type KnowledgeSchemaCapabilities = {
  extendedSourceStatuses: boolean;
  chunkColumns: {
    url: boolean;
    canonicalUrl: boolean;
    cleanText: boolean;
    embeddingStatus: boolean;
    lastCrawledAt: boolean;
  };
};

@Injectable()
export class KnowledgeService {
  private knowledgeSchemaCapabilitiesPromise?: Promise<KnowledgeSchemaCapabilities>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly r2: R2Service,
    private readonly crawler: KnowledgeCrawlerService,
  ) {}

  async createSource(
    workspaceId: string,
    input: {
      name: string;
      sourceType: 'file' | 'website' | 'faq' | 'product_catalog' | 'manual';
      uri?: string;
      fileAssetId?: string;
      crawlerConfig?: Record<string, any>;
      importConfig?: Record<string, any>;
      createdByUserId?: string;
    },
  ) {
    if (!input.name?.trim()) throw new BadRequestException('Knowledge source name is required');
    aiAgentsDebug.log('knowledge', 'createSource start', {
      workspaceId,
      input,
    });
    const queuedStatus = await this.toDatabaseSourceStatus('queued');

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        INSERT INTO "ai_knowledge_sources"
          ("workspace_id", "name", "source_type", "status", "uri", "file_asset_id",
           "crawler_config", "import_config", "created_by_user_id")
        VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, $9::uuid)
        RETURNING *
      `,
      workspaceId,
      input.name.trim(),
      input.sourceType,
      queuedStatus,
      input.uri || null,
      input.fileAssetId || null,
      JSON.stringify(input.crawlerConfig || {}),
      JSON.stringify(input.importConfig || {}),
      input.createdByUserId || null,
    );

    const source = rows[0];
    aiAgentsDebug.log('knowledge', 'createSource inserted', {
      workspaceId,
      sourceId: source.id,
      sourceType: source.source_type,
      status: source.status,
    });
    const job = await aiKnowledgeQueue.add(
      'ai.knowledge.ingest_source',
      {
        type: input.sourceType === 'website' ? 'CRAWL_WEBSITE' : 'INGEST_SOURCE',
        workspaceId,
        sourceId: source.id,
        idempotencyKey: `${workspaceId}:${source.id}:ingest`,
      },
      { jobId: `${workspaceId}:${source.id}:ingest` },
    );
    const counts = await aiKnowledgeQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    aiAgentsDebug.log('knowledge.queue', 'ingest job queued', {
      workspaceId,
      sourceId: source.id,
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      idempotencyKey: `${workspaceId}:${source.id}:ingest`,
      counts,
      jobData: job.data,
    });

    const result = this.toSourceDto(source);
    aiAgentsDebug.log('knowledge', 'createSource result', { workspaceId, result });
    return result;
  }

  async listSources(workspaceId: string) {
    aiAgentsDebug.log('knowledge', 'listSources start', { workspaceId });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT *
        FROM "ai_knowledge_sources"
        WHERE "workspace_id" = $1::uuid
          AND "deleted_at" IS NULL
        ORDER BY "created_at" DESC
      `,
      workspaceId,
    );

    const result = rows.map((row) => this.toSourceDto(row));
    aiAgentsDebug.log('knowledge', 'listSources result', {
      workspaceId,
      count: result.length,
      sources: result,
    });
    return result;
  }

  async setSourceEnabled(workspaceId: string, sourceId: string, enabled: boolean) {
    aiAgentsDebug.log('knowledge', 'setSourceEnabled start', { workspaceId, sourceId, enabled });
    const existing = await this.getSourceRow(workspaceId, sourceId);
    if (!existing) throw new NotFoundException('Knowledge source not found');

    if (!enabled) {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `
          UPDATE "ai_knowledge_sources"
          SET "status" = 'disabled', "updated_at" = CURRENT_TIMESTAMP
          WHERE "workspace_id" = $1::uuid
            AND "id" = $2::uuid
            AND "deleted_at" IS NULL
          RETURNING *
        `,
        workspaceId,
        sourceId,
      );

      const result = this.toSourceDto(rows[0]);
      aiAgentsDebug.log('knowledge', 'setSourceEnabled disabled result', { workspaceId, sourceId, result });
      return result;
    }

    const queuedStatus = await this.toDatabaseSourceStatus('queued');
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        UPDATE "ai_knowledge_sources"
        SET "status" = $3, "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
          AND "deleted_at" IS NULL
        RETURNING *
      `,
      workspaceId,
      sourceId,
      queuedStatus,
    );

    const job = await aiKnowledgeQueue.add(
      'ai.knowledge.reindex_source',
      {
        type: 'REINDEX_SOURCE',
        workspaceId,
        sourceId,
        idempotencyKey: `${workspaceId}:${sourceId}:reindex:${Date.now()}`,
        payload: { reason: 'source_enabled' },
      },
      { jobId: `${workspaceId}:${sourceId}:enable:${Date.now()}` },
    );
    const counts = await aiKnowledgeQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    const result = this.toSourceDto(rows[0]);
    aiAgentsDebug.log('knowledge.queue', 'enable queued reindex job', {
      workspaceId,
      sourceId,
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      counts,
      jobData: job.data,
      result,
    });
    return result;
  }

  async reindexSource(workspaceId: string, sourceId: string, reason = 'manual_reindex') {
    aiAgentsDebug.log('knowledge', 'reindexSource start', { workspaceId, sourceId, reason });
    const source = await this.getSourceRow(workspaceId, sourceId);
    if (!source) throw new NotFoundException('Knowledge source not found');
    if (source.status === 'disabled') throw new BadRequestException('Enable the knowledge source before reindexing');
    const queuedStatus = await this.toDatabaseSourceStatus('queued');

    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_knowledge_sources"
        SET "status" = $3, "updated_at" = CURRENT_TIMESTAMP
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
      `,
      workspaceId,
      sourceId,
      queuedStatus,
    );

    const job = await aiKnowledgeQueue.add(
      'ai.knowledge.reindex_source',
      {
        type: 'REINDEX_SOURCE',
        workspaceId,
        sourceId,
        idempotencyKey: `${workspaceId}:${sourceId}:reindex:${Date.now()}`,
        payload: { reason },
      },
      { jobId: `${workspaceId}:${sourceId}:reindex:${Date.now()}` },
    );
    const counts = await aiKnowledgeQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    aiAgentsDebug.log('knowledge.queue', 'reindex job queued', {
      workspaceId,
      sourceId,
      jobId: job.id,
      jobName: job.name,
      queue: job.queueName,
      counts,
      jobData: job.data,
    });
    return { queued: true, sourceId, jobId: job.id };
  }

  async ingestSource(workspaceId: string, sourceId: string, payload?: Record<string, any>) {
    const started = Date.now();
    aiAgentsDebug.log('knowledge.ingest', 'start', { workspaceId, sourceId, payload });
    const source = await this.getSourceRow(workspaceId, sourceId);
    if (!source) throw new NotFoundException('Knowledge source not found');
    if (source.status === 'disabled') {
      aiAgentsDebug.warn('knowledge.ingest', 'skipped disabled source', { workspaceId, sourceId, source });
      return { skipped: true, reason: 'source_disabled', sourceId };
    }

    try {
      await this.markSourceStatus(workspaceId, sourceId, 'fetching', {
        sourceType: source.source_type,
        startedAt: new Date().toISOString(),
      });
      const extracted = await this.extractDocuments(source);
      await this.markSourceStatus(workspaceId, sourceId, 'extracting', {
        pagesFetched: extracted.stats?.fetchedPages || 0,
        pagesExtracted: extracted.documents.length,
        skippedPages: extracted.stats?.skippedPages || 0,
        failedPages: extracted.stats?.failedPages || 0,
      });
      const documents = extracted.documents;
      const chunks = KnowledgeSmartChunker.chunk(documents);
      const maxChunks = Number(process.env.AI_KNOWLEDGE_MAX_CHUNKS_PER_SOURCE || 2000);
      const limitedChunks = chunks.slice(0, maxChunks);
      const checksum = this.hashText(limitedChunks.map((chunk) => chunk.contentHash).join('|'));

      aiAgentsDebug.log('knowledge.ingest', 'documents extracted and chunked', {
        workspaceId,
        sourceId,
        sourceType: source.source_type,
        documentCount: documents.length,
        chunkCount: chunks.length,
        insertedChunkCount: limitedChunks.length,
        maxChunks,
        checksum,
        crawlStats: extracted.stats,
      });

      if (!limitedChunks.length) {
        throw new BadRequestException('Knowledge source did not produce usable chunks');
      }

      await this.prisma.$executeRawUnsafe(
        `DELETE FROM "ai_knowledge_chunks" WHERE "workspace_id" = $1::uuid AND "source_id" = $2::uuid`,
        workspaceId,
        sourceId,
      );

      let embeddedCount = 0;
      let lexicalOnlyCount = 0;
      let failedChunkCount = 0;
      let savedChunkCount = 0;
      await this.markSourceStatus(workspaceId, sourceId, 'embedding', {
        totalChunks: limitedChunks.length,
        embeddedChunks: 0,
        lexicalOnlyChunks: 0,
        failedChunks: 0,
      });
      for (const chunk of limitedChunks) {
        try {
          const embedding = await this.embedChunkSafe(workspaceId, sourceId, source, chunk);
          if (embedding?.embedding?.length === 1536) {
            embeddedCount += 1;
            chunk.embeddingStatus = 'embedded';
          } else {
            lexicalOnlyCount += 1;
            chunk.embeddingStatus = 'lexical_only';
          }

          await this.insertChunk({
            workspaceId,
            sourceId,
            source,
            chunk,
            embedding,
          });
          savedChunkCount += 1;
        } catch (error) {
          failedChunkCount += 1;
          aiAgentsDebug.error('knowledge.ingest', 'chunk save failed; continuing', error, {
            workspaceId,
            sourceId,
            chunkIndex: chunk.chunkIndex,
            title: chunk.title,
          });
        }
      }

      if (!savedChunkCount) {
        throw new BadRequestException('No knowledge chunks were saved');
      }

      const partial = failedChunkCount > 0
        || lexicalOnlyCount > 0
        || Boolean(extracted.stats && extracted.stats.failedPages > 0);
      const finalStatus = partial ? 'partial_success' : 'completed';
      const row = await this.markSourceComplete(workspaceId, sourceId, finalStatus, {
        checksum,
        chunkCount: limitedChunks.length,
        savedChunkCount,
        embeddedCount,
        lexicalOnlyCount,
        failedChunkCount,
        crawlStats: extracted.stats,
        latencyMs: Date.now() - started,
      });

      const result = {
        source: this.toSourceDto(row),
        chunkCount: limitedChunks.length,
        savedChunkCount,
        embeddedCount,
        lexicalOnlyCount,
        failedChunkCount,
        crawlStats: extracted.stats,
        latencyMs: Date.now() - started,
      };
      aiAgentsDebug.log('knowledge.ingest', 'completed', { workspaceId, sourceId, result });
      return result;
    } catch (error) {
      await this.markSourceFailed(workspaceId, sourceId, error);
      aiAgentsDebug.error('knowledge.ingest', 'failed', error, { workspaceId, sourceId, latencyMs: Date.now() - started });
      throw error;
    }
  }

  async embedChunksForSource(workspaceId: string, sourceId: string) {
    aiAgentsDebug.log('knowledge.embedChunks', 'start', { workspaceId, sourceId });
    const source = await this.getSourceRow(workspaceId, sourceId);
    if (!source) throw new NotFoundException('Knowledge source not found');
    if (source.status === 'disabled') return { skipped: true, reason: 'source_disabled', sourceId };

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT "id", "title", "content", "chunk_index", "metadata"
        FROM "ai_knowledge_chunks"
        WHERE "workspace_id" = $1::uuid
          AND "source_id" = $2::uuid
          AND "embedding" IS NULL
        ORDER BY "chunk_index"
        LIMIT $3
      `,
      workspaceId,
      sourceId,
      Number(process.env.AI_KNOWLEDGE_EMBED_BATCH_SIZE || 100),
    );

    let embeddedCount = 0;
    const schema = await this.getKnowledgeSchemaCapabilities();
    for (const row of rows) {
      const embedding = await this.embedTextSafe(workspaceId, sourceId, row.content, row.id);
      if (!embedding?.embedding?.length || embedding.dim !== 1536) continue;
      const vector = this.toVectorLiteral(embedding.embedding);
      await this.prisma.$executeRawUnsafe(
        `
          UPDATE "ai_knowledge_chunks"
          SET "embedding" = $4::vector,
              "embedding_provider" = $5,
              "embedding_model" = $6,
              "embedding_dim" = $7${schema.chunkColumns.embeddingStatus ? `,
              "embedding_status" = 'embedded'` : ''},
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "workspace_id" = $1::uuid
            AND "source_id" = $2::uuid
            AND "id" = $3::uuid
        `,
        workspaceId,
        sourceId,
        row.id,
        vector,
        embedding.provider,
        embedding.model,
        embedding.dim,
      );
      embeddedCount += 1;
    }

    const result = { sourceId, scanned: rows.length, embeddedCount };
    aiAgentsDebug.log('knowledge.embedChunks', 'result', { workspaceId, sourceId, result });
    return result;
  }

  async retrieve(input: {
    workspaceId: string;
    query: string;
    sourceIds?: string[];
    limit?: number;
    minScore?: number;
    useEmbeddings?: boolean;
    runId?: string;
  }): Promise<KnowledgeHit[]> {
    const query = input.query?.trim();
    aiAgentsDebug.log('knowledge.retrieve', 'start', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      query,
      sourceIds: input.sourceIds,
      limit: input.limit,
      minScore: input.minScore,
      useEmbeddings: input.useEmbeddings,
    });
    if (!query) {
      aiAgentsDebug.log('knowledge.retrieve', 'skipped empty query', {
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      return [];
    }

    const limit = Math.min(input.limit || 6, 12);
    const sourceIds = input.sourceIds?.length ? input.sourceIds : null;

    if (input.useEmbeddings !== false) {
      try {
        const embedded = await this.gateway.embed({
          workspaceId: input.workspaceId,
          runId: input.runId,
          text: query,
        });
        aiAgentsDebug.log('knowledge.retrieve', 'embedding ready', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          provider: embedded.provider,
          model: embedded.model,
          dim: embedded.dim,
          latencyMs: embedded.latencyMs,
        });

        if (embedded.dim === 1536) {
          const hits = await this.semanticSearch({
            workspaceId: input.workspaceId,
            query,
            embedding: embedded.embedding,
            sourceIds,
            limit,
            minScore: input.minScore,
          });
          aiAgentsDebug.log('knowledge.retrieve', 'semantic result', {
            workspaceId: input.workspaceId,
            runId: input.runId,
            count: hits.length,
            hits,
          });
          return hits;
        }
        aiAgentsDebug.warn('knowledge.retrieve', 'semantic skipped because embedding dimension is not pgvector-compatible', {
          workspaceId: input.workspaceId,
          runId: input.runId,
          expectedDim: 1536,
          actualDim: embedded.dim,
        });
      } catch (error) {
        aiAgentsDebug.error('knowledge.retrieve', 'embedding failed; falling back to lexical search', error, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          query,
        });
        // Lexical retrieval below is a deliberate fallback, not a silent success.
      }
    }

    const hits = await this.lexicalSearch({
      workspaceId: input.workspaceId,
      query,
      sourceIds,
      limit,
      minScore: input.minScore,
    });
    aiAgentsDebug.log('knowledge.retrieve', 'lexical result', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      count: hits.length,
      hits,
    });
    return hits;
  }

  private async semanticSearch(input: {
    workspaceId: string;
    query: string;
    embedding: number[];
    sourceIds: string[] | null;
    limit: number;
    minScore?: number;
  }) {
    aiAgentsDebug.log('knowledge.semantic', 'query start', {
      workspaceId: input.workspaceId,
      query: input.query,
      embedding: input.embedding,
      sourceIds: input.sourceIds,
      limit: input.limit,
      minScore: input.minScore,
    });
    const vector = `[${input.embedding.map((value) => Number(value).toFixed(8)).join(',')}]`;
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          c."id",
          c."source_id" AS "sourceId",
          c."title",
          c."content",
          c."metadata",
          1 - (c."embedding" <=> $2::vector) AS "score"
        FROM "ai_knowledge_chunks" c
        JOIN "ai_knowledge_sources" s ON s."id" = c."source_id"
        WHERE c."workspace_id" = $1::uuid
          AND s."workspace_id" = $1::uuid
          AND s."status" IN ('ready', 'completed', 'partial_success')
          AND s."deleted_at" IS NULL
          AND c."embedding" IS NOT NULL
          AND ($3::uuid[] IS NULL OR c."source_id" = ANY($3::uuid[]))
        ORDER BY c."embedding" <=> $2::vector
        LIMIT $4
      `,
      input.workspaceId,
      vector,
      input.sourceIds,
      input.limit,
    );

    const hits = rows
      .map((row) => this.toKnowledgeHit(row))
      .filter((hit) => hit.score >= (input.minScore ?? 0.6));
    aiAgentsDebug.log('knowledge.semantic', 'query result', {
      workspaceId: input.workspaceId,
      rowCount: rows.length,
      returnedCount: hits.length,
      hits,
    });
    return hits;
  }

  private async lexicalSearch(input: {
    workspaceId: string;
    query: string;
    sourceIds: string[] | null;
    limit: number;
    minScore?: number;
  }) {
    aiAgentsDebug.log('knowledge.lexical', 'query start', {
      workspaceId: input.workspaceId,
      query: input.query,
      sourceIds: input.sourceIds,
      limit: input.limit,
      minScore: input.minScore,
    });
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          c."id",
          c."source_id" AS "sourceId",
          c."title",
          c."content",
          c."metadata",
          ts_rank_cd(c."search_text", plainto_tsquery('simple', $2)) AS "score"
        FROM "ai_knowledge_chunks" c
        JOIN "ai_knowledge_sources" s ON s."id" = c."source_id"
        WHERE c."workspace_id" = $1::uuid
          AND s."workspace_id" = $1::uuid
          AND s."status" IN ('ready', 'completed', 'partial_success')
          AND s."deleted_at" IS NULL
          AND ($3::uuid[] IS NULL OR c."source_id" = ANY($3::uuid[]))
          AND (
            c."search_text" @@ plainto_tsquery('simple', $2)
            OR c."content" ILIKE '%' || $2 || '%'
            OR c."title" ILIKE '%' || $2 || '%'
          )
        ORDER BY "score" DESC, c."updated_at" DESC
        LIMIT $4
      `,
      input.workspaceId,
      input.query,
      input.sourceIds,
      input.limit,
    );

    const hits = rows
      .map((row) => this.toKnowledgeHit(row))
      .filter((hit) => hit.score >= (input.minScore ?? 0));
    aiAgentsDebug.log('knowledge.lexical', 'query result', {
      workspaceId: input.workspaceId,
      rowCount: rows.length,
      returnedCount: hits.length,
      hits,
    });
    return hits;
  }

  private async getSourceRow(workspaceId: string, sourceId: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        SELECT
          s.*,
          m."url" AS "asset_url",
          m."key" AS "asset_key",
          m."mimeType" AS "asset_mime_type",
          m."filename" AS "asset_filename",
          m."size" AS "asset_size"
        FROM "ai_knowledge_sources" s
        LEFT JOIN "MediaAsset" m ON m."id" = s."file_asset_id"
        WHERE s."workspace_id" = $1::uuid
          AND s."id" = $2::uuid
          AND s."deleted_at" IS NULL
        LIMIT 1
      `,
      workspaceId,
      sourceId,
    );
    return rows[0] || null;
  }

  private async markSourceIndexing(workspaceId: string, sourceId: string) {
    aiAgentsDebug.log('knowledge.ingest.db', 'mark indexing', { workspaceId, sourceId });
    return this.markSourceStatus(workspaceId, sourceId, 'indexing', {});
  }

  private async markSourceStatus(
    workspaceId: string,
    sourceId: string,
    status: KnowledgeSourceStatus,
    progress: Record<string, any>,
  ) {
    const databaseStatus = await this.toDatabaseSourceStatus(status);
    aiAgentsDebug.log('knowledge.ingest.db', 'mark status', {
      workspaceId,
      sourceId,
      status,
      databaseStatus,
      progress,
    });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_knowledge_sources"
        SET "status" = $3,
            "updated_at" = CURRENT_TIMESTAMP,
            "import_config" = jsonb_set(
              "import_config" - 'lastError',
              '{progress}',
              $4::jsonb,
              true
            )
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
          AND "deleted_at" IS NULL
      `,
      workspaceId,
      sourceId,
      databaseStatus,
      JSON.stringify({
        status,
        databaseStatus,
        ...progress,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  private async markSourceComplete(
    workspaceId: string,
    sourceId: string,
    status: 'completed' | 'partial_success',
    metadata: Record<string, any>,
  ) {
    const databaseStatus = await this.toDatabaseSourceStatus(status);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
        UPDATE "ai_knowledge_sources"
        SET "status" = $3,
            "checksum" = $4,
            "last_indexed_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP,
            "import_config" = jsonb_set(
              jsonb_set(
                "import_config" - 'lastError',
                '{lastIngest}',
                $5::jsonb,
                true
              ),
              '{progress}',
              $5::jsonb,
              true
            )
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
        RETURNING *
      `,
      workspaceId,
      sourceId,
      databaseStatus,
      metadata.checksum || null,
      JSON.stringify({
        status,
        databaseStatus,
        ...metadata,
        completedAt: new Date().toISOString(),
      }),
    );
    return rows[0];
  }

  private async markSourceFailed(workspaceId: string, sourceId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "ai_knowledge_sources"
        SET "status" = 'failed',
            "updated_at" = CURRENT_TIMESTAMP,
            "import_config" = jsonb_set(
              jsonb_set(
                "import_config",
                '{lastError}',
                $3::jsonb,
                true
              ),
              '{progress}',
              $4::jsonb,
              true
            )
        WHERE "workspace_id" = $1::uuid
          AND "id" = $2::uuid
      `,
      workspaceId,
      sourceId,
      JSON.stringify({
        message,
        at: new Date().toISOString(),
      }),
      JSON.stringify({
        status: 'failed',
        failedAt: new Date().toISOString(),
        message,
      }),
    );
  }

  private async extractDocuments(source: any): Promise<{ documents: KnowledgeDocument[]; stats?: CrawlStats }> {
    aiAgentsDebug.log('knowledge.ingest.extract', 'start', {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      sourceType: source.source_type,
      uri: source.uri,
      fileAssetId: source.file_asset_id,
      importConfig: source.import_config,
      crawlerConfig: source.crawler_config,
    });

    if (source.source_type === 'website') {
      return this.extractWebsiteDocuments(source);
    }

    if (source.source_type === 'file') {
      return { documents: await this.extractFileDocuments(source) };
    }

    const docs = this.extractStructuredDocuments(source);
    if (docs.length) return { documents: docs };

    if (source.uri) {
      const text = await this.fetchText(source.uri);
      return { documents: [{
        title: source.name,
        content: this.normalizeText(text),
        metadata: { sourceType: source.source_type, uri: source.uri },
      }].filter((doc) => doc.content.length > 0) };
    }

    throw new BadRequestException('Knowledge source has no ingestible content');
  }

  private extractStructuredDocuments(source: any): KnowledgeDocument[] {
    const config = source.import_config || {};
    const docs: KnowledgeDocument[] = [];

    for (const key of ['text', 'content', 'markdown', 'body']) {
      if (typeof config[key] === 'string' && config[key].trim()) {
        docs.push({
          title: config.title || source.name,
          content: this.normalizeText(config[key]),
          metadata: { sourceType: source.source_type, importKey: key },
        });
      }
    }

    if (typeof config.html === 'string' && config.html.trim()) {
      docs.push({
        title: config.title || source.name,
        content: this.htmlToText(config.html),
        metadata: { sourceType: source.source_type, importKey: 'html' },
      });
    }

    const faqs = Array.isArray(config.faqs) ? config.faqs : Array.isArray(config.questions) ? config.questions : [];
    for (const [index, item] of faqs.entries()) {
      const question = item?.question || item?.q || item?.title || '';
      const answer = item?.answer || item?.a || item?.content || '';
      const content = this.normalizeText([question, answer].filter(Boolean).join('\n\n'));
      if (!content) continue;
      docs.push({
        title: question || `${source.name} FAQ ${index + 1}`,
        content,
        metadata: { sourceType: source.source_type, itemType: 'faq', index },
      });
    }

    const arrays = [config.items, config.products, config.rows, config.records].filter(Array.isArray) as any[][];
    for (const items of arrays) {
      for (const [index, item] of items.entries()) {
        const title = item?.name || item?.title || item?.sku || `${source.name} item ${index + 1}`;
        const content = this.normalizeText(
          Object.entries(item || {})
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
            .join('\n'),
        );
        if (!content) continue;
        docs.push({
          title: String(title),
          content,
          metadata: { sourceType: source.source_type, itemType: 'record', index },
        });
      }
    }

    return docs.filter((doc) => doc.content.length > 0);
  }

  private async extractWebsiteDocuments(source: any): Promise<{ documents: KnowledgeDocument[]; stats: CrawlStats }> {
    const result = await this.crawler.crawl(source, (stats) =>
      this.markSourceStatus(source.workspace_id, source.id, 'fetching', this.progressFromCrawlStats(stats)),
    );
    if (!result.documents.length) throw new BadRequestException('Website crawl did not produce text content');
    return result;
  }

  private async extractFileDocuments(source: any): Promise<KnowledgeDocument[]> {
    if (!source.file_asset_id) throw new BadRequestException('File knowledge source requires fileAssetId');
    if (!source.asset_key && !source.asset_url) throw new BadRequestException('File asset has no R2 key or URL');

    const buffer = await this.readAssetBuffer(source);
    const mimeType = source.asset_mime_type || 'application/octet-stream';
    const filename = source.asset_filename || source.name;
    const content = this.extractTextFromBuffer(buffer, mimeType, filename);

    if (!content) {
      throw new BadRequestException(`No text could be extracted from file ${filename}`);
    }

    return [{
      title: filename || source.name,
      content,
      metadata: {
        sourceType: 'file',
        fileAssetId: source.file_asset_id,
        filename,
        mimeType,
        size: source.asset_size,
      },
    }];
  }

  private progressFromCrawlStats(stats: CrawlStats) {
    return {
      queuedPages: stats.queuedPages,
      fetchedPages: stats.fetchedPages,
      extractedPages: stats.extractedPages,
      skippedPages: stats.skippedPages,
      skippedAssets: stats.skippedAssets,
      failedPages: stats.failedPages,
      duplicateUrls: stats.duplicateUrls,
      invalidContentTypes: stats.invalidContentTypes,
      totalCharsExtracted: stats.totalCharsExtracted,
      recentPages: stats.pageResults.slice(-10),
    };
  }

  private async readAssetBuffer(source: any) {
    const keyOrUrl = source.asset_key || source.asset_url;
    try {
      const stream = await this.r2.getObjectStream(keyOrUrl);
      return this.streamToBuffer(stream);
    } catch (error) {
      aiAgentsDebug.error('knowledge.ingest.extract', 'R2 read failed; attempting public URL fallback', error, {
        workspaceId: source.workspace_id,
        sourceId: source.id,
        keyOrUrl,
        assetUrl: source.asset_url,
      });
      if (!source.asset_url) throw error;
      const response = await fetch(source.asset_url);
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching file asset`);
      return Buffer.from(await response.arrayBuffer());
    }
  }

  private extractTextFromBuffer(buffer: Buffer, mimeType: string, filename: string) {
    const lowerName = (filename || '').toLowerCase();
    const lowerMime = (mimeType || '').toLowerCase();

    if (lowerMime.includes('csv') || lowerName.endsWith('.csv')) {
      return this.csvToText(buffer.toString('utf8'));
    }

    if (lowerMime.includes('json') || lowerName.endsWith('.json')) {
      return this.jsonToText(buffer.toString('utf8'));
    }

    if (lowerMime.includes('html') || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
      return this.htmlToText(buffer.toString('utf8'));
    }

    if (lowerName.endsWith('.docx') || lowerMime.includes('wordprocessingml')) {
      return this.extractDocxText(buffer);
    }

    if (lowerName.endsWith('.xlsx') || lowerMime.includes('spreadsheetml')) {
      return this.extractXlsxText(buffer);
    }

    if (lowerName.endsWith('.pdf') || lowerMime.includes('pdf')) {
      return this.extractPdfText(buffer);
    }

    return this.normalizeText(buffer.toString('utf8'));
  }

  private chunkDocuments(documents: KnowledgeDocument[]) {
    return KnowledgeSmartChunker.chunk(documents);
  }

  private async embedChunkSafe(workspaceId: string, sourceId: string, source: any, chunk: KnowledgeChunkInput) {
    return this.embedTextSafe(workspaceId, sourceId, chunk.content, `chunk:${chunk.chunkIndex}`, source);
  }

  private async embedTextSafe(workspaceId: string, sourceId: string, text: string, itemId: string, source?: any) {
    if (process.env.AI_KNOWLEDGE_EMBEDDINGS_ENABLED === 'false') return null;

    try {
      const embedded = await this.gateway.embed({
        workspaceId,
        text,
        provider: source?.embedding_provider,
        model: source?.embedding_model,
      });
      if (embedded.dim !== 1536) {
        aiAgentsDebug.warn('knowledge.ingest.embed', 'embedding dimension unsupported for vector(1536); storing lexical-only chunk', {
          workspaceId,
          sourceId,
          itemId,
          provider: embedded.provider,
          model: embedded.model,
          dim: embedded.dim,
        });
        return embedded;
      }
      return embedded;
    } catch (error) {
      aiAgentsDebug.error('knowledge.ingest.embed', 'embedding failed; storing lexical-only chunk', error, {
        workspaceId,
        sourceId,
        itemId,
      });
      return null;
    }
  }

  private async insertChunk(input: {
    workspaceId: string;
    sourceId: string;
    source: any;
    chunk: KnowledgeChunkInput;
    embedding: { provider: string; model: string; embedding: number[]; dim: number } | null;
  }) {
    const vector = input.embedding?.dim === 1536 ? this.toVectorLiteral(input.embedding.embedding) : null;
    const schema = await this.getKnowledgeSchemaCapabilities();
    const values: Array<{ column: string; value?: unknown; cast?: string; raw?: string }> = [
      { column: 'workspace_id', value: input.workspaceId, cast: 'uuid' },
      { column: 'source_id', value: input.sourceId, cast: 'uuid' },
      { column: 'chunk_index', value: input.chunk.chunkIndex },
      { column: 'title', value: input.chunk.title },
      { column: 'content', value: input.chunk.content },
      { column: 'content_hash', value: input.chunk.contentHash },
      { column: 'metadata', value: JSON.stringify(input.chunk.metadata || {}), cast: 'jsonb' },
      { column: 'token_count', value: input.chunk.tokenCount },
      { column: 'embedding_provider', value: input.embedding?.provider || input.source.embedding_provider || process.env.AI_EMBEDDING_PROVIDER || 'openai' },
      { column: 'embedding_model', value: input.embedding?.model || input.source.embedding_model || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small' },
      { column: 'embedding_dim', value: input.embedding?.dim || input.source.embedding_dim || 1536 },
      { column: 'embedding', value: vector, cast: 'vector' },
    ];

    if (schema.chunkColumns.url) values.push({ column: 'url', value: input.chunk.url || null });
    if (schema.chunkColumns.canonicalUrl) values.push({ column: 'canonical_url', value: input.chunk.canonicalUrl || null });
    if (schema.chunkColumns.cleanText) values.push({ column: 'clean_text', value: input.chunk.cleanText || input.chunk.content });
    if (schema.chunkColumns.embeddingStatus) values.push({ column: 'embedding_status', value: input.chunk.embeddingStatus });
    if (schema.chunkColumns.lastCrawledAt) values.push({ column: 'last_crawled_at', raw: 'CURRENT_TIMESTAMP' });

    const params: unknown[] = [];
    const placeholders = values.map((entry) => {
      if (entry.raw) return entry.raw;
      params.push(entry.value);
      const index = params.length;
      return `$${index}${entry.cast ? `::${entry.cast}` : ''}`;
    });

    const updates = [
      '"title" = EXCLUDED."title"',
      '"content" = EXCLUDED."content"',
      '"content_hash" = EXCLUDED."content_hash"',
      '"metadata" = EXCLUDED."metadata"',
      '"token_count" = EXCLUDED."token_count"',
      '"embedding_provider" = EXCLUDED."embedding_provider"',
      '"embedding_model" = EXCLUDED."embedding_model"',
      '"embedding_dim" = EXCLUDED."embedding_dim"',
      '"embedding" = EXCLUDED."embedding"',
    ];

    if (schema.chunkColumns.url) updates.push('"url" = EXCLUDED."url"');
    if (schema.chunkColumns.canonicalUrl) updates.push('"canonical_url" = EXCLUDED."canonical_url"');
    if (schema.chunkColumns.cleanText) updates.push('"clean_text" = EXCLUDED."clean_text"');
    if (schema.chunkColumns.embeddingStatus) updates.push('"embedding_status" = EXCLUDED."embedding_status"');
    if (schema.chunkColumns.lastCrawledAt) updates.push('"last_crawled_at" = EXCLUDED."last_crawled_at"');
    updates.push('"updated_at" = CURRENT_TIMESTAMP');

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO "ai_knowledge_chunks"
          (${values.map((entry) => `"${entry.column}"`).join(', ')})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT ("source_id", "chunk_index")
        DO UPDATE SET
          ${updates.join(',\n          ')}
      `,
      ...params,
    );
  }

  private async getKnowledgeSchemaCapabilities() {
    if (!this.knowledgeSchemaCapabilitiesPromise) {
      this.knowledgeSchemaCapabilitiesPromise = this.loadKnowledgeSchemaCapabilities().catch((error) => {
        this.knowledgeSchemaCapabilitiesPromise = undefined;
        throw error;
      });
    }

    return this.knowledgeSchemaCapabilitiesPromise;
  }

  private async loadKnowledgeSchemaCapabilities(): Promise<KnowledgeSchemaCapabilities> {
    const [statusConstraintRows, chunkColumnRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ definition: string }>>(
        `
          SELECT pg_get_constraintdef(c.oid) AS "definition"
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'ai_knowledge_sources'
            AND c.conname = 'ai_knowledge_sources_status_check'
          LIMIT 1
        `,
      ),
      this.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `
          SELECT "column_name"
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ai_knowledge_chunks'
            AND column_name IN ('url', 'canonical_url', 'clean_text', 'embedding_status', 'last_crawled_at')
        `,
      ),
    ]);

    const definition = String(statusConstraintRows[0]?.definition || '');
    const chunkColumns = new Set(chunkColumnRows.map((row) => row.column_name));
    const capabilities: KnowledgeSchemaCapabilities = {
      extendedSourceStatuses: definition.includes("'queued'")
        || definition.includes("'fetching'")
        || definition.includes("'completed'")
        || definition.includes("'partial_success'"),
      chunkColumns: {
        url: chunkColumns.has('url'),
        canonicalUrl: chunkColumns.has('canonical_url'),
        cleanText: chunkColumns.has('clean_text'),
        embeddingStatus: chunkColumns.has('embedding_status'),
        lastCrawledAt: chunkColumns.has('last_crawled_at'),
      },
    };

    aiAgentsDebug.log('knowledge.schema', 'capabilities detected', capabilities);
    return capabilities;
  }

  private async toDatabaseSourceStatus(status: KnowledgeSourceStatus): Promise<KnowledgeSourceStatus> {
    const schema = await this.getKnowledgeSchemaCapabilities();
    if (schema.extendedSourceStatuses) return status;

    switch (status) {
      case 'queued':
        return 'pending';
      case 'fetching':
      case 'extracting':
      case 'embedding':
      case 'indexing':
        return 'indexing';
      case 'completed':
      case 'partial_success':
        return 'ready';
      default:
        return status;
    }
  }

  private async fetchText(url: string) {
    const timeoutMs = Number(process.env.AI_KNOWLEDGE_FETCH_TIMEOUT_MS || 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      aiAgentsDebug.log('knowledge.fetch', 'start', { url, timeoutMs });
      const response = await fetch(url, {
        headers: { 'User-Agent': process.env.AI_KNOWLEDGE_USER_AGENT || 'AxodeskAIKnowledgeBot/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
      const contentType = KnowledgeContentType.validate(response.headers.get('content-type'));
      if (!contentType.allowed) {
        throw new BadRequestException(`Unsupported knowledge source content type: ${contentType.reason}`);
      }
      const text = KnowledgeTextSanitizer.sanitize(await response.text());
      if (KnowledgeTextSanitizer.isProbablyBinary(text)) {
        throw new BadRequestException('Knowledge source returned binary-looking content');
      }
      aiAgentsDebug.log('knowledge.fetch', 'result', { url, status: response.status, chars: text.length });
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractHtmlTitle(html: string) {
    return this.decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || null;
  }

  private extractLinks(html: string, baseUrl: string) {
    const links = new Set<string>();
    const regex = /href\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      try {
        const url = new URL(href, baseUrl);
        url.hash = '';
        if (url.protocol === 'http:' || url.protocol === 'https:') links.add(url.toString());
      } catch {
        // Ignore malformed links from customer websites.
      }
    }
    return [...links];
  }

  private htmlToText(html: string) {
    return this.normalizeText(
      this.decodeEntities(
        html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, ' '),
      ),
    );
  }

  private csvToText(csv: string) {
    try {
      const records = parseCsv(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
      return this.normalizeText(
        records
          .map((row: Record<string, any>, index: number) => [
            `Row ${index + 1}`,
            ...Object.entries(row).map(([key, value]) => `${key}: ${value}`),
          ].join('\n'))
          .join('\n\n'),
      );
    } catch {
      return this.normalizeText(csv);
    }
  }

  private jsonToText(jsonText: string) {
    try {
      const value = JSON.parse(jsonText);
      return this.normalizeText(JSON.stringify(value, null, 2));
    } catch {
      return this.normalizeText(jsonText);
    }
  }

  private extractDocxText(buffer: Buffer) {
    const files = this.readZipEntries(buffer);
    const xmlFiles = Object.entries(files)
      .filter(([name]) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name))
      .map(([, content]) => content.toString('utf8'));

    return this.xmlToText(xmlFiles.join('\n'));
  }

  private extractXlsxText(buffer: Buffer) {
    const files = this.readZipEntries(buffer);
    const sharedStrings = this.extractXmlTextItems(files['xl/sharedStrings.xml']?.toString('utf8') || '');
    const sheetTexts = Object.entries(files)
      .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .map(([, content]) => {
        const xml = content.toString('utf8');
        return xml.replace(/<v>(\d+)<\/v>/g, (_match, index) => sharedStrings[Number(index)] || index);
      });

    return this.xmlToText(sheetTexts.join('\n'));
  }

  private extractPdfText(buffer: Buffer) {
    const text = buffer.toString('latin1');
    const strings = [...text.matchAll(/\(([^()]{2,})\)/g)]
      .map((match) => match[1])
      .filter((value) => /[a-z0-9]/i.test(value));

    if (strings.length) return this.normalizeText(strings.join(' '));
    return this.normalizeText(text.replace(/[^\x20-\x7E\n\r\t]/g, ' '));
  }

  private readZipEntries(buffer: Buffer) {
    const files: Record<string, Buffer> = {};
    const eocdOffset = this.findSignatureReverse(buffer, 0x06054b50);
    if (eocdOffset < 0) return files;

    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
    let offset = centralDirOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const fileNameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localHeaderOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');

      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);

      if (method === 0) files[name] = compressed;
      else if (method === 8) files[name] = inflateRawSync(compressed);

      offset += 46 + fileNameLength + extraLength + commentLength;
    }

    return files;
  }

  private findSignatureReverse(buffer: Buffer, signature: number) {
    for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
      if (buffer.readUInt32LE(offset) === signature) return offset;
    }
    return -1;
  }

  private xmlToText(xml: string) {
    return this.normalizeText(
      this.decodeEntities(
        xml
          .replace(/<w:tab\/>/g, '\t')
          .replace(/<\/w:p>/g, '\n')
          .replace(/<[^>]+>/g, ' '),
      ),
    );
  }

  private extractXmlTextItems(xml: string) {
    const items = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => this.decodeEntities(match[1]));
    return items;
  }

  private decodeEntities(text: string) {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
  }

  private normalizeText(text: string) {
    return KnowledgeTextSanitizer.sanitize(text);
  }

  private estimateTokens(text: string) {
    return Math.max(1, Math.ceil((text || '').length / 4));
  }

  private hashText(text: string) {
    return createHash('sha256').update(text).digest('hex');
  }

  private toVectorLiteral(embedding: number[]) {
    return `[${embedding.map((value) => Number(value).toFixed(8)).join(',')}]`;
  }

  private async streamToBuffer(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private toKnowledgeHit(row: any): KnowledgeHit {
    return {
      id: row.id,
      sourceId: row.sourceId,
      title: row.title,
      content: row.content,
      score: Number(row.score || 0),
      metadata: row.metadata || {},
    };
  }

  private toSourceDto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      sourceType: row.source_type,
      status: row.status,
      uri: row.uri,
      fileAssetId: row.file_asset_id,
      crawlerConfig: row.crawler_config || {},
      importConfig: row.import_config || {},
      progress: row.import_config?.progress || row.import_config?.lastIngest || null,
      lastIndexedAt: row.last_indexed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
