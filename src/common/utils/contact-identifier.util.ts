const PHONE_IDENTIFIER_CHANNEL_TYPES = new Set(['whatsapp', 'sms', 'exotel_call']);

export function isPhoneIdentifierChannel(channelType: string | null | undefined) {
  return PHONE_IDENTIFIER_CHANNEL_TYPES.has(String(channelType ?? '').toLowerCase());
}

export function normalizePhoneIdentifier(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits || null;
}

export function normalizeContactIdentifierForChannel(
  channelType: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (isPhoneIdentifierChannel(channelType)) {
    return normalizePhoneIdentifier(value);
  }

  const normalized = value?.trim();
  if (!normalized) return null;

  return String(channelType ?? '').toLowerCase() === 'email'
    ? normalized.toLowerCase()
    : normalized;
}
