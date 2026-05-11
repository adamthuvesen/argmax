export function formatCostUsd(value: number | null | undefined): string {
  const v = value ?? 0;
  if (!Number.isFinite(v) || v <= 0) {
    return "$0.00";
  }
  if (v < 1) {
    return `$${v.toFixed(3)}`;
  }
  return `$${v.toFixed(2)}`;
}
