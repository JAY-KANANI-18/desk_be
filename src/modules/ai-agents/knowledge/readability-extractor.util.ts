import { KnowledgeTextSanitizer } from './text-sanitizer.util';

export interface ReadabilityResult {
  title: string | null;
  text: string;
  chars: number;
  lineCount: number;
}

const REMOVE_BLOCK_PATTERNS = [
  /<script\b[\s\S]*?<\/script>/gi,
  /<style\b[\s\S]*?<\/style>/gi,
  /<noscript\b[\s\S]*?<\/noscript>/gi,
  /<svg\b[\s\S]*?<\/svg>/gi,
  /<canvas\b[\s\S]*?<\/canvas>/gi,
  /<iframe\b[\s\S]*?<\/iframe>/gi,
  /<form\b[\s\S]*?<\/form>/gi,
  /<nav\b[\s\S]*?<\/nav>/gi,
  /<footer\b[\s\S]*?<\/footer>/gi,
  /<aside\b[\s\S]*?<\/aside>/gi,
];

const BOILERPLATE_ATTR_PATTERN =
  /<(div|section|aside|header|footer|nav)[^>]*(?:class|id)=["'][^"']*(cookie|consent|banner|popup|modal|newsletter|subscribe|breadcrumb|sidebar|menu|navigation|footer|social|share|captcha|advert|ads|carousel)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

export class KnowledgeReadabilityExtractor {
  static extract(html: string): ReadabilityResult {
    const title = this.extractTitle(html);
    let body = this.extractBody(html);

    for (const pattern of REMOVE_BLOCK_PATTERNS) {
      body = body.replace(pattern, ' ');
    }

    body = body.replace(BOILERPLATE_ATTR_PATTERN, ' ');
    body = body
      .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) => `\n# ${this.toText(text)}\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, text) => `\n- ${this.toText(text)}\n`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|main|td|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    const lines = KnowledgeTextSanitizer.sanitize(this.decodeEntities(body))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => this.isUsefulLine(line));

    const deduped = this.removeRepeatedLines(lines);
    const text = KnowledgeTextSanitizer.sanitize(deduped.join('\n'));

    return {
      title,
      text,
      chars: text.length,
      lineCount: deduped.length,
    };
  }

  private static extractBody(html: string) {
    return html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
      || html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
      || html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
      || html;
  }

  private static extractTitle(html: string) {
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
      || null;

    return title ? KnowledgeTextSanitizer.sanitize(this.decodeEntities(this.toText(title))) : null;
  }

  private static toText(fragment: string) {
    return this.decodeEntities(fragment.replace(/<[^>]+>/g, ' '));
  }

  private static isUsefulLine(line: string) {
    if (!line || line.length < 3) return false;
    if (/^(home|menu|close|open|next|previous|read more|learn more|skip to content)$/i.test(line)) return false;
    if (/^(facebook|twitter|x|instagram|linkedin|youtube|whatsapp)$/i.test(line)) return false;
    return true;
  }

  private static removeRepeatedLines(lines: string[]) {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const seen = new Set<string>();
    return lines.filter((line) => {
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      if ((counts.get(key) || 0) > 3) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private static decodeEntities(text: string) {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
  }
}
