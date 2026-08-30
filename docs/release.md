# Release and Signing

Argmax releases target macOS using Tauri bundler and the Tauri updater (`latest.json`).

## Environment Variables

Load signing credentials from 1Password:

```bash
export APPLE_ID="$(op read 'op://<vault>/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://<vault>/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://<vault>/Argmax notarization/team id')"
export APPLE_SIGNING_IDENTITY="$(op read 'op://<vault>/Argmax signing/signing identity')"
export TAURI_SIGNING_PRIVATE_KEY="$(op read 'op://<vault>/Argmax Tauri updater/private key')"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(op read 'op://<vault>/Argmax Tauri updater/private key password')"
```

The updater public key is committed to `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

## App Icons

`npm run build:icons` generates icon files from [scripts/build-icons.mjs](../scripts/build-icons.mjs):

| Artifact | Usage |
|---|---|
| `assets/icon.svg`, `assets/icon-dark.svg` | Vector assets |
| `assets/icon.png`, `assets/icon-dark.png` | Bitmaps for README and web manifest |
| `assets/Argmax.icon` | Icon Composer source package |
| `src-tauri/icons/icon.icns` | macOS icon bundle |
| `src-tauri/icons/Assets.car` | macOS appearance-aware icon asset catalog |

Requires Xcode on macOS. Never manually edit generated icon outputs.

## Packaging

```bash
npm run tauri:build
```

Build outputs are placed in `src-tauri/target/release/bundle/` (DMG, app bundle, and updater JSON).

## Verification

1. Build with signing and notarization keys set.
2. Verify Gatekeeper validation:

```bash
spctl --assess --type execute /Applications/Argmax.app
```

3. Verify app launch, provider execution, chat resume, terminal PTY, diff rendering, and updater check.
