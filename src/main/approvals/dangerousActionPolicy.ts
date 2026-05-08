import type { ApprovalRequest } from "../../shared/types.js";

export interface CommandRiskDecision {
  requiresApproval: boolean;
  riskLevel: ApprovalRequest["riskLevel"];
  reason: string;
}

const highRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[^\s]*r[^\s]*f|-rf|-fr)\b/, reason: "Recursive forced removal" },
  { pattern: /\bgit\s+reset\b.*\s--hard\b/, reason: "Hard git reset" },
  { pattern: /\bgit\s+reset\b/, reason: "Git reset" },
  { pattern: /\bgit\s+clean\b.*\s-[^\s]*f/, reason: "Forced git clean" },
  { pattern: /\bgit\s+push\b.*\s(--force|-f|--mirror)\b/, reason: "Force push" },
  { pattern: /\bgit\s+branch\b.*\s-[dD]\b/, reason: "Branch deletion" },
  { pattern: /\bgit\s+worktree\s+remove\b/, reason: "Worktree removal" },
  { pattern: /\bgh\s+pr\s+(create|merge)\b/, reason: "GitHub PR mutation" },
  { pattern: /\bsudo\b/, reason: "Privilege escalation" }
];

const mediumRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+add\b/, reason: "Git staging" },
  { pattern: /\bgit\s+commit\b/, reason: "Git commit" },
  { pattern: /\bgit\s+(merge|rebase|checkout)\b/, reason: "History or checkout mutation" },
  { pattern: /\bgit\s+push\b/, reason: "Remote git mutation" },
  { pattern: /\b(chmod|chown)\b/, reason: "Permission mutation" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, reason: "Dependency mutation" }
];

export function classifyCommandRisk(command: string): CommandRiskDecision {
  const normalized = command.trim();

  for (const item of highRiskPatterns) {
    if (item.pattern.test(normalized)) {
      return {
        requiresApproval: true,
        riskLevel: "high",
        reason: item.reason
      };
    }
  }

  for (const item of mediumRiskPatterns) {
    if (item.pattern.test(normalized)) {
      return {
        requiresApproval: true,
        riskLevel: "medium",
        reason: item.reason
      };
    }
  }

  return {
    requiresApproval: false,
    riskLevel: "low",
    reason: "Read-only or low-risk command"
  };
}
