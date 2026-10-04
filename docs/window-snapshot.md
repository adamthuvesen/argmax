# Window snapshot

A global chord attaches the frontmost app's top window to the Argmax composer as
an image. macOS only. Code: [src-tauri/src/window_snapshot](../src-tauri/src/window_snapshot).
Settings → General → Window snapshot turns it on, remaps it, and shows the
Screen Recording state.

## Flow

1. The chord fires while another app is frontmost. Registration uses
   `tauri-plugin-global-shortcut`, from Rust only, so the webview gets no
   shortcut permission.
2. Before anything of Argmax's own is raised, `NSWorkspace.frontmostApplication`
   names the app and `CGWindowListCopyWindowInfo` lists on-screen windows front
   to back. [target.rs](../src-tauri/src/window_snapshot/target.rs) takes the
   first normal window of that app (layer 0, visible, at least 100×60).
3. `/usr/sbin/screencapture -x -o -t png -l<window id> <file>` captures that one
   window. It runs with an argument vector, never a shell. The tool works on
   every macOS Argmax supports. ScreenCaptureKit's screenshot API needs macOS 14,
   and `CGWindowListCreateImage` is gone from current SDKs, so neither is used.
4. [capture.rs](../src-tauri/src/window_snapshot/capture.rs) reads the PNG back.
   An empty file, an unreadable file, a zero-sized image and a fully
   transparent image are errors, never attachments.
5. A window wider or taller than 1920 px is shrunk to that long edge with
   `/usr/bin/sips -Z 1920` (argument vector), the same edge a pasted image gets
   in `composerAttachments.ts`. A full Retina window is several megabytes of PNG,
   and its base64 must fit the provider's 4 MiB single-line stream. A smaller
   window is left as captured, because `sips -Z` would enlarge it. A failed
   shrink is an error, never the full-size file.
6. The PNG goes through `AttachmentStore::save_bytes` into the
   `window-snapshots` folder, under the same 10 MiB cap as a pasted image.
7. Argmax raises its last-focused window and emits
   `composer:attach-window-snapshot` to that window only.

Pressing the chord while Argmax is frontmost is an error (`no-external-app`),
not a snapshot of Argmax.

## Events

`composer:attach-window-snapshot`:
`{ attachment: { filePath, mimeType: "image/png", sizeBytes }, source: { appName, bundleId, windowTitle, capturedAt } }`.
`attachment` has the shape of `ComposerAttachmentInput`.

`window-snapshot:failed`: `{ code, message, action }`. Codes:
`screen-recording-denied`, `no-external-app`, `no-window`, `blank-capture`,
`too-large`, `capture-failed`, `store-failed`, `unsupported-platform`. `action`
is `open-screen-recording-settings` for the permission codes, else null.

The renderer receives both through `window.argmax.windowSnapshot.onAttach` and
`onFailed`. The shell mounts [windowSnapshotInbox.ts](../src/renderer/lib/windowSnapshotInbox.ts)
once: it toasts every failure and offers each capture to the newest mounted
composer first. A composer claims it by returning `true`, so several mounted
composers attach it once. A capture nobody claims waits (at most three, for at
most 60 seconds) for the next composer that subscribes; after that it is dropped,
so a late chat does not receive a stale window. A composer receives it with
`windowSnapshotInbox.subscribe(claim)`.

## Settings channels

Desktop only (`REMOTE_UNSUPPORTED` over the phone bridge):
`window-snapshot:status`, `window-snapshot:configure` (`{ enabled, chord }`),
`window-snapshot:request-permission`. The chord and the switch persist in
`ui_state` (`window_snapshot.chord`, `window_snapshot.enabled`); there is no
migration. The feature is off until the user enables it. If registering the
chord fails, `configure` fails with `WINDOW_SNAPSHOT_REGISTRATION_FAILED`,
leaves the previous chord registered, and does not save the new one. A saved
chord that fails at launch is recorded and shown in Settings; it never blocks
startup.

macOS registers global chords non-exclusively. It does not refuse a chord that
another app (a launcher, say) already holds, so both apps can fire on one press,
and Argmax cannot detect that. The plugin offers no exclusive option, and the
feature does not replace it for that. Settings says so next to the keys. The dev
instance and the installed app can likewise both register the same chord.

## Limits

- Needs Screen Recording for Argmax. macOS asks once. After a refusal the
  request shows nothing, so Settings opens Privacy & Security → Screen
  Recording; the grant takes effect after Argmax restarts.
- One window per press. Sheets and popovers are separate windows and are not
  merged in. The shadow is left out (`-o`).
- After the 1920 px shrink a PNG over 10 MiB is unlikely but still fails with
  `too-large`.
- A shared chord is not detected (above).
- The `window-snapshots` folder is not pruned. Files stay while any draft may
  still reference them.
- No Accessibility capture and no OCR.

## Verify on a real Mac

Unit tests cover window choice, argument vector, image checks, store, chord
parsing and registration refusals with a stand-in `screencapture`. They cannot
grant Screen Recording or press a chord. On a dev build
(`npm run tauri:dev:isolated`, never the installed app hosting a chat):

1. Settings → General → Window snapshot: turn it on, grant Screen Recording,
   restart the dev app.
2. Focus Safari or Finder with a visible window; press ⌥⇧⌘S. Argmax raises and
   the image appears in the composer with the right window, not the desktop.
3. Revoke Screen Recording, press the chord: a toast says access is off.
4. Press the chord with Argmax frontmost: a toast says to switch windows.
5. Remap to another chord: it takes effect at once and the old chord stops
   firing. Press the chord with a 5K or Retina window in front: the image is
   1920 px on its long edge.
