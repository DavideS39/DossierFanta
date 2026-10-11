#!/usr/bin/env python3
"""
preprocess_sheets.py — normalizza i fogli strappati per le FINESTRE WM (v2.3.4).

Input : PNG RGBA con sagoma strappata su fondo trasparente (1.png, 2.png, 3.png)
Output: src/assets/paper/sheet-<n>.webp  (RGBA, ritagliate, larghezza 760px)
        stdout: meta (aspect, alpha edges, x riga rosa) da incollare in index.ts

I fogli sono usati come fondo delle finestre del Window Manager in-app:
la sagoma strappata (alpha) proietta la propria ombra sulla scrivania via
filter: drop-shadow(), come le cartoline delle card (Cap.16).

Uso:  python3 scripts/preprocess_sheets.py --src <dir con 1.png 2.png 3.png>
Richiede: Pillow, numpy
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image

ALPHA = 128
OUT_W = 760


def alpha_edges(alpha: np.ndarray):
    """Profilo bordi: p50/p92 della profondità del margine trasparente (%)."""
    h, w = alpha.shape
    op = alpha > ALPHA
    res = {}
    top = np.argmax(op, axis=0).astype(float)
    bot = (h - 1 - np.argmax(op[::-1], axis=0)).astype(float)
    lef = np.argmax(op, axis=1).astype(float)
    rig = (w - 1 - np.argmax(op[:, ::-1], axis=1)).astype(float)
    res["top"] = [round(float(np.percentile(top, p)) / h * 100, 2) for p in (50, 92)]
    res["bottom"] = [round((h - 1 - np.percentile(bot, p)) / h * 100, 2) for p in (50, 92)]
    res["left"] = [round(float(np.percentile(lef, p)) / w * 100, 2) for p in (50, 92)]
    res["right"] = [round((w - 1 - np.percentile(rig, p)) / w * 100, 2) for p in (50, 92)]
    return res


def pink_margin_x(rgb: np.ndarray, alpha: np.ndarray) -> float | None:
    """x (%) della riga di margine rosa/rossa verticale, se presente."""
    h, w, _ = rgb.shape
    op = alpha > ALPHA
    r = rgb[:, :, 0].astype(int)
    g = rgb[:, :, 1].astype(int)
    b = rgb[:, :, 2].astype(int)
    pinkish = (r - g > 28) & (r - b > 28) & (r > 150) & op
    if pinkish.sum() < h * 0.25:
        return None
    colcount = pinkish.sum(axis=0)
    x = int(np.argmax(colcount))
    if colcount[x] < h * 0.35:
        return None
    return round(x / w * 100, 2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default=os.path.join("src", "assets", "paper"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    meta = {}
    for n in (1, 2, 3):
        path = os.path.join(args.src, f"{n}.png")
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert("RGBA")
        a = np.array(im.getchannel("A"))
        op = a > ALPHA
        ys, xs = np.where(op)
        box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        im = im.crop(box)
        w, h = im.size
        scale = OUT_W / w
        im = im.resize((OUT_W, max(1, round(h * scale))), Image.LANCZOS)
        out = os.path.join(args.out, f"sheet-{n}.webp")
        im.save(out, "WEBP", quality=88, method=6)
        arr = np.array(im)
        meta[f"sheet-{n}"] = {
            "file": f"sheet-{n}.webp",
            "w": im.size[0],
            "h": im.size[1],
            "aspect": round(im.size[0] / im.size[1], 4),
            "pink_margin_x_pct": pink_margin_x(arr[:, :, :3], arr[:, :, 3]),
            "alpha_edges_pct": alpha_edges(arr[:, :, 3]),
            "bytes": os.path.getsize(out),
        }
        print(json.dumps({f"sheet-{n}": meta[f"sheet-{n}"]}, indent=2))


if __name__ == "__main__":
    main()
