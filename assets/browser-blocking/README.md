# Browser blocking data

`light.txt` is an unchanged snapshot of [HaGeZi Multi LIGHT](https://github.com/hagezi/dns-blocklists).
It is third-party data licensed separately under GPL-3.0. The complete license
is in `COPYING`, and `source.json` records the immutable source URL, revision,
domain count, and SHA-256. Argmax's MIT license does not cover this ruleset.

These files ship together in the app's `browser-blocking` resources directory.
Keep the source, notices, provenance, and license with redistributed copies.
Argmax converts the domain rules into WebKit content rules at runtime. It does
not implement cosmetic filtering or the contextual rules of a full ad blocker.

To refresh, review a full upstream commit SHA, then run:

```sh
node scripts/update-browser-blocklist.mjs <full-commit-sha>
```

Review the diff and run the browser rule tests and native verification before
committing. Updates ship with Argmax releases. Browsing does not contact the
list provider or download updates in the background.
