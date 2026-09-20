# Release and Signing

Argmax releases target macOS as manually distributed app and DMG bundles.
Automatic self-update is deferred and is not part of the current release scope.

## Optional Distribution Signing

For a public macOS distribution, load Apple signing and notarization credentials
from 1Password:

```bash
export APPLE_ID="$(op read 'op://<vault>/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://<vault>/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://<vault>/Argmax notarization/team id')"
export APPLE_SIGNING_IDENTITY="$(op read 'op://<vault>/Argmax signing/signing identity')"
```

Local and personal builds can remain ad hoc signed. They will not pass public
Gatekeeper assessment.

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
configuration creates the DMG and app bundle required for manual distribution.

Argmax → Check for Updates… opens the GitHub Releases page, because that is
where a build actually comes from today. The checked-in updater configuration
is incomplete and is not an active release channel. If automatic self-update becomes a requirement later, it needs a
dedicated signing key, updater artifacts and a published feed. See
[Tauri's updater guide](https://v2.tauri.app/plugin/updater/) for that optional
artifact and feed contract.

## Verification

1. Build the app and DMG.
2. For a public signed release, verify Gatekeeper validation:

```bash
spctl --assess --type execute /Applications/Argmax.app
```

3. Verify app launch, provider execution, chat resume, terminal PTY and diff rendering.
