const SECRET_KEY_PATTERN =
  /token|apikey|api_key|authorization|cookie|storage|password|secret|bearer/i;

const DEFAULT_MAX_STRING = 500;

/** Remove secrets and huge pageText blobs before writing JSONL. */
export function sanitizeForLog(value: unknown, maxString = DEFAULT_MAX_STRING): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.length > maxString) {
      return `${value.slice(0, maxString)}…[truncated]`;
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, maxString));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'pageText') continue;
      if (SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeForLog(val, maxString);
    }
    return out;
  }

  return String(value);
}
