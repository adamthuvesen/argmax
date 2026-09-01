# Pixel fox

A fourth mascot round, worked from a reference sprite rather than concept art.
Everything here derives from one 28 x 20 sprite drawn at 2x, so the whole set
shares a silhouette and a seven-colour ramp.

## Files

`sprites/*.txt` are the source. One character per pixel:

| char | meaning | char | meaning |
| ---- | ------- | ---- | ------- |
| `.`  | field   | `c`  | cream |
| `o`  | fur     | `t`  | cream shadow |
| `d`  | fur shadow | `x` | nose |
| `K`  | outline | `w`  | eye highlight |

`node docs/design/mascot-concepts/pixel-fox/render.mjs` rebuilds every PNG from
them. The two sheets are hand-composed review comps and are not regenerated.

## Variations

- **01-reference** — pixel-exact recreation of the reference art.
- **02-head** — the head alone, closed off with a chin so it stands as a mark.
- **03-wink** — the same sprite with the far eye shut, as a second mood.

Each of `01` and `02` also renders in four brand palettes: `argmax-warm` (the
`orange` accent), `violet` (the shades the current app icon carries), and a
`dark-warm` / `dark-violet` pair whose outline lifts off charcoal instead of
disappearing into it.

## Recovering the reference

The reference was a 15x upscale on an avatar, not a sprite sheet, so the grid
had to be recovered: a Fourier fit over the edge-gradient profile put the pitch
at 15.0px and the phase at x=162.14, y=291.24. Classifying every source pixel to
the nearest palette entry and taking the mode per cell gives the sprite back
exactly. 572 of 588 cells resolve to uniform 2x2 blocks — the sprite is 28 x 20
drawn at 2x, and only the eye highlights and the nose use the finer grid.

## Outcome

`01-reference` shipped. It lives at [assets/fox-mascot.txt](../../../../assets/fox-mascot.txt),
which both `Mascot.tsx` and `scripts/build-icons.mjs` read, so the in-app mascot
and the app icon are the same sprite. The files here stay as the round's record.

## What this round found

- **The fox does not survive being reduced to one colour.** Its read depends
  entirely on cream separating from orange (muzzle, ear insides, chest, tail
  tip). Every one-colour reduction tried — fur solid, fur plus cream, outline
  open — came out as an indistinct cat. This is what decided the shape of the
  integration: `Mascot.tsx` is now a multi-colour sprite, and the accent it used
  to wear survives only on the thinking rain.
- **The head reads far smaller than the body.** See `sheet-sizes.png`: at the
  18px and 24px slots the full body turns to mush, while the head still reads.
  If the fox ships, the head is the chrome mark and the body is for the 72px
  empty state and the app icon.
- **The reference orange is already almost on-brand.** `#c6663a` sits between the
  light and dark `orange` accents (`#a85c43` / `#d97757`), so the untouched
  reference palette does not clash with the app.
- **A sitting pose is still open.** Three attempts at one are in the history and
  none were good enough to keep; the body wants redrawing by hand rather than
  composing from the reference's parts.
