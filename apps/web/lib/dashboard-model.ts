export function boundedResultLabel(nodes: number, maximum: number, truncated: boolean): string {
  if (truncated) return `${nodes} / ${maximum} nodes · truncated`;
  return `${nodes} / ${maximum} nodes · complete within bound`;
}

export function capabilityTone(state: string): "danger" | "neutral" | "success" | "warning" {
  if (state === "current") return "success";
  if (state === "failed") return "danger";
  if (state === "degraded" || state === "stale") return "warning";
  return "neutral";
}
