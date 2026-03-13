// modules/channels/providers/meta/meta-signature.util.ts
// Moved from modules/channels/utils/meta-signature.util.ts

import * as crypto from 'crypto';

/**
 * Verifies x-hub-signature-256 header sent by Meta on every webhook POST.
 *
 * Requires rawBody — enable in main.ts:
 *   const app = await NestFactory.create(AppModule, { rawBody: true });
 */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  signature: string,
  appSecret: string,
): boolean {
  if (!rawBody || !signature || !appSecret) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}