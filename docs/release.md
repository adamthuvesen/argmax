# Release and Signing

Argmax releases target macOS as a universal DMG attached to a GitHub Release.
Automatic self-update is deferred and is not part of the current release scope.

## Cutting a Release

Releases are tag-driven. [`.github/workflows/release.yml`](../.github/workflows/release.yml)
runs on a `v*` tag, builds a universal binary on a macOS runner, and opens a
**draft** GitHub Release with the DMG attached.

```bash
# package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json carry the
# same version; move all three, then tag the commit that did it.
git tag v0.5.0
git push origin v0.5.0
```

CI already gated the commit the tag points at, so the release workflow does not
re-run the test matrix — it builds and publishes. The release stays a draft
until you publish it by hand: the DMG is reviewable first, and a botched build
never becomes a download. Paste the `CHANGELOG.md` section for that version in
as the release notes.

`workflow_dispatch` re-runs a failed publish. Select a tag as the ref — the
workflow refuses to release from a branch.

## Signing and Notarization

Without Apple credentials the build falls back to the ad-hoc
`"signingIdentity": "-"` in `tauri.conf.json`. That produces a DMG macOS
refuses to open with *"the developer cannot be verified"*, which is fine for
testing the pipeline and useless for distribution.

A public release needs an Apple Developer Program membership (team
`QPUG98H89L`, Individual), a Developer ID Application certificate, and these
repository secrets:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | The Developer ID `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, e.g. `Developer ID Application: Your Name (TEAM123456)` |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY` | App Store Connect key ID |
| `APPLE_API_KEY_P8` | The `.p8` private key, base64-encoded |

The workflow decodes `APPLE_API_KEY_P8` onto the runner and points Tauri's
`APPLE_API_KEY_PATH` at it, because Tauri reads that key from a file rather
than from a variable. Every one of these is optional: the build skips signing
and notarization when they are absent and picks both up when they appear.

An App Store Connect API key is preferred over the Apple ID route
(`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`). The key is scoped and
revocable, survives an Apple ID password change, and does not need an
app-specific password. Note the variable is `APPLE_PASSWORD`, not
`APPLE_APP_SPECIFIC_PASSWORD`, if you use that route anyway.

**Notarization is not automatic.** `tauri build` signs, notarizes, and staples
in one pass only when the variables are present while it runs. Building first
and exporting the credentials afterwards produces an unnotarized bundle; the
build has to be repeated.

### First-time setup

Once per machine, plus once per certificate expiry (Developer ID certificates
last five years).

**1. Issue the certificate.** In Keychain Access → Certificate Assistant →
*Request a Certificate from a Certificate Authority*, save a CSR to disk. At
[developer.apple.com/account](https://developer.apple.com/account) →
Certificates → **+** → **Developer ID Application**, upload the CSR, download
the `.cer`, and double-click it. Confirm it landed under the right team — an
`Apple Development` certificate is a different thing and cannot sign for
distribution:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# 1) ABC… "Developer ID Application: Adam Thuvesen (QPUG98H89L)"
```

**2. Export it.** In Keychain Access, select the *private key* under that
certificate, right-click → Export, save as `.p12` with a password.

**3. Create the notarization key.** App Store Connect → Users and Access →
Integrations → Keys → **+**, role **Developer**. Keep the issuer ID and key
ID; the `.p8` downloads once and cannot be downloaded again.

**4. Load the secrets.** Run from the repository, with the `.p12` and `.p8`
paths substituted. Every value is read from a file or typed at the prompt, so
none of it lands in shell history:

```bash
base64 -i /path/to/DeveloperID.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD        # prompts
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: Adam Thuvesen (QPUG98H89L)"
gh secret set APPLE_API_ISSUER                  # prompts, the issuer UUID
gh secret set APPLE_API_KEY                     # prompts, the 10-character key ID
base64 -i /path/to/AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY_P8
gh secret list                                  # expect six rows
```

Store the `.p12`, its password, and the `.p8` in 1Password at the same time —
see *Where the credentials live* below. The `.p8` is unrecoverable, and a lost
Developer ID key means revoking the certificate and burning one of the five
Developer ID slots an account ever gets.

### Where the credentials live

Everything is in the personal 1Password account, item **Argmax code signing**
(vault `Personal`): the `.p12` and its password, the Developer ID private key,
the notarization `.p8`, the team ID, the signing identity, and the App Store
Connect issuer and key IDs. Nothing here needs to sit in the repository, and
the `.p8` in particular cannot be downloaded from Apple a second time.

For a local signed build, load them from there. `APPLE_API_KEY_PATH` wants a
file, so the key is written to a temporary one and removed afterwards:

```bash
ACC=my.1password.com
KEY_FILE="$(mktemp -t argmax-notary)"
trap 'rm -f "$KEY_FILE"' EXIT
op read --account "$ACC" --out-file "$KEY_FILE" --force \
  "op://Personal/Argmax code signing/Notarization key p8"

export APPLE_SIGNING_IDENTITY="$(op read --account "$ACC" 'op://Personal/Argmax code signing/Signing identity')"
export APPLE_API_ISSUER="$(op read --account "$ACC" 'op://Personal/Argmax code signing/App Store Connect issuer ID')"
export APPLE_API_KEY="$(op read --account "$ACC" 'op://Personal/Argmax code signing/App Store Connect key ID')"
export APPLE_API_KEY_PATH="$KEY_FILE"

npm run tauri:build:universal
```

Local signing also needs the certificate and key in the login keychain, which
the `.p12` does in one step:

```bash
op read --account "$ACC" --out-file /tmp/argmax-signing.p12 --force \
  "op://Personal/Argmax code signing/Developer ID p12"
security import /tmp/argmax-signing.p12 -k ~/Library/Keychains/login.keychain-db \
  -P "$(op read --account "$ACC" 'op://Personal/Argmax code signing/p12 password')" \
  -T /usr/bin/codesign
rm -f /tmp/argmax-signing.p12
```

A 1Password item title used in an `op://` reference must not contain
parentheses — the CLI rejects the reference rather than the title, which is
why the item is named plainly.

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
npm run tauri:build            # this machine's architecture only
npm run tauri:build:universal  # Intel + Apple silicon, what a release ships
```

Build outputs are placed in `src-tauri/target/release/bundle/`, named
`Argmax_<version>_<arch>.dmg`. The plain build is the faster one for local
checks; what a release publishes is always universal, because a release built
on Apple silicon otherwise ships nothing an Intel Mac can run.

The universal build needs both Rust targets. A Mac that has only ever built
for itself has one, and `tauri build` does not say so until it has finished
compiling the first architecture and failed on the second:

```bash
rustup target add x86_64-apple-darwin
```

The release workflow installs both, so this is a local-only trap.

Argmax → Check for Updates… opens the GitHub Releases page, because that is
where a build actually comes from today. The checked-in updater configuration
is incomplete and is not an active release channel. If automatic self-update becomes a requirement later, it needs a
dedicated signing key, updater artifacts and a published feed. See
[Tauri's updater guide](https://v2.tauri.app/plugin/updater/) for that optional
artifact and feed contract.

## Verification

1. Build the app and DMG.
2. For a public signed release, verify Gatekeeper validation and that the
   notarization ticket is stapled — the second check is what proves the DMG
   opens on a machine that has never seen it, offline:

```bash
spctl --assess --type execute /Applications/Argmax.app
xcrun stapler validate /Applications/Argmax.app
```

3. Verify app launch, provider execution, chat resume, terminal PTY and diff rendering.
4. Publish the draft release and update the Homebrew cask — see
   [homebrew.md](homebrew.md).
