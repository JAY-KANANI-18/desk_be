import { Injectable } from '@nestjs/common';
import { aiAgentsDebug } from '../ai-agents-debug.logger';
import { KnowledgeContentType } from './content-type.util';
import { KnowledgeReadabilityExtractor } from './readability-extractor.util';
import { KnowledgeDocument } from './smart-chunker.util';
import { KnowledgeTextSanitizer } from './text-sanitizer.util';
import { KnowledgeUrlFilter } from './url-filter.util';

interface RobotsRules {
  disallow: string[];
}

export interface CrawlStats {
  queuedPages: number;
  fetchedPages: number;
  extractedPages: number;
  skippedPages: number;
  skippedAssets: number;
  failedPages: number;
  duplicateUrls: number;
  invalidContentTypes: number;
  totalCharsExtracted: number;
  pageResults: Array<Record<string, any>>;
}

@Injectable()
export class KnowledgeCrawlerService {
  async crawl(
    source: any,
    onProgress?: (stats: CrawlStats) => Promise<void> | void,
  ): Promise<{ documents: KnowledgeDocument[]; stats: CrawlStats }> {
    if (!source.uri) throw new Error('Website knowledge source requires uri');

    const config = source.crawler_config || {};
    const maxPages = Math.max(1, Math.min(Number(config.maxPages || process.env.AI_KNOWLEDGE_CRAWL_MAX_PAGES || 30), 200));
    const concurrency = Math.max(1, Math.min(Number(config.concurrency || process.env.AI_KNOWLEDGE_CRAWL_CONCURRENCY || 4), 10));
    const sameOriginOnly = config.sameOriginOnly !== false;
    const respectRobots = Boolean(config.respectRobots || process.env.AI_KNOWLEDGE_RESPECT_ROBOTS === 'true');

    const rootDecision = KnowledgeUrlFilter.shouldCrawl(source.uri, source.uri, undefined, false);
    if (!rootDecision.allowed || !rootDecision.url || !rootDecision.canonicalUrl) {
      throw new Error(`Invalid website URL: ${rootDecision.reason || 'unknown'}`);
    }

    const rootUrl = rootDecision.url;
    const robots = respectRobots ? await this.loadRobots(rootUrl) : { disallow: [] };
    const pending: string[] = [rootUrl];
    const visited = new Set<string>();
    const queued = new Set<string>([rootDecision.canonicalUrl]);
    const documents: KnowledgeDocument[] = [];
    const contentHashes = new Set<string>();
    const stats: CrawlStats = {
      queuedPages: 1,
      fetchedPages: 0,
      extractedPages: 0,
      skippedPages: 0,
      skippedAssets: 0,
      failedPages: 0,
      duplicateUrls: 0,
      invalidContentTypes: 0,
      totalCharsExtracted: 0,
      pageResults: [],
    };

    aiAgentsDebug.log('knowledge.crawler', 'crawl start', {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      rootUrl,
      maxPages,
      concurrency,
      sameOriginOnly,
      respectRobots,
    });

    const worker = async () => {
      while (pending.length && documents.length < maxPages) {
        const url = pending.shift();
        if (!url) return;

        const decision = KnowledgeUrlFilter.shouldCrawl(url, rootUrl, undefined, sameOriginOnly);
        if (!decision.allowed || !decision.url || !decision.canonicalUrl) {
          if (decision.reason?.startsWith('asset_') || decision.reason?.startsWith('asset_extension')) {
            stats.skippedAssets += 1;
          }
          this.recordSkip(stats, url, decision.reason || 'url_rejected');
          await this.emitProgress(onProgress, stats);
          continue;
        }

        if (visited.has(decision.canonicalUrl)) {
          stats.duplicateUrls += 1;
          this.recordSkip(stats, decision.url, 'duplicate_canonical_url', decision.canonicalUrl);
          await this.emitProgress(onProgress, stats);
          continue;
        }

        if (this.isRobotsBlocked(decision.url, robots)) {
          this.recordSkip(stats, decision.url, 'robots_disallow', decision.canonicalUrl);
          await this.emitProgress(onProgress, stats);
          continue;
        }

        visited.add(decision.canonicalUrl);

        const page = await this.fetchPage(decision.url, source);
        if (page.ok === false) {
          if (page.reason?.startsWith('asset_')) stats.skippedAssets += 1;
          if (page.reason?.startsWith('invalid_content_type') || page.reason?.startsWith('unsupported_type')) {
            stats.invalidContentTypes += 1;
          }
          if (page.reason === 'fetch_error' || page.reason?.startsWith('http_')) {
            stats.failedPages += 1;
          }
          this.recordSkip(stats, decision.url, page.reason || 'fetch_failed', decision.canonicalUrl);
          await this.emitProgress(onProgress, stats);
          continue;
        }

        stats.fetchedPages += 1;
        const extracted = page.contentType === 'text/html'
          ? KnowledgeReadabilityExtractor.extract(page.text)
          : {
              title: null,
              text: KnowledgeTextSanitizer.sanitize(page.text),
              chars: KnowledgeTextSanitizer.sanitize(page.text).length,
              lineCount: KnowledgeTextSanitizer.sanitize(page.text).split('\n').length,
            };

        if (!extracted.text || extracted.chars < Number(process.env.AI_KNOWLEDGE_MIN_PAGE_CHARS || 120)) {
          this.recordSkip(stats, decision.url, 'low_text_yield', decision.canonicalUrl, { chars: extracted.chars });
          await this.emitProgress(onProgress, stats);
          continue;
        }

        const stableHash = this.hashComparable(extracted.text);
        if (contentHashes.has(stableHash)) {
          stats.duplicateUrls += 1;
          this.recordSkip(stats, decision.url, 'duplicate_content', decision.canonicalUrl, { chars: extracted.chars });
          await this.emitProgress(onProgress, stats);
          continue;
        }
        contentHashes.add(stableHash);

        documents.push({
          title: extracted.title || source.name,
          content: extracted.text,
          url: decision.url,
          canonicalUrl: decision.canonicalUrl,
          metadata: {
            sourceType: 'website',
            url: decision.url,
            canonicalUrl: decision.canonicalUrl,
            contentType: page.contentType,
            status: page.status,
            chars: extracted.chars,
            lineCount: extracted.lineCount,
          },
        });
        stats.extractedPages += 1;
        stats.totalCharsExtracted += extracted.chars;
        stats.pageResults.push({
          url: decision.url,
          canonicalUrl: decision.canonicalUrl,
          status: 'extracted',
          chars: extracted.chars,
          title: extracted.title,
        });

        aiAgentsDebug.log('knowledge.crawler', 'page extracted', {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          url: decision.url,
          canonicalUrl: decision.canonicalUrl,
          chars: extracted.chars,
          title: extracted.title,
        });
        await this.emitProgress(onProgress, stats);

        if (page.contentType === 'text/html') {
          for (const link of this.extractLinks(page.text, decision.url)) {
            if (documents.length + pending.length >= maxPages) break;
            const linkDecision = KnowledgeUrlFilter.shouldCrawl(link, rootUrl, decision.url, sameOriginOnly);
            if (!linkDecision.allowed || !linkDecision.url || !linkDecision.canonicalUrl) {
              if (linkDecision.reason?.startsWith('asset_') || linkDecision.reason?.startsWith('asset_extension')) {
                stats.skippedAssets += 1;
              }
              continue;
            }
            if (visited.has(linkDecision.canonicalUrl) || queued.has(linkDecision.canonicalUrl)) {
              stats.duplicateUrls += 1;
              continue;
            }
            queued.add(linkDecision.canonicalUrl);
            pending.push(linkDecision.url);
            stats.queuedPages += 1;
          }
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    aiAgentsDebug.log('knowledge.crawler', 'crawl result', {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      stats,
      documentCount: documents.length,
    });

    return { documents, stats };
  }

  private async fetchPage(url: string, source: any): Promise<
    | { ok: true; status: number; contentType: string; text: string }
    | { ok: false; reason: string; status?: number; contentType?: string }
  > {
    const timeoutMs = Number(source.crawler_config?.timeoutMs || process.env.AI_KNOWLEDGE_FETCH_TIMEOUT_MS || 15000);
    const retries = Math.max(0, Number(source.crawler_config?.retries ?? process.env.AI_KNOWLEDGE_FETCH_RETRIES ?? 1));
    const maxBytes = Number(source.crawler_config?.maxPageBytes || process.env.AI_KNOWLEDGE_MAX_PAGE_BYTES || 1_500_000);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        aiAgentsDebug.log('knowledge.crawler.fetch', 'start', { url, attempt: attempt + 1, maxAttempts: retries + 1, timeoutMs });
        const response = await fetch(url, {
          headers: { 'User-Agent': process.env.AI_KNOWLEDGE_USER_AGENT || 'AxodeskAIKnowledgeBot/1.0' },
          redirect: 'follow',
          signal: controller.signal,
        });

        const contentType = KnowledgeContentType.validate(response.headers.get('content-type'));
        if (!contentType.allowed) {
          aiAgentsDebug.log('knowledge.crawler.fetch', 'skipped content type', {
            url,
            status: response.status,
            contentType: contentType.normalizedType,
            reason: contentType.reason,
          });
          return {
            ok: false,
            status: response.status,
            contentType: contentType.normalizedType,
            reason: `invalid_content_type:${contentType.reason}`,
          };
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength && contentLength > maxBytes) {
          return { ok: false, status: response.status, contentType: contentType.normalizedType, reason: 'page_too_large' };
        }

        if (!response.ok) {
          return { ok: false, status: response.status, contentType: contentType.normalizedType, reason: `http_${response.status}` };
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) {
          return { ok: false, status: response.status, contentType: contentType.normalizedType, reason: 'page_too_large' };
        }

        const text = KnowledgeTextSanitizer.sanitize(Buffer.from(arrayBuffer).toString('utf8'));
        if (KnowledgeTextSanitizer.isProbablyBinary(text)) {
          return { ok: false, status: response.status, contentType: contentType.normalizedType, reason: 'binary_content_detected' };
        }

        aiAgentsDebug.log('knowledge.crawler.fetch', 'success', {
          url,
          status: response.status,
          contentType: contentType.normalizedType,
          bytes: arrayBuffer.byteLength,
          chars: text.length,
          latencyMs: Date.now() - started,
        });

        return { ok: true, status: response.status, contentType: contentType.normalizedType, text };
      } catch (error) {
        aiAgentsDebug.error('knowledge.crawler.fetch', 'failed attempt', error, {
          url,
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          latencyMs: Date.now() - started,
        });
        if (attempt >= retries) return { ok: false, reason: 'fetch_error' };
      } finally {
        clearTimeout(timeout);
      }
    }

    return { ok: false, reason: 'fetch_error' };
  }

  private extractLinks(html: string, baseUrl: string) {
    const links = new Set<string>();
    const regex = /href\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      const href = match[1];
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
      try {
        links.add(new URL(href, baseUrl).toString());
      } catch {
        // Ignore malformed links.
      }
    }
    return [...links];
  }

  private async loadRobots(rootUrl: string): Promise<RobotsRules> {
    try {
      const root = new URL(rootUrl);
      const robotsUrl = `${root.origin}/robots.txt`;
      const response = await fetch(robotsUrl, {
        headers: { 'User-Agent': process.env.AI_KNOWLEDGE_USER_AGENT || 'AxodeskAIKnowledgeBot/1.0' },
      });
      if (!response.ok) return { disallow: [] };
      const text = await response.text();
      const disallow = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^disallow:/i.test(line))
        .map((line) => line.replace(/^disallow:/i, '').trim())
        .filter(Boolean);
      return { disallow };
    } catch {
      return { disallow: [] };
    }
  }

  private isRobotsBlocked(url: string, robots: RobotsRules) {
    if (!robots.disallow.length) return false;
    const path = new URL(url).pathname;
    return robots.disallow.some((rule) => rule !== '/' && path.startsWith(rule));
  }

  private recordSkip(stats: CrawlStats, url: string, reason: string, canonicalUrl?: string, extra?: Record<string, any>) {
    stats.skippedPages += 1;
    stats.pageResults.push({ url, canonicalUrl, status: 'skipped', reason, ...(extra || {}) });
    aiAgentsDebug.log('knowledge.crawler', 'page skipped', { url, canonicalUrl, reason, ...(extra || {}) });
  }

  private async emitProgress(onProgress: ((stats: CrawlStats) => Promise<void> | void) | undefined, stats: CrawlStats) {
    if (!onProgress) return;
    await onProgress({
      ...stats,
      pageResults: stats.pageResults.slice(-25),
    });
  }

  private hashComparable(text: string) {
    const stable = KnowledgeTextSanitizer.stableForHash(text);
    let hash = 0;
    for (let index = 0; index < stable.length; index += 1) {
      hash = (hash * 31 + stable.charCodeAt(index)) >>> 0;
    }
    return `${stable.slice(0, 1200)}:${hash}`;
  }
}
