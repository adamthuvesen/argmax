# Homebrew

`brew install --cask argmax` is what a developer-tool audience reaches for
first. [`Casks/argmax.rb`](../Casks/argmax.rb) in this repo is the source of
truth for that cask; Homebrew never reads it from here, so publishing means
copying it into a tap.

## A personal tap, for now

The main `homebrew-cask` repository gates on notability: a project needs
**75 stars, 30 forks, or 30 watchers**, and **225 stars, 90 forks, or 90
watchers** when the repository's own owner submits it. Repositories younger
than 30 days are generally ineligible regardless. Argmax is nowhere near
those numbers, so core is out of reach and a personal tap is the answer —
it needs no review and works identically for the user.

A tap is an ordinary public GitHub repository named `homebrew-<name>`:

```
adamthuvesen/homebrew-tap
└── Casks/
    └── argmax.rb
```

Users then run:

```bash
brew install --cask adamthuvesen/tap/argmax
```

The `homebrew-` prefix is implied, which is why the command says `tap` and the
repository says `homebrew-tap`. Revisit core once the star count clears the
owner-submission bar.

## Per release

After [publishing the draft release](release.md#cutting-a-release):

1. Download the DMG the release attached and hash it:

   ```bash
   shasum -a 256 Argmax_<version>_universal.dmg
   ```

2. Update `version` and `sha256` in `Casks/argmax.rb` here, in the same commit
   that moves the app version if you can.
3. Copy the file to `Casks/argmax.rb` in the tap and push.
4. Verify against the published cask, not the local file:

   ```bash
   brew update
   brew info --cask adamthuvesen/tap/argmax
   brew install --cask adamthuvesen/tap/argmax
   ```

`brew audit --cask --online adamthuvesen/tap/argmax` catches a stale hash, a
dead URL, and the style problems core would reject — worth running even while
the cask lives in a personal tap.

## Until the app is signed

A cask is not a way around Gatekeeper. An unsigned, un-notarized build still
triggers *"the developer cannot be verified"* on first launch when it arrives
through Homebrew, so the cask is worth publishing but does not substitute for
signing. See [release.md](release.md#signing-and-notarization) for what closes
that gap.
