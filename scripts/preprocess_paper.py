#!/usr/bin/env python3
"""
preprocess_paper.py — normalizza le texture carta fotografiche per le card.

Input : 5 PNG RGBA con sagoma strappata su fondo trasparente (uploads/ o --src)
Output: src/assets/paper/paper-<n>.webp  (RGBA, ritagliate, larghezza 720px)
        src/assets/paper/paper-meta.json (aspect + geometrie misurate)

Per ogni immagine:
  1. crop sul bounding-box dell'alpha (via i margini trasparenti);
  2. crop leggero (lato configurato) per rientrare nella banda postcard
     1.50-1.75 senza distorcere la foto (niente stretch);
  3. resize a larghezza 720px (LANCZOS) ed export WebP RGBA q=84;
  4. misura delle geometrie utili al layout UI:
       - aspect ratio finale
       - x della riga di margine rosa (pixel rossi colonna)
       - profilo dei bordi: per ogni lato, profondita' p50/p92 del bordo
         opaco (serve a definire le safe-area del contenuto nelle card).

Uso:  python3 scripts/preprocess_paper.py --src <dir con 1..5.png>
Richiede: Pillow, numpy
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image

# config per immagine: target aspect (None = giữ naturale) e lato da ritagliare
CFG = {
    # n: (target_aspect, crop_side)  crop_side: lato DA cui tagliare px in eccesso
    1: (None, None),      # bigliettino orizzontale (empty state / masthead), fuori banda ok
    2: (1.50, "bottom"),  # fori in alto -> si taglia il fondo
    3: (1.75, "right"),   # fori a sx     -> si taglia il destro
    4: (None, None),      # già in banda (1.607)
    5: (None, None),      # già in banda (1.705)
}

BAND = (1.50, 1.75)
OUT_W = 720
ALPHA = 128


def alpha_edges(alpha: np.ndarray):
    """Profilo dei bordi: per ogni lato ritorna p50/p92 della profondita'
    del margine trasparente (in % della dimensione ortogonale)."""
    h, w = alpha.shape
    op = alpha > ALPHA
    res = {}
    # top: prima riga opaca per colonna
    top = np.argmax(op, axis=0).astype(float)
    bot = (h - 1 - np.argmax(op[::-1], axis=0)).astype(float)
    lef = np.argmax(op, axis=1).astype(float)
    rig = (w - 1 - np.argmax(op[:, ::-1], axis=1)).astype(float)
    res["top"] = [round(float(np.percentile(top, p)) / h * 100, 2) for p in (50, 92)]
    res["bottom"] = [round((h - 1 - np.percentile(bot, p)) / h * 100, 2) for p in (50, 92)]
    res["left"] = [round(float(np.percentile(lef, p)) / w * 100, 2) for p in (50, 92)]
    res["right"] = [round((w - 1 - np.percentile(rig, p)) / w * 100, 2) for p in (50, 92)]
    return res


def pink_margin(rgb: np.ndarray) -> float | None:
    """x (%) della riga di margine rosa/rossa verticale, se presente."""
    r = rgb[..., 0].astype(int)
    g = rgb[..., 1].astype(int)
    b = rgb[..., 2].astype(int)
    mask = (r - g > 28) & (r - b > 18) & (r > 120)
    cols = mask.sum(axis=0)
    h = rgb.shape[0]
    cand = np.where(cols > h * 0.35)[0]
    if len(cand) == 0:
        return None
    # centro del primo gruppo contiguo di colonne rosa
    groups = np.split(cand, np.where(np.diff(cand) > 4)[0] + 1)
    g0 = groups[0]
    return round(float(g0.mean()) / rgb.shape[1] * 100, 2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="uploads")
    ap.add_argument("--out", default=os.path.join("src", "assets", "paper"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    meta = {}

    for n in range(1, 6):
        path = os.path.join(args.src, f"{n}.png")
        if not os.path.exists(path):
            print(f"skip {n}: {path} non trovato")
            continue
        im = Image.open(path).convert("RGBA")
        a = np.array(im)
        alpha = a[..., 3]
        ys, xs = np.where(alpha > ALPHA)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        im = im.crop((x0, y0, x1 + 1, y1 + 1))

        target, side = CFG[n]
        w, h = im.size
        aspect = w / h
        if target is None and not (BAND[0] <= aspect <= BAND[1]) and n != 1:
            target = BAND[0] if aspect < BAND[0] else BAND[1]
            side = side or ("bottom" if aspect < BAND[0] else "right")
        if target:
            w, h = im.size
            if w / h < target:  # troppo alta -> taglia altezza
                nh = round(w / target)
                if side == "bottom":
                    im = im.crop((0, 0, w, nh))
                else:
                    im = im.crop((0, h - nh, w, h))
            elif w / h > target:  # troppo larga -> taglia larghezza
                nw = round(h * target)
                if side == "right":
                    im = im.crop((0, 0, nw, h))
                else:
                    im = im.crop((w - nw, 0, w, h))

        w, h = im.size
        scale = OUT_W / w
        im = im.resize((OUT_W, round(h * scale)), Image.LANCZOS)

        arr = np.array(im)
        edges = alpha_edges(arr[..., 3])
        pink = pink_margin(arr[..., :3])

        out_path = os.path.join(args.out, f"paper-{n}.webp")
        im.save(out_path, "WEBP", quality=84, method=6)
        meta[f"paper-{n}"] = {
            "file": f"paper-{n}.webp",
            "w": im.size[0],
            "h": im.size[1],
            "aspect": round(im.size[0] / im.size[1], 4),
            "pink_margin_x_pct": pink,
            "alpha_edges_pct": edges,
            "bytes": os.path.getsize(out_path),
        }
        print(f"paper-{n}.webp {im.size[0]}x{im.size[1]} aspect={im.size[0]/im.size[1]:.3f} "
              f"pink={pink} edges={edges} {os.path.getsize(out_path)//1024}KB")

    with open(os.path.join(args.out, "paper-meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print("meta ->", os.path.join(args.out, "paper-meta.json"))


if __name__ == "__main__":
    main()
