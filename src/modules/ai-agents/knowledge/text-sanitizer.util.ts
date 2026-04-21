export class KnowledgeTextSanitizer {
  static sanitize(input: string) {
    let text = String(input || '');

    try {
      text = text.normalize('NFKC');
    } catch {
      // Keep original text if the runtime cannot normalize a malformed string.
    }

    return text
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/\uFFFD/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static isProbablyBinary(input: string) {
    if (!input) return false;
    const sample = input.slice(0, 4096);
    const controlMatches = sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)?.length || 0;
    return controlMatches / sample.length > 0.08;
  }

  static stableForHash(input: string) {
    return this.sanitize(input)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\b\d{1,2}:\d{2}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
