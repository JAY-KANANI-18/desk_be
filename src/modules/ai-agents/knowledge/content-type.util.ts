const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/ld+json',
];

const REJECTED_PREFIXES = ['image/', 'font/', 'audio/', 'video/'];

const REJECTED_CONTENT_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'text/css',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/zip',
  'application/x-rar-compressed',
];

export interface ContentTypeDecision {
  allowed: boolean;
  normalizedType: string;
  reason?: string;
}

export class KnowledgeContentType {
  static validate(rawContentType?: string | null): ContentTypeDecision {
    const normalizedType = String(rawContentType || '').split(';')[0].trim().toLowerCase();

    if (!normalizedType) {
      return { allowed: false, normalizedType, reason: 'missing_content_type' };
    }

    if (REJECTED_PREFIXES.some((prefix) => normalizedType.startsWith(prefix))) {
      return { allowed: false, normalizedType, reason: `rejected_prefix:${normalizedType}` };
    }

    if (REJECTED_CONTENT_TYPES.includes(normalizedType)) {
      return { allowed: false, normalizedType, reason: `rejected_type:${normalizedType}` };
    }

    if (!ALLOWED_CONTENT_TYPES.includes(normalizedType)) {
      return { allowed: false, normalizedType, reason: `unsupported_type:${normalizedType}` };
    }

    return { allowed: true, normalizedType };
  }
}
