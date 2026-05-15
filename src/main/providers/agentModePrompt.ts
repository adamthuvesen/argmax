export const PLAN_MODE_PROMPT_PREFIX =
  "Plan mode: analyze the request and propose a plan only. Do not edit files, run mutating commands, or make changes.";

export function promptForAgentMode(prompt: string, agentMode: "edit" | "plan"): string {
  return agentMode === "plan" ? `${PLAN_MODE_PROMPT_PREFIX}\n\n${prompt}` : prompt;
}
