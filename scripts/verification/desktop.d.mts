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

export function ensureDesktopForeground(browser: unknown): Promise<{ changed: boolean; pid: number }>;
export function captureDesktopState(browser: unknown): Promise<Record<string, unknown>>;
export function rendererErrorMessages(uiState: unknown): string[];
export function readComposerText(browser: unknown, field: unknown): Promise<string>;
export function typeIntoComposer(browser: unknown, field: unknown, text: string): Promise<void>;
export function waitForCodeMirror(browser: unknown, label: string, timeoutMs?: number): Promise<unknown>;
export function pressChord(browser: unknown, chord: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): Promise<boolean>;
export function composerEditorCommand(element: unknown, action: "text" | "select-all" | "select-end"): string | null;
export function selectComposerText(browser: unknown, field: unknown, where: "all" | "end"): Promise<void>;
export function pressMouseDown(browser: unknown, element: unknown): Promise<void>;
export function openContextMenu(browser: unknown, selector: string): Promise<{ found: boolean; defaultPrevented: boolean; connected: boolean; tag: string; title: string | null; workspaceId: string | null; rect: number[] }>;
export function setInputValue(browser: unknown, field: unknown, text: string): Promise<void>;
