#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Recover a transparent PNG from the same image rendered on white and on black.

WHY THIS EXISTS
---------------
An AMO listing icon should have a transparent background so AMO can composite
it on a light or a dark card. Playwright's `omitBackground` does exactly that -
but not in Firefox, which answers "page.screenshot: Not implemented", and
Firefox is the only browser installed here. There is also no ImageMagick,
Inkscape, rsvg-convert or cairosvg on this machine (and the `convert` on PATH
is Windows' own convert.exe, which fails with "Invalid drive specification" -
a memorably unhelpful way to not build an icon).

So the icon is rendered TWICE by the real Firefox engine, once on white and
once on black, and the alpha is recovered arithmetically. For a pixel of true
colour C and true alpha a, compositing gives:

    on white:  Cw = a*C + (1 - a)*255
    on black:  Cb = a*C + (1 - a)*0   = a*C

Subtracting:   Cw - Cb = (1 - a)*255
Therefore:     a  = 1 - (Cw - Cb)/255
and:           C  = Cb / a            (for a > 0)

That is exact, not an approximation, and it handles antialiased edges properly -
which a "render on magenta and key it out" approach does not, because keying
leaves a halo wherever the glyph is partially transparent.

Usage:
    python tools/recover-alpha.py <on-white.png> <on-black.png> <out.png>
"""

import io
import sys

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from PIL import Image
except ImportError:
    print("recover-alpha.py: Pillow is required (pip install Pillow)", file=sys.stderr)
    raise SystemExit(2)


def recover(white_path, black_path, out_path):
    w = Image.open(white_path).convert("RGB")
    b = Image.open(black_path).convert("RGB")

    if w.size != b.size:
        raise SystemExit(
            "recover-alpha.py: size mismatch {} vs {}".format(w.size, b.size)
        )

    wpx = w.load()
    bpx = b.load()
    out = Image.new("RGBA", w.size, (0, 0, 0, 0))
    opx = out.load()

    width, height = w.size
    for y in range(height):
        for x in range(width):
            rw, gw, bw_ = wpx[x, y]
            rb, gb, bb = bpx[x, y]

            # Alpha from each channel; average to damp per-channel rounding.
            # Subpixel antialiasing would make the three disagree, which is why
            # they are averaged rather than one being trusted.
            a_r = 255 - (rw - rb)
            a_g = 255 - (gw - gb)
            a_b = 255 - (bw_ - bb)
            a = (a_r + a_g + a_b) / 3.0
            a = max(0.0, min(255.0, a))

            if a <= 0.5:
                opx[x, y] = (0, 0, 0, 0)
                continue

            scale = 255.0 / a
            opx[x, y] = (
                max(0, min(255, int(round(rb * scale)))),
                max(0, min(255, int(round(gb * scale)))),
                max(0, min(255, int(round(bb * scale)))),
                int(round(a)),
            )

    out.save(out_path, "PNG", optimize=True)

    # Report enough to tell a working icon from an empty one without opening it.
    alpha = out.getchannel("A")
    nonzero = sum(1 for v in alpha.getdata() if v > 0)
    total = width * height
    return width, height, nonzero, total


def main():
    if len(sys.argv) != 4:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    wpath, bpath, opath = sys.argv[1:4]
    width, height, nonzero, total = recover(wpath, bpath, opath)
    pct = (100.0 * nonzero / total) if total else 0.0
    print(
        "  {}  {}x{}  {} of {} px opaque ({:.1f}%)".format(
            opath, width, height, nonzero, total, pct
        )
    )
    if nonzero == 0:
        print("recover-alpha.py: output is fully transparent - the render "
              "produced nothing", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
