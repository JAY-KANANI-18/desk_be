import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

@Injectable()
export class IntegrationSecretService {
  private getKey() {
    const secret =
      process.env.INTEGRATION_ENCRYPTION_KEY ??
      process.env.AUTH_ENCRYPTION_KEY ??
      process.env.AUTH_JWT_SECRET ??
      'change-me-in-production';

    return createHash('sha256').update(secret).digest();
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(payload: string) {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', this.getKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  encryptJson(value: Record<string, unknown>) {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(payload: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(this.decrypt(payload));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
}
