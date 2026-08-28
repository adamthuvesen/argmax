# Release & Signing

Tauri is the release pipeline. Tauri publishes `latest.json` for updates.

The public release is macOS-only and uses the Tauri app id/data directory.

## Environment

Load secrets from 1Password, never `.env`:

```bash
export APPLE_ID="$(op read 'op://<vault>/Apple ID/username')"
export APPLE_APP_SPECIFIC_PASSWORD="$(op read 'op://<vault>/Argmax notarization/password')"
export APPLE_TEAM_ID="$(op read 'op://<vault>/Argmax notarization/team id')"
export APPLE_SIGNING_IDENTITY="$(op read 'op://<vault>/Argmax signing/signing identity')"
export TAURI_SIGNING_PRIVATE_KEY="$(op read 'op://<vault>/Argmax Tauri updater/private key')"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(op read 'op://<vault>/Argmax Tauri updater/private key password')"
```

Generate the updater key once with:

```bash
npm run tauri signer generate -- -w <secure-path>
```

Commit only the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Store the private key in 1Password.

## App icon

`npm run build:icons` regenerates every icon artifact from the pixel grid and
palette in [scripts/build-icons.mjs](../scripts/build-icons.mjs). Change the
mark or a colour there, not in the outputs:

| Artifact | Used by |
| --- | --- |
| `assets/icon.svg`, `assets/icon-dark.svg` | vector artwork, docs |
| `assets/icon.png`, `assets/icon-dark.png` | README, anywhere a bitmap is needed |
| `assets/Argmax.icon` | Icon Composer source for the appearance-aware icon |
| `src-tauri/icons/icon.icns` | the icon macOS 25 and earlier shows |
| `src-tauri/icons/Assets.car` | the light/dark/tinted icon macOS 26 shows |

Both bundled artifacts are listed in `bundle.icon` and are committed, so a
normal `npm run tauri:build` never runs the script. Tauri copies `Assets.car`
verbatim and reads the app-icon name back out of it to set `CFBundleIconName`.
the `.icns` stays as `CFBundleIconFile` for older macOS.

Regenerating needs macOS with Xcode 26 or newer. `actool` below 26 cannot
compile an Icon Composer package, and the script fails rather than quietly
shipping a stale `Assets.car`. To preview a change before committing it:

```bash
"$(dirname "$(xcode-select -p)")/Applications/Icon Composer.app/Contents/Executables/ictool" \
  assets/Argmax.icon --export-image --output-file /tmp/icon.png \
  --platform macOS --rendition Dark --width 512 --height 512 --scale 1
```

`--rendition` also takes `Default`, `TintedLight`, `TintedDark`, `ClearLight`
and `ClearDark`.

## Build

```bash
npm run tauri:build
```

Expected release artifacts live under `src-tauri/target/release/bundle/` and include the app/DMG plus Tauri updater metadata.

## Smoke

1. Build with real signing/notarization credentials.
2. Install the DMG on a fresh Mac.
3. Open from `/Applications`.
4. Confirm Gatekeeper accepts:

```bash
spctl --assess --type execute /Applications/Argmax.app
```

5. Confirm cold start, provider launch, chat send/resume, terminal spawn, review diff, and update check.
