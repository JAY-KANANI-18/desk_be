export function toJsonSafe<T>(value: T): T {
  return normaliseValue(value) as T;
}

function normaliseValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normaliseValue(item));
  }

  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, nestedValue]) => [
      key,
      normaliseValue(nestedValue),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}
