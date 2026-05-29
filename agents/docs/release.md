# Release & Signing

Tauri is the release pipeline. Tauri publishes `latest.json` for updates.

> **Legacy (post-migration housekeeping):** Electron's `latest-mac.yml` feed is frozen after the final migration release. Existing Electron installs poll it for a one-time migration banner release; keep the old feed in GitHub releases indefinitely to avoid breaking those clients.

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

Do not delete the old Electron `latest-mac.yml` from GitHub releases; existing Electron installs poll it for the one-time migration banner release.
