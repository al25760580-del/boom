#!/usr/bin/env python3
"""
explode.py - Python port of https://explode.moth.monster/  (mothdotmonster, MIT-0)

The original site:
  * fills the canvas with white (#FFF), pastes your image, applies the
    explode()/implode() effect and then draws the explosion frames on top.
  * encodes with gif.js at 512x512, with no transparency.

This version:
  * TRANSPARENT (RGBA) canvas -> the alpha of your PNG is preserved.
  * real alpha compositing (alpha_composite) instead of drawImage over white.
  * animated GIF output with transparency and a FILE SIZE BUDGET: it searches
    for the best combination of resolution / colors / lossy smoothing / frame
    skipping that fits the budget (250 KB by default).

Requirements: Pillow, numpy. Optional but recommended: ffmpeg (imageio-ffmpeg)
and gifsicle (a binary is bundled in tools/).

Usage:
    python3 explode.py input.png --fx nuke airstrikes jet --max-kb 250
    python3 explode.py input.png --fx nuke --size 512 --keep-aspect --format gif,webp
"""
import argparse, math, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "modules", "explode", "res")
def _ensure_exec(path):
    """The workspace does not always keep the +x bit: restore it (or copy to /tmp)."""
    if not path or not os.path.exists(path):
        return shutil.which("gifsicle")
    if os.access(path, os.X_OK):
        return path
    try:
        os.chmod(path, 0o755)
        if os.access(path, os.X_OK):
            return path
    except Exception:
        pass
    try:
        alt = os.path.join(tempfile.gettempdir(), "gifsicle")
        shutil.copy(path, alt)
        os.chmod(alt, 0o755)
        return alt
    except Exception:
        return None


GIFSICLE = _ensure_exec(os.path.join(HERE, "tools", "gifsicle"))
def _find_ffmpeg():
    """pip packages do not survive the workspace: install ffmpeg on demand."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "imageio-ffmpeg"],
                       capture_output=True, timeout=600)
        import importlib
        importlib.invalidate_caches()
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = _find_ffmpeg()

# folder, first frame, last frame, delay ms, delay of the first frame, mode
FX = {
    "nuke":       ("nuke",       0, 21, 40,  0,   "explode"),
    "house":      ("house",      8, 35, 40,  0,   "explode"),
    "earth":      ("earth",      0, 29, 40,  0,   "explode"),
    "supernova":  ("supernova",  0, 29, 40,  0,   "implode"),
    "airstrikes": ("airstrikes", 0, 26, 40,  160, "greenscreen"),
    "jet":        ("jet",        5, 52, 40,  160, "greenscreen"),
    "deltarune":  ("deltarune",  0, 16, 100, 160, "greenscreen"),
}


# ============================================================ canvas helpers
def blank(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def canvas_draw(dst, src, srect, drect):
    """Mimics ctx.drawImage(src, sx,sy,sw,sh, dx,dy,dw,dh) with proportional
    clipping (what browsers do; the implode effect relies on it)."""
    sx, sy, sw, sh = srect
    dx, dy, dw, dh = drect
    iw, ih = src.size
    if sw <= 0 or sh <= 0:
        return dst
    if sx < 0:
        f = -sx / sw; dx += f * dw; dw -= f * dw; sw += sx; sx = 0
    if sy < 0:
        f = -sy / sh; dy += f * dh; dh -= f * dh; sh += sy; sy = 0
    if sx + sw > iw:
        sw2 = iw - sx; dw *= sw2 / sw; sw = sw2
    if sy + sh > ih:
        sh2 = ih - sy; dh *= sh2 / sh; sh = sh2
    if sw <= 0 or sh <= 0 or dw <= 0 or dh <= 0:
        return dst
    piece = src.crop((int(round(sx)), int(round(sy)),
                      int(round(sx + sw)), int(round(sy + sh))))
    piece = piece.resize((max(1, int(round(dw))), max(1, int(round(dh)))), Image.BILINEAR)
    if piece.size == dst.size and (dx, dy) == (0, 0):
        return Image.alpha_composite(dst, piece)
    layer = blank(*dst.size)
    layer.alpha_composite(piece, (int(round(dx)), int(round(dy))))
    return Image.alpha_composite(dst, layer)


def draw_fit(dst, image, keep_aspect):
    """drawAspectCorrected() from the original site, on a transparent canvas."""
    w, h = dst.size
    if keep_aspect:
        ratio = image.width / image.height
        if ratio > 1:
            nh = w / ratio
            drect = (0, (h - nh) / 2, w, nh)
        else:
            nw = h * ratio
            drect = ((w - nw) / 2, 0, nw, h)
    else:
        drect = (0, 0, w, h)
    return canvas_draw(dst, image, (0, 0, image.width, image.height), drect)


# ================================================== explode/implode effect
def circle_mask(w, h, radius, ss=2):
    """Centered circle with antialiasing (the canvas clip is hard edged;
    smoothing it avoids visible rings in the alpha channel)."""
    m = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)
    c = w * ss / 2.0
    d.ellipse([c - radius * ss, c - radius * ss, c + radius * ss, c + radius * ss], fill=255)
    return m.resize((w, h), Image.BILINEAR)


def explode(amount_x, quality, image, supersample=2):
    """Port of the explode() from fx.js (adapted from Blindman67, CC-BY-SA-4.0).
    Radial zoom built from circular layers, preserving the alpha channel."""
    w, h = image.size
    result = image.copy()
    ease_w = (amount_x / w) * 4
    wh, hh = w / 2.0, h / 2.0
    step_unit = (0.5 / wh) * quality
    i, prev = 0.0, None
    while i < 0.5:
        r = i * 2
        x, y = r * wh, r * hh
        xw = w - (x * 2)
        rx, ry = x * ease_w, y * ease_w
        rw, rh = w - (rx * 2), h - (ry * 2)
        xi = int(round(x))
        if xi != prev and xw > 0 and rw > 0 and rh > 0:
            prev = xi
            layer = canvas_draw(blank(w, h), image, (rx, ry, rw, rh), (0, 0, w, h))
            r_, g_, b_, a_ = layer.split()
            layer.putalpha(ImageChops.multiply(a_, circle_mask(w, h, xw / 2.0, supersample)))
            result = Image.alpha_composite(result, layer)
        i += step_unit
    return result


# ====================================================== building the animation
def load_frames(folder, first, last, size):
    out = []
    for i in range(first, last + 1):
        p = os.path.join(RES, folder, "%02d.webp" % i)
        if not os.path.exists(p):
            continue
        im = Image.open(p)
        im.load()
        out.append(im.convert("RGBA").resize((size, size), Image.BILINEAR))
    return out


def build(fx_name, image, size=512, keep_aspect=False, verbose=True):
    """Returns (RGBA frames, durations in ms) the way the original site builds them."""
    folder, first, last, delay, first_delay, mode = FX[fx_name]
    base = draw_fit(blank(size, size), image, keep_aspect)
    frames, durs = [], []

    if mode == "greenscreen":
        frames.append(base.copy()); durs.append(first_delay)
        for f in load_frames(folder, first, last, size):
            fr = base.copy()
            fr.alpha_composite(f, (0, 0))
            frames.append(fr); durs.append(delay)
        return frames, durs

    amounts = [-25, -50, -100, -200] if mode == "implode" else [10, 20, 50, 100]
    frames.append(base.copy()); durs.append(delay)
    for a in amounts:
        if verbose:
            print("   explode(%d)..." % a, end=" ", flush=True)
        frames.append(explode(a, 0.5, base)); durs.append(delay)
    if verbose:
        print()
    for f in load_frames(folder, first, last, size):
        frames.append(f.copy()); durs.append(delay)
    return frames, durs


# ================================================================ encoding
def kb(path):
    return os.path.getsize(path) / 1024.0


def _write_pngs(frames, durs, tmp):
    paths, lst = [], []
    for i, (f, d) in enumerate(zip(frames, durs)):
        p = os.path.join(tmp, "f%04d.png" % i)
        f.save(p)
        paths.append(p); lst.append((p, d))
    concat = os.path.join(tmp, "list.txt")
    with open(concat, "w") as fh:
        for p, d in lst:
            fh.write("file '%s'\nduration %.4f\n" % (p, d / 1000.0))
        fh.write("file '%s'\n" % lst[-1][0])  # the last entry has to be repeated
    return concat


def encode_gif(frames, durs, out, colors=128, lossy=0, drop=1, verbose=False):
    """Encodes with ffmpeg (global palette + transdiff) and then gifsicle -O3."""
    frs, drs = frames[::drop], [d * drop for d in durs[::drop]]
    tmp = tempfile.mkdtemp(prefix="explode_")
    try:
        concat = _write_pngs(frs, drs, tmp)
        filt = ("[0:v] split [a][b];[a] palettegen=reserve_transparent=1:"
                "max_colors=%d [p];[b][p] paletteuse=dither=none:alpha_threshold=128" % colors)
        raw = os.path.join(tmp, "raw.gif")
        cmd = [FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0",
               "-i", concat, "-filter_complex", filt, "-gifflags", "+transdiff", raw]
        subprocess.run(cmd, check=True, capture_output=True)
        if lossy and GIFSICLE:
            subprocess.run([GIFSICLE, "-O3", "--lossy=%d" % lossy, "-j4", raw, "-o", out],
                           check=True, capture_output=True)
        else:
            shutil.move(raw, out)
        if GIFSICLE and not lossy:
            subprocess.run([GIFSICLE, "-O3", "-j4", out, "-o", out + ".g.gif"],
                           capture_output=True)
            if os.path.exists(out + ".g.gif") and os.path.getsize(out + ".g.gif") < os.path.getsize(out):
                shutil.move(out + ".g.gif", out)
            elif os.path.exists(out + ".g.gif"):
                os.remove(out + ".g.gif")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return kb(out)


# profiles: how to spend the budget between resolution, color and motion.
# quality ~ (resolution ^a) * (colors ^b) * (fps ^c); higher exponent = more weight.
PROFILES = {
    "balanced": (0.8, 0.30, 0.55),
    "smooth":   (0.6, 0.25, 1.10),   # prioriza moverse fluido (todos los frames)
    "sharp":    (1.1, 0.40, 0.30),   # prioriza resolucion y color
}


def score(size, colors, lossy, drop, profile="balanced"):
    a, b, c = PROFILES[profile]
    return (size / 512.0) ** a * (colors / 256.0) ** b * (1.0 / drop) ** c \
        * (1 - 0.10 * min(1.0, lossy / 40.0))


def export_gif(frames, durs, out, max_kb=250, base=512, min_size=128,
               profile="balanced", verbose=True):
    """Finds the best looking configuration that fits the budget."""
    if not FFMPEG:
        raise SystemExit("ffmpeg not found (try: pip install imageio-ffmpeg).")
    sizes = [s for s in (512, 448, 384, 320, 288, 256, 224, 192, 160) if min_size <= s <= base]
    if base not in sizes:
        sizes = [base] + sizes
    sizes = sorted(set(sizes), reverse=True)
    colors_opts = (256, 192, 128, 96, 64, 48, 32)
    lossy_opts = (0, 10, 20, 30, 40, 70)
    drops = (1, 2, 3)

    # --- probe: measure the real cost per pixel-frame
    probe_size = min(sizes, key=lambda s: abs(s - 256))
    p = out + ".probe.gif"
    b = encode_gif([f.resize((probe_size, probe_size), Image.BILINEAR) for f in frames],
                   durs, p, colors=128, lossy=0, drop=1)
    # measured: the cost scales with size^1.5 (not size^2), because lower
    # resolutions leave more noise per pixel and LZW compresses worse
    k = b * 1024.0 / (probe_size ** 1.5 * len(frames))
    if verbose:
        print("   probe %dpx/128col: %.1f KB  (k=%.3f bytes/px^1.5/frame)" % (probe_size, b, k))
    os.remove(p)

    def color_factor(c):
        return (c / 128.0) ** 0.40

    def lossy_factor(l):
        return 1 - 0.02 * min(1.0, l / 40.0)  # gifsicle --lossy aporta poco aqui

    def predict(size, colors, lossy, drop):
        n = len(range(0, len(frames), drop))
        return k * size ** 1.5 * n * color_factor(colors) * lossy_factor(lossy) / 1024.0

    def candidates(factor, tried):
        out_ = []
        for drop in drops:
            for size in sizes:
                for colors in colors_opts:
                    for lossy in lossy_opts:
                        key = (size, colors, lossy, drop)
                        if key in tried:
                            continue
                        est = predict(size, colors, lossy, drop) * factor
                        if est <= max_kb * 0.95:
                            out_.append((score(size, colors, lossy, drop, profile),
                                         size, colors, lossy, drop, est))
        out_.sort(reverse=True)
        return out_

    best, tried, factor = None, set(), 1.0
    for round_ in range(4):  # the cost model is recalibrated with real measurements
        cands = candidates(factor, tried)
        if not cands:
            break
        if verbose:
            print("   round %d: %d candidates (factor %.2f)" % (round_ + 1, len(cands), factor))
        ratios = []
        for _, size, colors, lossy, drop, est in cands[:6]:
            tried.add((size, colors, lossy, drop))
            fr = frames if size == base else [f.resize((size, size), Image.BILINEAR) for f in frames]
            s = encode_gif(fr, durs, out, colors=colors, lossy=lossy, drop=drop)
            if verbose:
                print("      %4dpx %3dcol lossy%-3s drop%d -> %6.1f KB %s" %
                      (size, colors, lossy, drop, s, "(OK)" if s <= max_kb else ""))
            if s <= max_kb:
                return out, s, size, colors, lossy, drop
            ratios.append(s / est)
            if best is None or s < best[1]:
                best = (out, s, size, colors, lossy, drop)
        if ratios:
            factor *= sum(ratios) / len(ratios)
    return best


def export_webp(frames, durs, out, quality=70, max_kb=None, base=512):
    q = quality
    while True:
        frames[0].save(out, save_all=True, append_images=frames[1:],
                       duration=[max(10, int(round(d))) for d in durs],
                       loop=0, lossless=False, quality=q, method=4, minimize_size=True)
        if max_kb is None or kb(out) <= max_kb or q <= 25:
            return out, kb(out), q
        q -= 10


def export_apng(frames, durs, out):
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=[max(10, int(round(d))) for d in durs], loop=0)
    return out, kb(out)


# ======================================================================== main
def main():
    ap = argparse.ArgumentParser(description="make an image explode on a transparent background")
    ap.add_argument("input", help="input image (PNG with transparency)")
    ap.add_argument("--fx", nargs="+", default=["nuke"], choices=list(FX) + ["all"])
    ap.add_argument("--out", default=None, help="output file (single fx) or folder")
    ap.add_argument("--outdir", default=os.path.join(HERE, "resultados"))
    ap.add_argument("--size", type=int, default=512, help="working canvas (512 by default, like the site)")
    ap.add_argument("--min-size", type=int, default=128)
    ap.add_argument("--max-kb", type=float, default=250, help="file size budget for the GIF")
    ap.add_argument("--keep-aspect", action="store_true", help="do not stretch the input image")
    ap.add_argument("--format", default="gif", help="gif,webp,apng (separados por coma)")
    ap.add_argument("--webp-quality", type=int, default=70)
    ap.add_argument("--prefer", default="balanced", choices=list(PROFILES),
                    help="balanced (default) / smooth (motion) / sharp (resolution)")
    args = ap.parse_args()

    fx_list = list(FX) if "all" in args.fx else args.fx
    img = Image.open(args.input); img.load(); img = img.convert("RGBA")
    os.makedirs(args.outdir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(args.input))[0]
    fmts = [f.strip() for f in args.format.split(",")]

    for name in fx_list:
        print("[%s] building the animation at %dpx..." % (name, args.size))
        frames, durs = build(name, img, size=args.size, keep_aspect=args.keep_aspect)
        print("   %d frames, %d ms each" % (len(frames), durs[1]))
        for fmt in fmts:
            if fmt == "gif":
                out = args.out if (args.out and len(fx_list) == 1 and len(fmts) == 1) else \
                    os.path.join(args.outdir, "%s-%s.gif" % (stem, name))
                path, s, size, colors, lossy, drop = export_gif(
                    frames, durs, out, max_kb=args.max_kb, base=args.size,
                    min_size=args.min_size, profile=args.prefer)
                print("[%s] GIF -> %s  %.1f KB (%dpx, %d colores, lossy %d, drop %d, %s)" %
                      (name, path, s, size, colors, lossy, drop,
                       "OK <%.0f KB" % args.max_kb if s <= args.max_kb else "over budget"))
            elif fmt == "webp":
                out = os.path.join(args.outdir, "%s-%s.webp" % (stem, name))
                path, s, q = export_webp(frames, durs, out, quality=args.webp_quality,
                                         max_kb=args.max_kb)
                print("[%s] WebP -> %s  %.1f KB (calidad %d, %dpx)" % (name, path, s, q, args.size))
            elif fmt == "apng":
                out = os.path.join(args.outdir, "%s-%s.png" % (stem, name))
                path, s = export_apng(frames, durs, out)
                print("[%s] APNG -> %s  %.1f KB" % (name, path, s))


if __name__ == "__main__":
    main()
