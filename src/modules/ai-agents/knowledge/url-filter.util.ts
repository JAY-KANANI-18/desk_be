const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.css',
  '.js',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mp3',
  '.zip',
  '.rar',
  '.pdf',
]);

const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_/i, /^igshid$/i, /^ref$/i];

export interface UrlDecision {
  allowed: boolean;
  url?: string;
  canonicalUrl?: string;
  reason?: string;
}

export class KnowledgeUrlFilter {
  static canonicalHost(host: string) {
    return host.toLowerCase().replace(/^www\./, '');
  }

  static normalize(input: string, baseUrl?: string): UrlDecision {
    try {
      const parsed = new URL(input, baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { allowed: false, reason: 'unsupported_protocol' };
      }

      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      parsed.hostname = parsed.hostname.toLowerCase();

      for (const key of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
          parsed.searchParams.delete(key);
        }
      }

      parsed.searchParams.sort();
      parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
      if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, '');

      const canonical = new URL(parsed.toString());
      canonical.hostname = this.canonicalHost(canonical.hostname);
      if (canonical.pathname === '/') canonical.pathname = '';

      return {
        allowed: true,
        url: parsed.toString(),
        canonicalUrl: canonical.toString(),
      };
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }
  }

  static shouldCrawl(input: string, rootUrl: string, baseUrl?: string, sameOriginOnly = true): UrlDecision {
    const normalized = this.normalize(input, baseUrl);
    if (!normalized.allowed || !normalized.url || !normalized.canonicalUrl) return normalized;

    const url = new URL(normalized.url);
    const root = new URL(rootUrl);
    if (sameOriginOnly && this.canonicalHost(url.hostname) !== this.canonicalHost(root.hostname)) {
      return { ...normalized, allowed: false, reason: 'off_domain' };
    }

    const path = decodeURIComponent(url.pathname).toLowerCase();
    const extension = path.match(/\.[a-z0-9]{2,8}$/i)?.[0] || '';
    if (ASSET_EXTENSIONS.has(extension)) {
      return { ...normalized, allowed: false, reason: `asset_extension:${extension}` };
    }

    if (/(^|\/)(assets?|static|dist|build|fonts?|images?|img|media|uploads?|wp-content|cdn-cgi)(\/|$)/i.test(path)) {
      return { ...normalized, allowed: false, reason: 'asset_path' };
    }

    if (/(login|logout|signup|cart|checkout|account|privacy-policy-generator)/i.test(path)) {
      return { ...normalized, allowed: false, reason: 'low_value_path' };
    }

    return normalized;
  }
}
