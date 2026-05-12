export function formatCostUsd(value: number | null | undefined): string {
  const v = value ?? 0;
  if (!Number.isFinite(v) || v === 0) {
    return "$0.00";
  }
  // Render negatives with a leading minus so refunds, mis-attributed credits,
  // or upstream signed-math bugs surface visibly rather than collapsing to
  // $0.00.
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs < 1) {
    return `${sign}$${abs.toFixed(3)}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}
