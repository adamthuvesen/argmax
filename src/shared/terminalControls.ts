/* eslint-disable no-control-regex */
const oscSequencePattern = new RegExp("\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)", "g");
const csiSequencePattern = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
const escapeSequencePattern = new RegExp("\\u001B[@-Z\\\\-_]", "g");
const controlCharacterPattern = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");
/* eslint-enable no-control-regex */

/**
 * Strip OSC, CSI, single-character escape sequences, and most non-printing
 * control characters from a string. Tab (\t), LF, and CR are preserved so
 * line splitting still works. Used by both the main-process normalizer and
 * the renderer when rebuilding a terminal transcript.
 */
export function stripTerminalControls(value: string): string {
  return value
    .replace(oscSequencePattern, "")
    .replace(csiSequencePattern, "")
    .replace(escapeSequencePattern, "")
    .replace(controlCharacterPattern, "");
}
