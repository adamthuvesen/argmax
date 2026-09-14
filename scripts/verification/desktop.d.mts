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

export interface MacosApplicationState {
  pid?: number;
  localizedName?: string | null;
  bundleIdentifier?: string | null;
  launchDate?: string | null;
  policy?: number;
  active?: boolean;
  hidden?: boolean;
  finishedLaunching?: boolean;
  frontmost?: MacosApplicationState | null;
  frontmostPid?: number;
  windowCount?: number;
  onScreenWindowCount?: number;
}

export interface MacosDesktopStateSnapshot {
  before?: MacosApplicationState | null;
  activated?: boolean | null;
  after?: MacosApplicationState | null;
  diagnosticError?: string;
}

export interface MacosConsoleLockState {
  ioConsoleLocked?: boolean | null;
  screenIsLocked?: boolean | null;
  diagnosticError?: string;
}

export interface ForegroundActivationTimeoutDetails {
  classification: "foreground-activation-timeout";
  pid: number;
  visibilityError: string;
  consoleLock: MacosConsoleLockState;
  frontmostProcess: MacosApplicationState | null;
  candidateState: MacosApplicationState | null;
  activationRequest: {
    result: boolean | null;
    before: MacosApplicationState | null;
    after: MacosApplicationState | null;
  };
  diagnosticError?: string;
}

export function parseMacosConsoleLockState(output: string): MacosConsoleLockState;

export function foregroundActivationTimeoutDetails(options: {
  pid: number;
  visibilityError: unknown;
  activationRequest: MacosDesktopStateSnapshot;
  failureState: MacosDesktopStateSnapshot;
  consoleLock: MacosConsoleLockState;
}): ForegroundActivationTimeoutDetails;
