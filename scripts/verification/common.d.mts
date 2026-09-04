export declare function checkoutFingerprint(repoRoot: string): Promise<{
  head: string;
  dirty: boolean;
  status: string[];
  fileCount: number;
  sha256: string;
}>;
export declare function runChecked(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<unknown>;
