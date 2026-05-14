/**
 * Human-readable byte string. Defaults to one decimal place once we're past
 * the byte tier; the byte tier itself renders as integers ("512 B", not
 * "512.0 B") so small allocations don't look noisier than they are.
 *
 * Picks units B / KB / MB / GB so a multi-GB SQLite WAL surfaces as "1.2 GB"
 * instead of "1234.0 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} B`;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}
