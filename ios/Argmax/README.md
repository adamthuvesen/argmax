# Argmax for iPhone

A one-web-view shell around the same `mobile.html` the browser loads, in an app
that owns its window. That is what it buys: full height with correct safe-area
insets, no standalone-PWA viewport bugs, an icon, and a launch screen. The UI
inside is the same React app — the shell fixes the container, not the content.

For measuring viewport behaviour, use [../probe](../probe) instead; it prints
the numbers. This is the app you actually carry.

## Build and install

The project is generated, so start there:

```bash
brew install xcodegen   # once, if you don't have it
cd ios/Argmax && xcodegen
open Argmax.xcodeproj
```

Then in Xcode: select the **Argmax** target → Signing & Capabilities → pick your
team, plug in the phone, and Run.

A **free Apple Account works** — sign into Xcode with your normal Apple ID and
it appears as a Personal Team. The catch is that its provisioning profile
expires **7 days** from issuance, after which the app stops launching until you
rebuild from Xcode. The paid Developer Program ($99/yr) removes that expiry; it
buys nothing else you need here, since this never sees the App Store and
notifications already arrive through ntfy.

From the command line instead:

```bash
xcodebuild -project Argmax.xcodeproj -scheme Argmax \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your-team-id> build
```

## Pairing

On first launch the app asks for the pairing link from **Argmax → Settings →
Integrations → Remote access**. Paste it whole: the token rides in the URL
fragment, and the port matters — a link without `:8790` goes to port 80 and the
connection is refused.

The link is a credential, so it lives in the keychain rather than
`UserDefaults`, which would put it in an unencrypted backup.

**Shake the phone** to re-pair against a different Mac or a rotated token.

## Known edges

`NSAllowsArbitraryLoads` is on, because the bridge serves plain HTTP and a
`*.ts.net` host is an ordinary DNS name that `NSAllowsLocalNetworking` does not
cover. Once Tailscale Serve terminates TLS, delete that key from `project.yml`
— and note the page only becomes a secure context then, so `crypto.randomUUID`
and `navigator.clipboard` stay missing until it does.
