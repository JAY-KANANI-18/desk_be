import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { BACKUP_CODE_COUNT } from './auth.constants';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

@Injectable()
export class AuthTotpService {
  generateSecret(length = 20) {
    return this.toBase32(randomBytes(length));
  }

  generateOtpauthUrl(params: { secret: string; email: string; issuer?: string }) {
    const issuer = params.issuer ?? 'Axodesk';
    const label = encodeURIComponent(`${issuer}:${params.email}`);
    return `otpauth://totp/${label}?secret=${params.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  verifyCode(secret: string, code: string, window = 1) {
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) {
      return false;
    }

    for (let offset = -window; offset <= window; offset += 1) {
      if (this.generateCode(secret, offset) === normalized) {
        return true;
      }
    }

    return false;
  }

  generateBackupCodes() {
    return Array.from({ length: BACKUP_CODE_COUNT }, () =>
      randomBytes(5).toString('hex').toUpperCase(),
    );
  }

  private generateCode(secret: string, offset = 0) {
    const key = this.fromBase32(secret);
    const counter = Math.floor(Date.now() / 30000) + offset;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));

    const digest = createHmac('sha1', key).update(buffer).digest();
    const truncated = digest.readUInt32BE(digest[digest.length - 1] & 0x0f) & 0x7fffffff;

    return `${truncated % 1000000}`.padStart(6, '0');
  }

  private toBase32(buffer: Buffer) {
    let bits = '';
    for (const byte of buffer) {
      bits += byte.toString(2).padStart(8, '0');
    }

    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
      const chunk = bits.slice(index, index + 5).padEnd(5, '0');
      output += BASE32_ALPHABET[parseInt(chunk, 2)];
    }

    return output;
  }

  private fromBase32(value: string) {
    const normalized = value.replace(/=+$/g, '').toUpperCase();
    let bits = '';

    for (const char of normalized) {
      const index = BASE32_ALPHABET.indexOf(char);
      if (index === -1) {
        throw new Error('Invalid base32 character');
      }
      bits += index.toString(2).padStart(5, '0');
    }

    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }

    return Buffer.from(bytes);
  }
}

