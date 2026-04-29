import { randomInt } from 'node:crypto';

const STATIC_CONTACT_AVATAR_COUNT = 65;
const STATIC_CONTACT_AVATAR_PREFIX = 'static/avatars';

function getPublicR2BaseUrl(): string | null {
  const baseUrl = process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return baseUrl || null;
}

function normalizeAvatarUrl(avatarUrl?: string | null): string | null {
  const trimmed = avatarUrl?.trim();
  return trimmed || null;
}

export function getRandomStaticContactAvatarUrl(): string | undefined {
  const baseUrl = getPublicR2BaseUrl();
  if (!baseUrl) return undefined;

  const avatarNumber = randomInt(1, STATIC_CONTACT_AVATAR_COUNT + 1);
  return `${baseUrl}/${STATIC_CONTACT_AVATAR_PREFIX}/${avatarNumber}.svg`;
}

export function resolveContactAvatarUrl(avatarUrl?: string | null): string | undefined {
  return normalizeAvatarUrl(avatarUrl) ?? getRandomStaticContactAvatarUrl();
}

export function isStaticContactAvatarUrl(avatarUrl?: string | null): boolean {
  const normalized = normalizeAvatarUrl(avatarUrl);
  if (!normalized) return false;

  return /(?:^|\/)(?:static\/avatars(?:\/[^/?#]+)?|files\/avatars\/static-avatar\/[^/?#]+)\/\d+\.svg(?:[?#].*)?$/i.test(normalized);
}

export function isMissingOrStaticContactAvatarUrl(avatarUrl?: string | null): boolean {
  return !normalizeAvatarUrl(avatarUrl) || isStaticContactAvatarUrl(avatarUrl);
}
