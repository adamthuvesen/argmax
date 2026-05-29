# Release & signing

How to produce a signed, notarized macOS build of Argmax. For the build pipeline overview (targets, files, entitlements wiring) see [electron.md](electron.md#building-a-distributable); this doc covers credentials, the smoke procedure, and failure modes.

> Runtime note: until the Rust port cutover lands, Electron and Tauri release
> flows coexist. Electron uses `latest-mac.yml`; Tauri uses `latest.json`.

## Prerequisites

- Apple Developer account with a valid `Developer ID Application` certificate installed in the build machine's login keychain.
- An app-specific password for `notarytool` (generated at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords).
- The Team ID from <https://developer.apple.com/account> (top-right next to your name).

## Environment variables

Electron (`electron-builder` ≥ v26) and Tauri both use Apple Developer credentials from the environment. Set these before a signed release build:

| Variable | What it is | Example |
|---|---|---|
| `APPLE_ID` | Apple ID email tied to the developer account | `you@example.com` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (NOT your Apple ID password) | `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | 10-character Team ID | `ABCDE12345` |
| `APPLE_SIGNING_IDENTITY` | Tauri signing identity from `security find-identity -v -p codesigning` | `Developer ID Application: …` |
| `TAURI_SIGNING_PRIVATE_KEY` | Private updater-signing key content for Tauri `latest.json` artifacts | — |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` *(optional)* | Password for the Tauri updater private key, if one was set | — |
| `CSC_LINK` *(optional)* | Path or base64 of a `.p12` if the cert is not in the keychain | `~/certs/argmax.p12` |
| `CSC_KEY_PASSWORD` *(optional)* | Password for the `.p12` above | — |

Store these in 1Password and load via `op read "op://..."` rather than `.env` files.

Example Tauri release shell:

```bash
export APPLE_ID="$(op read 'op://<vault>/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://<vault>/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://<vault>/Argmax notarization/team id')"
export APPLE_SIGNING_IDENTITY="$(op read 'op://<vault>/Argmax signing/signing identity')"
export TAURI_SIGNING_PRIVATE_KEY="$(op read 'op://<vault>/Argmax Tauri updater/private key')"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(op read 'op://<vault>/Argmax Tauri updater/private key password')"

npm run tauri build
```

Generate the Tauri updater keypair once with `npm run tauri signer generate -- -w <secure-path>`. Commit only the public key into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Store the private key and optional password in 1Password. Losing the private key means existing Tauri installs cannot verify future updates.

## Entitlements

The hardened runtime entitlements live at [`build/entitlements.mac.plist`](../../build/entitlements.mac.plist):

- `com.apple.security.cs.allow-jit` — V8 JIT.
- `com.apple.security.cs.allow-unsigned-executable-memory` — required by Electron's V8.
- `com.apple.security.cs.disable-library-validation` — needed for `better-sqlite3` and `node-pty` native modules loaded from inside the app bundle.
- `com.apple.security.inherit` — PTY children inherit the parent's sandbox.

The same plist is referenced as both `entitlements` and `entitlementsInherit` in `package.json` → `build.mac`. Split into two files only if you need to tighten what the parent can do beyond what children inherit.

## Build & notarize

```bash
export APPLE_ID="$(op read 'op://<vault>/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://<vault>/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://<vault>/Argmax notarization/team id')"

npm run package
```

`npm run package` runs `npm run build` then `electron-builder --mac`, which signs every binary, calls `notarytool submit --wait`, and staples the ticket. Output lands in `release/`:

- `Argmax-<version>-arm64.dmg` / `-x64.dmg`
- `Argmax-<version>-arm64.zip` / `-x64.zip` (used by `electron-updater`)
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

The in-app `Check for Updates…` menu item (App menu) and the boot-time auto-check both reach the configured GitHub feed.

For the Tauri build, `src-tauri/tauri.conf.json` points the updater plugin at `https://github.com/adamthuvesen/argmax/releases/latest/download/latest.json`. `latest.json` is not compatible with Electron's `latest-mac.yml`; keep both feeds during the cutover window.

## Verifying the bundle without credentials

The build pipeline can be exercised without Apple credentials to confirm the entitlements + hardened-runtime configuration is wired correctly. The bundle will be ad-hoc-signed and Gatekeeper will reject it on a fresh Mac, but the bundling itself is the part the configuration controls.

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir
```

`--dir` skips DMG creation (which would otherwise fail at the signing step). `CSC_IDENTITY_AUTO_DISCOVERY=false` tells electron-builder not to pick up an unrelated certificate from the keychain.

Output lands in `release/mac-arm64/Argmax.app`. Verify with:

```bash
codesign --display --verbose=2 release/mac-arm64/Argmax.app
```

Look for `flags=0x10002(adhoc,runtime)` — the `runtime` bit confirms hardened runtime is on; `adhoc` confirms no real signing happened (expected without credentials). `Signature=adhoc` is the ad-hoc fallback. When real credentials are present the signature will be a real Developer ID and the `adhoc` flag will be gone.

## Smoke procedure for the signed DMG (with real credentials)

1. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` from 1Password (see above).
2. `npm run package` — produces `release/Argmax-<version>-{arm64,x64}.dmg`, signed + notarized + stapled.
3. AirDrop the DMG to a fresh Mac (a different account, or a clean VM) that has never opened Argmax.
4. Double-click → drag Argmax to `/Applications` → open. Confirm:
   - No "Argmax is damaged and can't be opened" dialog.
   - No "Argmax can't be opened because Apple cannot check it for malicious software" Gatekeeper warning.
   - The launcher renders within ~5 s of double-click.
5. Confirm `spctl --assess --type execute /Applications/Argmax.app` exits 0 (Gatekeeper accepts the bundle).
6. Confirm `xattr -p com.apple.quarantine /Applications/Argmax.app` returns nothing meaningful (stapled ticket means Gatekeeper doesn't need to phone home).

When step 4 fails, see the failure modes in the previous section before retrying. Re-running `npm run package` is cheap; iterating on the entitlements or the keychain is the actual fix.
