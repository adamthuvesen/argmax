# Pixel fox, round two

Concept mockups for pushing the shipped fox further, cute or cool, without
leaving its pixel style. Every sprite here keeps the fox's 28-wide logical grid
and its seven-colour ramp; three add one extra colour each, called out below.

`node docs/design/mascot-concepts/pixel-fox-v2/render.mjs` rebuilds the PNGs.
Each `NN-name.png` shows the sprite large on the light and dark fields, then at
roughly the 64pt and 32pt icon sizes. `sheet.png` stacks them all.

`sprites/*.txt` are the source. Files drawn at 1x use `e` for the shipped fox's
half-outline, half-highlight eye pixel; `--expand <name>` prints the 2x grid in
the format `assets/fox-mascot.txt` expects, so a chosen sprite is a paste.

## Variants

| # | name | direction | palette | notes |
| - | ---- | --------- | ------- | ----- |
| 00 | current | reference | as shipped | the fox as it ships today |
| 01 | chibi | cute | as shipped, plus blush | sitting front-on, big head, 3x4 eyes, tail curled round. New pose, so the biggest change |
| 02 | sleepy | cute | as shipped, plus blush | the chibi head dozing on its tail with a z. Reads as a mood of 01 |
| 03 | peek | cute | as shipped | head and paws hooked over a ledge. Reads best of all at 32pt |
| 04 | shades | cool | as shipped | the shipped fox in sunglasses. Body untouched |
| 05 | visor | cool | plus one accent | cyan visor across the eyes. Same geometry as 04 |
| 06 | crown | cool and cute | plus gold | small crown between the ears. Body untouched |
| 07 | headphones | cool | as shipped | band on the crown, a cup each side. Body untouched |
| 08 | wink | cute | plus blush | far eye shut in a happy arc, tongue out. Body untouched |
| 09 | sparkle | cute | plus gold | star-shaped eye highlights and three sparkles |

## What promoting one costs

- **Body-untouched variants (04, 06, 07, 08, 09)** drop straight into
  `assets/fox-mascot.txt`. The mascot's existing blink and hop still fit.
- **The extra colours** (`p` blush, `g` gold, `a` accent) each need one palette
  entry in `scripts/build-icons.mjs`, one layer in `Mascot.tsx`, and one
  `--fox-*` token in `tokens.css`. Blush and gold sit fine on both fields; the
  visor's cyan is the only colour that is off-brand and would want tuning.
- **New poses (01, 02, 03)** are taller than the 28 x 20 sprite. `Mascot.tsx`
  squares its viewBox off the width and drops the thinking rain four rows below
  the sprite, so a 25-row sprite pushes the rain outside the box; the rain
  offset has to come from the height instead. `build-icons.mjs` centres on the
  width, so a taller sprite simply fills more of the squircle, which helps the
  icon.
- **The blink** scales the highlight group around a fixed point on the shipped
  face. The chibi and peek eyes sit elsewhere, so that origin moves with them.

## Tried and dropped

- **Running pose.** Two attempts at a full-sprint fox with a streaming tail.
  Both read as a rodent: at 28 wide the head shrinks and the tail merges into
  the body. Motion needs more pixels than the grid gives.
- **Curled-up loaf.** A side-on fox asleep in a ball. The body became a blob
  and the face got squeezed into the corner. 02 keeps the sleeping idea by
  reusing the chibi head, which is what actually carries the read.

## Outcome

Shipped on 2026-09-04 as expression sprites beside the base:
`assets/fox-mascot-wink.txt` (08, pet reaction), `assets/fox-mascot-sleepy.txt`
(the shut eyes and z of 02 drawn on the shipped body), and
`assets/fox-mascot-shades.txt` (04, earned by ten pets in a row). The launcher
hero also uses the existing thinking rain while an agent runs in its project.
Chibi, peek, crown, headphones, visor and sparkle stay here as a bank.
