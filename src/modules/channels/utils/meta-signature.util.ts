import * as crypto from 'crypto';

export function verifyMetaSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    appSecret: string,
) {
    if (!signatureHeader) return false;

    const [algo, hash] = signatureHeader.split('=');

    if (algo !== 'sha256') return false;

    const expectedHash = crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(hash),
        Buffer.from(expectedHash),
    );
}