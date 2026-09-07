/**
 * A v4 UUID that also works over the mobile remote bridge. That origin is
 * plain HTTP, so it is not a secure context and `crypto.randomUUID` is
 * undefined there; `crypto.getRandomValues` is not gated the same way.
 */
export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
