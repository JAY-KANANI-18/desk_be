import { createHash } from 'crypto';
import { KnowledgeTextSanitizer } from './text-sanitizer.util';

export interface KnowledgeDocument {
  title: string | null;
  content: string;
  metadata: Record<string, any>;
  url?: string | null;
  canonicalUrl?: string | null;
}

export interface KnowledgeChunkInput {
  chunkIndex: number;
  title: string | null;
  content: string;
  cleanText: string;
  contentHash: string;
  tokenCount: number;
  metadata: Record<string, any>;
  url?: string | null;
  canonicalUrl?: string | null;
  embeddingStatus: 'pending' | 'embedded' | 'lexical_only' | 'failed';
}

export class KnowledgeSmartChunker {
  static chunk(documents: KnowledgeDocument[]) {
    const targetTokens = Number(process.env.AI_KNOWLEDGE_CHUNK_TARGET_TOKENS || 900);
    const maxTokens = Number(process.env.AI_KNOWLEDGE_CHUNK_MAX_TOKENS || 1200);
    const minTokens = Number(process.env.AI_KNOWLEDGE_CHUNK_MIN_TOKENS || 80);
    const overlapChars = Number(process.env.AI_KNOWLEDGE_CHUNK_OVERLAP_CHARS || 150);
    const chunks: KnowledgeChunkInput[] = [];
    const seenHashes = new Set<string>();
    const seenNearDuplicates = new Set<string>();

    for (const doc of documents) {
      const clean = KnowledgeTextSanitizer.sanitize(doc.content);
      if (!clean || KnowledgeTextSanitizer.isProbablyBinary(clean)) continue;

      for (const section of this.sections(clean, doc.title)) {
        const sectionChunks = this.splitSection(section.content, targetTokens, maxTokens, overlapChars);
        for (const content of sectionChunks) {
          const cleanText = KnowledgeTextSanitizer.sanitize(content);
          const tokenCount = this.estimateTokens(cleanText);
          if (tokenCount < minTokens && cleanText.length < 300) continue;

          const stable = KnowledgeTextSanitizer.stableForHash(cleanText);
          const contentHash = this.hash(`${section.title || doc.title || ''}\n${stable}`);
          const nearKey = stable.slice(0, 900);
          if (seenHashes.has(contentHash) || seenNearDuplicates.has(nearKey)) continue;
          seenHashes.add(contentHash);
          seenNearDuplicates.add(nearKey);

          chunks.push({
            chunkIndex: chunks.length,
            title: section.title || doc.title,
            content: cleanText,
            cleanText,
            contentHash,
            tokenCount,
            url: doc.url || doc.metadata?.url || null,
            canonicalUrl: doc.canonicalUrl || doc.metadata?.canonicalUrl || null,
            embeddingStatus: 'pending',
            metadata: {
              ...(doc.metadata || {}),
              sectionTitle: section.title || doc.title || null,
              chars: cleanText.length,
            },
          });
        }
      }
    }

    return chunks;
  }

  private static sections(text: string, fallbackTitle: string | null) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const sections: Array<{ title: string | null; content: string }> = [];
    let currentTitle = fallbackTitle;
    let current: string[] = [];

    const flush = () => {
      const content = KnowledgeTextSanitizer.sanitize(current.join('\n'));
      if (content) sections.push({ title: currentTitle, content });
      current = [];
    };

    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line)) {
        flush();
        currentTitle = line.replace(/^#{1,6}\s+/, '').trim() || fallbackTitle;
        current.push(line);
      } else {
        current.push(line);
      }
    }

    flush();
    return sections.length ? sections : [{ title: fallbackTitle, content: text }];
  }

  private static splitSection(section: string, targetTokens: number, maxTokens: number, overlapChars: number) {
    const paragraphs = section.split(/\n{2,}|\n(?=# )/).map((part) => part.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';

    for (const paragraph of paragraphs) {
      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (this.estimateTokens(candidate) <= targetTokens || !current) {
        current = candidate;
        if (this.estimateTokens(current) <= maxTokens) continue;
      }

      chunks.push(...this.forceSplit(current, maxTokens, overlapChars));
      current = paragraph;
    }

    if (current) chunks.push(...this.forceSplit(current, maxTokens, overlapChars));
    return chunks;
  }

  private static forceSplit(text: string, maxTokens: number, overlapChars: number) {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + maxChars, text.length);
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > offset + maxChars * 0.6) end = boundary;

      chunks.push(text.slice(offset, end).trim());
      if (end >= text.length) break;
      offset = Math.max(end - overlapChars, offset + 1);
    }
    return chunks;
  }

  private static estimateTokens(text: string) {
    return Math.max(1, Math.ceil((text || '').length / 4));
  }

  private static hash(text: string) {
    return createHash('sha256').update(text).digest('hex');
  }
}
