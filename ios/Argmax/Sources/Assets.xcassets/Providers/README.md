# Provider marks

The five CLIs' own brand marks, one imageset each, read by
`Sources/Design/ProviderMark.swift` as `Image("Providers/<id>")`.

Each is an SVG with **Preserve Vector Data** and **template** rendering
intent, so one file draws at 16pt in a list row and at 40pt in a preview
without a second rendition, and the app tints it — these are never drawn in
a brand colour. See the design brief's rule on the accent in
`docs/plan/hybrid-native-phone.md`: the accent marks the running work and the
primary action, so a provider mark sits in `Theme.muted`.

Not editable art. To replace one, re-download from the source below rather
than redrawing it, and update this table in the same change.

| id | mark | source | reached via | first-party | fetched | cleanup |
|---|---|---|---|---|---|---|
| `claude` | Claude sunburst | `https://claude.ai/favicon.svg` | claude.ai's own served favicon | yes | 2026-09-10 | dropped `width`/`height`, `fill` → template |
| `codex` | OpenAI Blossom | `https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg` | the `<img>` for "OpenAI Blossom" on `openai.com/brand` | yes | 2026-09-10 | the source is a spec sheet: construction guides and the duplicate glyph removed, viewBox cropped to the remaining one |
| `cursor` | Cursor cube | `https://cursor.com/favicon.svg` | cursor.com's own served favicon | yes | 2026-09-10 | dropped the rounded-square tile behind the glyph, viewBox cropped to the glyph |
| `opencode` | opencode frame | `https://raw.githubusercontent.com/sst/opencode/dev/packages/console/app/src/asset/brand/opencode-logo-light-square.svg` | the brand directory the project's own README links | yes | 2026-09-10 | mask and group transform baked into the coordinates; the mark's lighter second tone dropped, leaving the frame the primary ink draws — in one colour the two tones merge and the gap between them reads as a printing fault |
| `grok` | xAI Grok glyph | `https://x.ai/legal/brand-guidelines` (inline `<svg>`) | xAI's brand-guidelines page, which serves the glyph inline rather than as a file | yes | 2026-09-10 | `fill="currentColor"` → template; 34×32 viewBox centred in a square so it is not stretched into one |

`openai.com`, `x.ai` and `grok.com` all refuse a plain `curl`, and neither
xAI domain serves the glyph as a downloadable file — hence the two sources
above that are a page rather than an asset URL. No third-party icon set was
used for any of the five.
