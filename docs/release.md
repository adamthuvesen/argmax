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

Before a release, commit the real updater public key to
`src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. An empty value is
invalid. The matching private key stays in 1Password.

## App Icons

`npm run build:icons` generates icon files from [scripts/build-icons.mjs](../scripts/build-icons.mjs),
which draws the pixel fox in [assets/fox-mascot.txt](../assets/fox-mascot.txt), the same
sprite [Mascot.tsx](../src/renderer/components/Mascot.tsx) renders in the app:

| Artifact | Usage |
|---|---|
| `assets/icon.svg`, `assets/icon-dark.svg` | Vector assets |
| `assets/icon.png`, `assets/icon-dark.png` | Bitmaps for README and web manifest |
| `assets/Argmax.icon` | Icon Composer source package |
| `src-tauri/icons/icon.icns` | macOS icon bundle |
| `src-tauri/icons/Assets.car` | macOS appearance-aware icon asset catalog |
| `ios/Argmax/Sources/Assets.xcassets` | iPhone app icon, light and dark |

Requires Xcode on macOS. Never manually edit generated icon outputs.

The `.icns` is `iconutil` output with the 256px `ic13` PNG first. 1Password's
CLI approval prompt reads the first PNG in `CFBundleIconFile` rather than
asking Icon Services for a size-appropriate rendition, so a file that led
with 16px (`icp4`) showed a stamp-sized fox in that popup.

## Packaging

```bash
npm run tauri:build
```

Build outputs are placed in `src-tauri/target/release/bundle/`. The current
configuration creates the DMG and app bundle only. A release that supports
updates must also set `bundle.createUpdaterArtifacts` to `true` and supply the
updater signing key. Tauri then creates the macOS update archive and signature.
The update endpoint must publish `latest.json` with that archive URL and
signature. See [Tauri's updater guide](https://v2.tauri.app/plugin/updater/)
for the artifact and feed contract.

## Verification

1. Build with signing and notarization keys set.
2. Verify Gatekeeper validation:

```bash
spctl --assess --type execute /Applications/Argmax.app
```

3. Verify app launch, provider execution, chat resume, terminal PTY, diff rendering, and updater check.
