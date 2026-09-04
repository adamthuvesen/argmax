export declare function parseVerifyArgs(argv: string[]): {
  scenario: string;
  outputDir: string | null;
  keep: boolean;
  release: boolean;
  native: string;
  timeoutMs: number;
};
