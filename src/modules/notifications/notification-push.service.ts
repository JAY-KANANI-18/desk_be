import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

export interface WebPushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface WebPushNotificationPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  renotify?: boolean;
  data?: Record<string, unknown>;
}

interface ResolvedVapidConfig {
  privateKey: KeyObject;
  publicKey: string;
  subject: string;
}

type EcJwk = {
  x?: string;
  y?: string;
  d?: string;
};

@Injectable()
export class NotificationPushService {
  private vapidConfig: ResolvedVapidConfig | null | undefined;
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  getPublicConfig() {
    const config = this.resolveVapidConfig();
    return {
      enabled: Boolean(config),
      publicKey: config?.publicKey ?? null,
    };
  }

  isConfigured() {
    return Boolean(this.resolveVapidConfig());
  }

  async sendNotification(
    subscription: WebPushSubscriptionPayload,
    payload: WebPushNotificationPayload,
    options?: {
      ttlSeconds?: number;
      urgency?: 'very-low' | 'low' | 'normal' | 'high';
      topic?: string;
    },
  ) {
    const config = this.resolveVapidConfig();
    if (!config) {
      throw new Error(
        'Web Push is not configured. Set WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT.',
      );
    }

    const endpoint = new URL(subscription.endpoint);
    const token = this.createVapidToken(endpoint.origin, config);
    const body = this.encryptPayload(subscription, JSON.stringify(payload));

    const headers: Record<string, string> = {
      Authorization: `vapid t=${token}, k=${config.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options?.ttlSeconds ?? Number(process.env.WEB_PUSH_TTL_SECONDS || 60)),
      Urgency: options?.urgency ?? 'high',
    };

    if (options?.topic) {
      headers.Topic = options.topic.slice(0, 32);
    }

    this.logDebug('send:start', {
      endpoint: subscription.endpoint,
      endpointOrigin: endpoint.origin,
      expirationTime: subscription.expirationTime ?? null,
      payload,
      options: {
        ttlSeconds: headers.TTL,
        urgency: headers.Urgency,
        topic: headers.Topic ?? null,
      },
    });

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
    });

    const responseText = await response.text().catch(() => '');

    this.logDebug('send:response', {
      endpoint: subscription.endpoint,
      status: response.status,
      ok: response.ok,
      body: responseText,
    });

    return {
      ok: response.ok,
      status: response.status,
      body: responseText,
      endpoint: subscription.endpoint,
    };
  }

  private createVapidToken(audience: string, config: ResolvedVapidConfig) {
    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(
      Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'),
    );
    const payload = this.base64UrlEncode(
      Buffer.from(
        JSON.stringify({
          aud: audience,
          exp: now + 12 * 60 * 60,
          sub: config.subject,
        }),
        'utf8',
      ),
    );
    const signingInput = `${header}.${payload}`;
    const signature = sign('SHA256', Buffer.from(signingInput, 'utf8'), {
      key: config.privateKey,
      dsaEncoding: 'ieee-p1363',
    });

    return `${signingInput}.${this.base64UrlEncode(signature)}`;
  }

  private encryptPayload(
    subscription: WebPushSubscriptionPayload,
    payload: string,
  ) {
    const uaPublic = this.base64UrlDecode(subscription.keys.p256dh);
    const authSecret = this.base64UrlDecode(subscription.keys.auth);

    if (uaPublic.length !== 65) {
      throw new Error('Invalid Push subscription p256dh key.');
    }

    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();

    const asPublic = ecdh.getPublicKey(undefined, 'uncompressed');
    const ecdhSecret = ecdh.computeSecret(uaPublic);
    const salt = randomBytes(16);

    const prkKey = this.hmac(authSecret, ecdhSecret);
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      uaPublic,
      asPublic,
    ]);
    const ikm = this.hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([0x01])]));

    const prk = this.hmac(salt, ikm);
    const cek = this.hmac(
      prk,
      Buffer.concat([
        Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'),
        Buffer.from([0x01]),
      ]),
    ).subarray(0, 16);
    const nonce = this.hmac(
      prk,
      Buffer.concat([
        Buffer.from('Content-Encoding: nonce\0', 'utf8'),
        Buffer.from([0x01]),
      ]),
    ).subarray(0, 12);

    const plaintext = Buffer.concat([
      Buffer.from(payload, 'utf8'),
      Buffer.from([0x02]),
    ]);
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const recordSize = Buffer.alloc(4);
    recordSize.writeUInt32BE(4096, 0);

    const header = Buffer.concat([
      salt,
      recordSize,
      Buffer.from([asPublic.length]),
      asPublic,
    ]);

    return Buffer.concat([header, encrypted, tag]);
  }

  private resolveVapidConfig(): ResolvedVapidConfig | null {
    if (this.vapidConfig !== undefined) {
      return this.vapidConfig;
    }

    const subject = (process.env.WEB_PUSH_VAPID_SUBJECT || '').trim();
    const privateKeyValue = (process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
    const publicKeyValue = (process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();

    if (!subject || !privateKeyValue) {
      this.vapidConfig = null;
      return this.vapidConfig;
    }

    const privateKey = this.resolvePrivateKey(privateKeyValue, publicKeyValue);
    const publicKey = this.resolvePublicKey(privateKey, publicKeyValue);

    this.vapidConfig = {
      privateKey,
      publicKey,
      subject,
    };

    return this.vapidConfig;
  }

  private resolvePrivateKey(privateKeyValue: string, publicKeyValue: string) {
    if (privateKeyValue.includes('BEGIN')) {
      return createPrivateKey(privateKeyValue);
    }

    const rawPrivateKey = this.base64UrlDecode(privateKeyValue);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(rawPrivateKey);

    const publicKeyBytes = publicKeyValue
      ? this.parsePublicKey(publicKeyValue)
      : ecdh.getPublicKey(undefined, 'uncompressed');

    const x = this.base64UrlEncode(publicKeyBytes.subarray(1, 33));
    const y = this.base64UrlEncode(publicKeyBytes.subarray(33, 65));

    return createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: this.base64UrlEncode(rawPrivateKey),
        x,
        y,
      },
      format: 'jwk',
    });
  }

  private resolvePublicKey(privateKey: KeyObject, publicKeyValue: string) {
    if (publicKeyValue) {
      const parsed = this.parsePublicKey(publicKeyValue);
      return this.base64UrlEncode(parsed);
    }

    const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as EcJwk;
    if (!jwk.x || !jwk.y) {
      throw new Error('Unable to derive VAPID public key.');
    }

    return this.base64UrlEncode(
      Buffer.concat([
        Buffer.from([0x04]),
        this.base64UrlDecode(jwk.x),
        this.base64UrlDecode(jwk.y),
      ]),
    );
  }

  private parsePublicKey(publicKeyValue: string) {
    if (publicKeyValue.includes('BEGIN')) {
      const jwk = createPublicKey(publicKeyValue).export({ format: 'jwk' }) as EcJwk;
      if (!jwk.x || !jwk.y) {
        throw new Error('Invalid WEB_PUSH_VAPID_PUBLIC_KEY.');
      }

      return Buffer.concat([
        Buffer.from([0x04]),
        this.base64UrlDecode(jwk.x),
        this.base64UrlDecode(jwk.y),
      ]);
    }

    return this.base64UrlDecode(publicKeyValue);
  }

  private hmac(key: Buffer, input: Buffer) {
    return createHmac('sha256', key).update(input).digest();
  }

  private base64UrlDecode(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
  }

  private base64UrlEncode(value: Buffer) {
    return value
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][PushService] ${event}`, details ?? '');
  }
}
