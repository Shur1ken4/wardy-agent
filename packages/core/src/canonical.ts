/**
 * Canonical JSON: sorted keys, no whitespace. The same value always gives the same bytes, which is what makes
 * signatures and hashes over it stable. Undefined object fields are left out. Anything JSON can't represent
 * faithfully throws rather than being silently changed under a signature.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined) throw new TypeError("Can't canonicalise undefined");
  return encoded;
}

function encode(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`Can't canonicalise the number ${value}`);
      return JSON.stringify(value);
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      throw new TypeError(`Can't canonicalise a ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => encode(item) ?? "null").join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Can't canonicalise a ${prototype.constructor?.name ?? "class instance"}`);
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = encode(record[key]);
    if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${fields.join(",")}}`;
}
