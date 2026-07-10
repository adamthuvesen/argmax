// Agent tool-call rows now carry a deterministic moon-name codename between the
// verb and the task preview ("Started agent Callisto — <preview>"). Tests match
// the stable preview and leave the codename free so they don't couple to the
// hash. One matcher, used everywhere an agent row is queried by accessible name.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function startedAgentName(preview: string): RegExp {
  return new RegExp(`^Started agent .+ — ${escapeRegExp(preview)}$`);
}

export function toggleAgentDetailsName(preview: string): RegExp {
  return new RegExp(`^Toggle details for Started agent .+ — ${escapeRegExp(preview)}$`);
}
