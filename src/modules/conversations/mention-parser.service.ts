import { Injectable } from '@nestjs/common';

export interface ParsedMention {
  userId: string;
  displayName: string;
}

const STRUCTURED_MENTION_REGEX = /@\[(?<userId>[^|\]]+)\|(?<displayName>[^\]]+)\]/g;

@Injectable()
export class MentionParserService {
  parse(text: string): ParsedMention[] {
    if (!text) {
      return [];
    }

    const mentions = new Map<string, ParsedMention>();

    for (const match of text.matchAll(STRUCTURED_MENTION_REGEX)) {
      const userId = match.groups?.userId?.trim();
      const displayName = match.groups?.displayName?.trim();

      if (!userId || !displayName) {
        continue;
      }

      mentions.set(userId, { userId, displayName });
    }

    return Array.from(mentions.values());
  }

  extractUserIds(text: string): string[] {
    return this.parse(text).map((mention) => mention.userId);
  }

  toPlainText(text: string): string {
    if (!text) {
      return '';
    }

    return text.replace(
      STRUCTURED_MENTION_REGEX,
      (_match, _userId: string, displayName: string) => `@${displayName.trim()}`,
    );
  }
}
