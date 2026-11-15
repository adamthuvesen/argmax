# Homebrew

`brew install --cask argmax` is what a developer-tool audience reaches for
first. [`Casks/argmax.rb`](../Casks/argmax.rb) in this repo is the source of
truth for that cask; Homebrew never reads it from here, so publishing means
copying it into a tap.

## A personal tap, for now

The cask is intended for a personal tap. The checked-in `sha256` is a
placeholder and must be replaced with the published DMG hash before use.

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
repository says `homebrew-tap`. Check Homebrew’s current submission requirements before proposing the cask to core.

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

## Signing

The release workflow can produce an unsigned build when credentials are missing.
Verify signing and notarization for the DMG before publishing the cask.
See [release.md](release.md#signing-and-notarization).
