export const NATIVE_STOP_MINIMUM_SESSION_AGE_MS: number;

export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  startedAt: string;
}

export function matchingProcessIdentities(
  processes: ProcessIdentity[],
  expected: ProcessIdentity[],
): ProcessIdentity[];
