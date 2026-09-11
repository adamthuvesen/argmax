# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.55", "brotli>=1.1"]
# ///
"""Generate the iPhone app's bundled Geist and Inter faces.

The renderer gets both families from @fontsource as woff2, which iOS cannot
register: `UIAppFonts` takes TrueType. Rather than vendor a second copy of the
families by hand, this decompresses the very files the desktop ships, so the
two halves of Argmax can never drift onto different cuts of the same typeface.

Inter is published as a variable font, so each weight is a static instance
snapped out of it. Geist ships no italic at all, so its two cuts that carry
markdown emphasis are sheared here. Inter's matching italic cuts are taken
from its actual italic variable font. iOS can then resolve emphasis through
the family instead of silently drawing it upright.

Run with `npm run build:ios-fonts`; the .ttf output is committed, because an
Xcode build must not need Python.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ios/Argmax/Resources/Fonts"

# The four cuts the type scale asks for. Anything heavier or lighter would be
# bytes in the app that nothing draws.
WEIGHTS = {400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold"}

# Shallow enough to read as emphasis rather than as a second typeface. Geist
# is a geometric sans, and past about 12 degrees a sheared one starts to look
# like a mistake.
ITALIC_ANGLE = 11.0
# Only the two cuts markdown emphasis reaches: *emphasis* and ***both***.
ITALIC_WEIGHTS = {400: "Regular", 700: "Bold"}

SANS_STATIC = "node_modules/@fontsource/geist-sans/files/geist-sans-latin-{weight}-normal.woff2"
INTER_VARIABLE = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
INTER_ITALIC_VARIABLE = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2"


def convert_static(source: Path, target: Path) -> None:
    font = TTFont(source)
    font.flavor = None
    font.save(target)


def convert_instance(source: Path, target: Path, weight: int) -> None:
    variable = TTFont(source)
    variable.flavor = None
    static = instancer.instantiateVariableFont(
        variable, {"wght": weight}, inplace=False, updateFontNames=True
    )
    static.save(target)


def shear_to_italic(source: Path, target: Path, weight_name: str) -> None:
    """Slant a face in place of the italic Geist does not ship.

    The outlines are CFF, so each glyph is redrawn through a shear rather than
    having its coordinates transformed. The name and style bits matter as much
    as the shapes: they are how CoreText finds this face when SwiftUI asks the
    family for its italic, which is the only way an emphasised run in an
    `AttributedString` can reach it.
    """
    font = TTFont(source)
    glyphs = font.getGlyphSet()
    cff = font["CFF "].cff
    top = cff[cff.fontNames[0]]
    shear = math.tan(math.radians(ITALIC_ANGLE))
    for name in font.getGlyphOrder():
        glyph = glyphs[name]
        pen = T2CharStringPen(glyph.width, glyphs)
        glyph.draw(TransformPen(pen, (1, 0, shear, 1, 0, 0)))
        top.CharStrings[name] = pen.getCharString(private=top.Private)

    top.rawDict["ItalicAngle"] = -ITALIC_ANGLE
    top.ItalicAngle = -ITALIC_ANGLE
    font["post"].italicAngle = -ITALIC_ANGLE
    # macStyle bit 1 and fsSelection bit 0 are "italic"; fsSelection bit 6 is
    # "regular", and a face cannot honestly claim both.
    font["head"].macStyle |= 1 << 1
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~(1 << 6)) | 1
    if weight_name == "Bold":
        # The upright Geist Bold declares its weight only in usWeightClass, so
        # the sheared cut has to say "bold" the older two ways as well — with
        # neither bit set, CoreText answers a request for bold italic with the
        # 400 italic.
        font["head"].macStyle |= 1
        font["OS/2"].fsSelection |= 1 << 5
    style = "Italic" if weight_name == "Regular" else f"{weight_name} Italic"
    postscript = f"Geist-{'Italic' if weight_name == 'Regular' else weight_name + 'Italic'}"
    for record in font["name"].names:
        if record.nameID == 2:
            record.string = "Italic" if weight_name in {"Regular", "Bold"} else style
        elif record.nameID == 4:
            record.string = f"Geist {style}"
        elif record.nameID == 6:
            record.string = postscript
        elif record.nameID == 17:
            record.string = style
    font.save(target)


def postscript_name(path: Path) -> str:
    return TTFont(path)["name"].getDebugName(6)


def main() -> int:
    missing = [candidate for candidate in [ROOT / INTER_VARIABLE, ROOT / INTER_ITALIC_VARIABLE]
        + [ROOT / SANS_STATIC.format(weight=weight) for weight in WEIGHTS]
        if not candidate.exists()]
    if missing:
        print(
            "missing @fontsource sources — run `npm install` first:\n  "
            + "\n  ".join(str(path.relative_to(ROOT)) for path in missing),
            file=sys.stderr,
        )
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for weight, name in WEIGHTS.items():
        sans = OUT / f"Geist-{name}.ttf"
        convert_static(ROOT / SANS_STATIC.format(weight=weight), sans)
        inter = OUT / f"Inter-{name}.ttf"
        convert_instance(ROOT / INTER_VARIABLE, inter, weight)
        written += [sans, inter]
        if name in ITALIC_WEIGHTS.values():
            geist_italic = OUT / f"Geist-{'Italic' if name == 'Regular' else name + 'Italic'}.ttf"
            shear_to_italic(sans, geist_italic, name)
            inter_italic = OUT / f"Inter-{'Italic' if name == 'Regular' else name + 'Italic'}.ttf"
            convert_instance(ROOT / INTER_ITALIC_VARIABLE, inter_italic, weight)
            written += [geist_italic, inter_italic]

    for path in written:
        print(f"{path.relative_to(ROOT)}  {postscript_name(path)}  {path.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
