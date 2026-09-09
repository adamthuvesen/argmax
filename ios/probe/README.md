# WKWebView probe

One question: how much of the phone's trouble is the *standalone-PWA container*
rather than the web app itself? This is the smallest thing that can answer it —
a bare WKWebView loading the same `mobile.html` the home-screen icon loads, in
an app that owns its own window.

```bash
ios/probe/run.sh              # defaults to "iPhone 17 Pro"
```

It reads the port and token from `remote.json`, builds with `swiftc` (no Xcode
project), installs on a booted simulator, and prints a sample every second:

```
PROBE screen=874 {"layout":874,"visual":874,"offset":0,"keyboardInset":"0px", …}
```

`screen` is the native view height. While the keyboard is closed, `layout`
should equal it. If `layout` ever falls below `screen` and stays there after the
keyboard closes, the stuck-viewport bug followed us into the shell.

## What the probe deliberately does not do

It never resizes the web view for the keyboard and never sets
`additionalSafeAreaInsets`. WebKit already subtracts the keyboard from
`innerHeight`; a native frame change on `keyboardWillShow` subtracts it twice
and opens the very gap this exists to rule out. The page's own
`useVisualViewportInsets` stays the single authority on keyboard geometry.

## Reading the results

`standalone` is `false` here, so `remeasureStuckViewport` in
[useVisualViewportInsets.ts](../../src/renderer/mobile/useVisualViewportInsets.ts)
is inert — the PWA-only workaround costs nothing in a shell.

`secureContext` is `true` **only because the simulator reaches the host over
loopback**, which is a trustworthy origin. A real phone comes in over the
tailnet on a plain-HTTP origin and will report `false`. Don't read this field as
evidence that a shell fixes the insecure-context problem; only TLS does.

The keyboard cases need a human tap: WKWebView will not raise the keyboard for
a programmatic `focus()` outside a user gesture. Tap the composer in the
simulator and watch the stream.
