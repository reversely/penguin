// Canonical JSON for signing, following RFC 8785 (JSON Canonicalization Scheme): object keys sorted
// by UTF-16 code units, no whitespace, and strings and numbers serialized as ECMAScript's
// JSON.stringify serializes them. Two writers that hold the same data produce the same bytes.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot hold a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is the order RFC 8785 requires.
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a value of type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson(value));
}
