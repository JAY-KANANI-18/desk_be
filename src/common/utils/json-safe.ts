export function toJsonSafe<T>(value: T): T {
  return normaliseValue(value, new WeakSet<object>()) as T;
}

function normaliseValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return value.map((item) => normaliseValue(item, seen));
  }

  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const entries = Object.entries(value).map(([key, nestedValue]) => [
      key,
      normaliseValue(nestedValue, seen),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}
