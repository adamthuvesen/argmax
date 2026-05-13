# Release & signing

How to produce a signed, notarized macOS build of Argmax.

## Prerequisites

- Apple Developer account with a valid `Developer ID Application` certificate installed in the build machine's login keychain.
- An app-specific password for `notarytool` (generated at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords).
- The Team ID from <https://developer.apple.com/account> (top-right next to your name).

## Environment variables

`electron-builder` (≥ v26) drives notarization via the modern `notarytool`. Set these before `npm run package`:

| Variable | What it is | Example |
|---|---|---|
| `APPLE_ID` | Apple ID email tied to the developer account | `you@example.com` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (NOT your Apple ID password) | `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | 10-character Team ID | `ABCDE12345` |
| `CSC_LINK` *(optional)* | Path or base64 of a `.p12` if the cert is not in the keychain | `~/certs/argmax.p12` |
| `CSC_KEY_PASSWORD` *(optional)* | Password for the `.p12` above | — |

Store these in 1Password and load via `op read "op://..."` rather than `.env` files.

## Entitlements

The hardened runtime entitlements live at [`build/entitlements.mac.plist`](../../build/entitlements.mac.plist):

- `com.apple.security.cs.allow-jit` — V8 JIT.
- `com.apple.security.cs.allow-unsigned-executable-memory` — required by Electron's V8.
- `com.apple.security.cs.disable-library-validation` — needed for `better-sqlite3` and `node-pty` native modules loaded from inside the app bundle.
- `com.apple.security.inherit` — PTY children inherit the parent's sandbox.

The same plist is referenced as both `entitlements` and `entitlementsInherit` in `package.json` → `build.mac`. Split into two files only if you need to tighten what the parent can do beyond what children inherit.

## Build & notarize

```bash
export APPLE_ID="$(op read 'op://Private/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://Private/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://Private/Argmax notarization/team id')"

npm run package
```

`npm run package` runs `npm run build` then `electron-builder --mac`, which signs every binary, calls `notarytool submit --wait`, and staples the ticket. Output lands in `release/`:

- `Argmax-<version>-arm64.dmg` / `-x64.dmg`
- `Argmax-<version>-mac.zip` (used by `electron-updater`)
- `latest-mac.yml` (auto-update manifest)

Watch for these failure modes:

- `errSecInternalComponent` during signing — the certificate isn't in the login keychain, or the keychain is locked. `security unlock-keychain login.keychain` then retry.
- `Notarization status: Invalid` — fetch the log with `xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"`. Common cause: a native module shipped without the hardened-runtime flag.
- DMG opens with "Argmax is damaged and can't be opened" on a fresh Mac — Gatekeeper rejected an unsigned or unstapled bundle. Re-run `npm run package` end-to-end; never hand-edit the bundle after signing.

## Publishing

`package.json` → `build.publish` is set to `{ provider: "github" }`. `electron-updater` reads `latest-mac.yml` from the latest GitHub release matching the current `version`. To cut a release:

1. Bump `version` in `package.json`.
2. `npm run package`.
3. Create a GitHub release tagged `v<version>`, upload the DMG, ZIP, and `latest-mac.yml` from `release/`.

The in-app `Check for updates` menu item (App menu) and the boot-time auto-check both reach the configured GitHub feed.

## Smoke procedure (covered by P7.04)

Documented placeholder until P7.04 lands the actual procedure. Goal: a fresh Mac (no Argmax history, no developer-mode bypass) double-clicks the DMG, drags Argmax to `/Applications`, opens it, sees no "damaged" dialog, and reaches the launcher within 5 s.
