import { createHash, randomBytes } from 'crypto';
import { Request } from 'express';
import { RequestMeta } from './auth.types';

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function generateOpaqueToken(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

export function generateOtpCode(length = 6) {
  const min = 10 ** (length - 1);
  const max = (10 ** length) - 1;
  const number = Math.floor(Math.random() * (max - min + 1)) + min;
  return `${number}`;
}

export function parseCookie(header: string | undefined, name: string) {
  if (!header) {
    return null;
  }

  for (const fragment of header.split(';')) {
    const [cookieName, ...rest] = fragment.trim().split('=');
    if (cookieName === name) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return null;
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

export function highestRole(
  workspaceRoles: Record<string, string>,
  orgRoles: Record<string, string>,
) {
  const allRoles = [...Object.values(orgRoles), ...Object.values(workspaceRoles)];
  const priority = [
    'ORG_OWNER',
    'ORG_ADMIN',
    'WS_OWNER',
    'owner',
    'admin',
    'manager',
    'supervisor',
    'agent',
    'member',
  ];

  for (const role of priority) {
    if (allRoles.includes(role)) {
      return role;
    }
  }

  return allRoles[0] ?? 'agent';
}

export function buildRequestMeta(request: Request): RequestMeta {
  const forwardedFor = request.headers['x-forwarded-for'];
  const ipAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : request.ip ?? null;
  const userAgent = typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent']
    : null;
  const deviceId = typeof request.headers['x-device-id'] === 'string'
    ? request.headers['x-device-id']
    : null;
  const deviceName = typeof request.headers['x-device-name'] === 'string'
    ? request.headers['x-device-name']
    : null;
  const deviceFingerprint = typeof request.headers['x-device-fingerprint'] === 'string'
    ? request.headers['x-device-fingerprint']
    : [userAgent ?? 'unknown', request.headers['accept-language'] ?? 'unknown'].join('|');

  return {
    ipAddress,
    ipHash: ipAddress ? hashValue(ipAddress) : null,
    userAgent,
    deviceId,
    deviceName,
    deviceFingerprint,
  };
}

export function buildDisplayName(user: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email.split('@')[0] || 'User';
}

export function redactEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!domain) {
    return email;
  }
  if (name.length <= 2) {
    return `${name[0] ?? '*'}*@${domain}`;
  }
  return `${name.slice(0, 2)}***@${domain}`;
}

