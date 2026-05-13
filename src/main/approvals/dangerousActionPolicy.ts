import type { ApprovalRequest } from "../../shared/types.js";

export interface CommandRiskDecision {
  requiresApproval: boolean;
  riskLevel: ApprovalRequest["riskLevel"];
  reason: string;
}

/**
 * Risk classifier for shell commands surfaced through provider tool calls.
 *
 * The bypass-permissions launch mode (default for now) means the only thing
 * standing between the model and arbitrary system damage is this policy plus
 * the renderer-side approval surface. So the patterns here have to handle
 * adversarial input from a model that's been steered or jailbroken — not
 * just well-formed shell. That means:
 *
 *  - Case-insensitive matching (a steered model may emit `RM -RF`).
 *  - Tolerate split flags (`rm -r -f`, `rm -f -r`, `rm --recursive --force`).
 *  - Catch command substitution and pipe-to-shell delivery
 *    (`curl ... | sh`, `eval "$(curl ...)"`).
 *  - Catch the destructive-but-non-rm forms the audit called out:
 *    `find -delete`, `dd if=`, `mkfs`, world-writable chmod.
 *
 * False-positive guards (audit 2026-05-11):
 *  - `git push --force-with-lease` is intentionally NOT high-risk. It's a
 *    push, so it still trips the medium `git push` matcher, but the safer
 *    `--force-with-lease` form should not get the same UI weight as raw
 *    `--force`. The regex below requires the flag to be terminated by a
 *    space, end-of-string, or another flag — not a hyphen-suffix.
 *  - `sudo` as a substring of `--pseudo-sudo-flag` should not trip.
 *    The regex anchors `sudo` at a command-boundary (start of line, after
 *    a pipe/`;`/`&&`/`||`, or after the start of a substitution), not
 *    just any word boundary.
 */

const highRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
  // rm with recursive + force flags in any order, split or combined.
  // Matches: `rm -rf`, `rm -fr`, `rm -r -f`, `rm -f -r`, `rm --recursive --force`,
  // `rm -R --force`. Does NOT match `rm file.txt` or `rm -i target` alone.
  {
    pattern:
      /\brm\b(?=[^\n;|&]*\s(-[rR]|--recursive))(?=[^\n;|&]*\s(-[fF]|--force))/i,
    reason: "Recursive forced removal"
  },
  // Combined-flag form: `rm -rf` / `rm -Rf` / `rm -fr` / `rm -fR` etc.
  // The combined-flag regex above doesn't cover the single-token form.
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\b/i, reason: "Recursive forced removal" },
  { pattern: /\brm\s+-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\b/i, reason: "Recursive forced removal" },
  // Pipe-to-shell: `curl https://x | sh`, `wget -O- url | bash`, etc.
  { pattern: /\|\s*(sh|bash|zsh|fish|ksh|dash)\b/i, reason: "Pipe to shell interpreter" },
  // eval / source on a command substitution — classic curl|sh disguise.
  { pattern: /\b(eval|source|\.)\s+["']?\$\(/i, reason: "Eval of command substitution" },
  // Inline destructive command inside a substitution. We match the
  // substitution shape only when its contents start with a high-impact
  // verb so we don't flag every `$(date)`.
  { pattern: /\$\(\s*(rm|sudo|chmod|chown|dd|mkfs|curl|wget)\b/i, reason: "Destructive command substitution" },
  { pattern: /`\s*(rm|sudo|chmod|chown|dd|mkfs|curl|wget)\b/i, reason: "Destructive backtick substitution" },
  // find … -delete: deletes every match, no confirmation.
  { pattern: /\bfind\b[^\n;|&]*\s-delete\b/i, reason: "find -delete" },
  // dd if=… of=… — block-device wipe disguised as a copy.
  { pattern: /\bdd\b[^\n;|&]*\sif=/i, reason: "dd block copy" },
  // mkfs.* — filesystem creation, almost always destructive.
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "Filesystem creation" },
  // chmod with a world-writable bit (mode digit 7 or 6 in the world slot).
  // Matches numeric modes like 777, 666, 0777, -R 777. Does NOT match
  // chmod +x, chmod u+x, chmod g-w.
  { pattern: /\bchmod\s+(?:-R\s+)?0?[0-7]?[0-7]?[67]\b/i, reason: "World-writable chmod" },
  // git destructive operations.
  { pattern: /\bgit\s+reset\b[^\n;|&]*\s--hard\b/i, reason: "Hard git reset" },
  { pattern: /\bgit\s+reset\b/i, reason: "Git reset" },
  { pattern: /\bgit\s+clean\b[^\n;|&]*\s-[a-zA-Z]*f/i, reason: "Forced git clean" },
  // Raw `--force` push: high. `--force-with-lease` is medium (caught by
  // the general `git push` matcher below). The negative lookahead `(?![-\w])`
  // rejects the `-with-lease` suffix so the SPEC's audit false-positive
  // guard stays in place.
  { pattern: /\bgit\s+push\b[^\n;|&]*\s(--force|-f|--mirror)(?![-\w])/i, reason: "Force push" },
  { pattern: /\bgit\s+branch\b[^\n;|&]*\s-[dD]\b/i, reason: "Branch deletion" },
  { pattern: /\bgit\s+worktree\s+remove\b/i, reason: "Worktree removal" },
  { pattern: /\bgh\s+pr\s+(create|merge|close)\b/i, reason: "GitHub PR mutation" },
  // sudo must be at a command boundary, not buried inside a flag like
  // `--pseudo-sudo-mode`. Allowed prefixes: start-of-string, whitespace
  // not preceded by a hyphen, pipe, semicolon, `&&`, `||`, opening paren
  // of a substitution, or opening of a backtick.
  { pattern: /(^|[\s|;&(`])sudo\b/i, reason: "Privilege escalation" }
];

const mediumRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+add\b/i, reason: "Git staging" },
  { pattern: /\bgit\s+commit\b/i, reason: "Git commit" },
  { pattern: /\bgit\s+(merge|rebase|checkout)\b/i, reason: "History or checkout mutation" },
  { pattern: /\bgit\s+push\b/i, reason: "Remote git mutation" },
  { pattern: /\b(chmod|chown)\b/i, reason: "Permission mutation" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\b/i, reason: "Dependency mutation" }
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
