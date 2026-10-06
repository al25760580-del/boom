/**
 * core/encoder.js - GIF encoding + file size budget search.
 *
 * Shared by every module. Encoding is done with gifenc (MIT, mattdesl).
 * The palette is built from OPAQUE pixels only and the last slot is reserved,
 * with every transparent pixel forced into it, so the alpha mask of the output
 * matches the alpha of the source frames exactly.
 */
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';
import { gifsicleOptimize } from './gifsicle.js';

export const SIZES = [512, 448, 384, 320, 288, 256, 224, 192, 160, 128, 112];
const COLORS = [256, 192, 128, 96, 64, 48, 32];
const DROPS = [1, 2, 3];

// quality ~ (resolution ^a) * (colors ^b) * (fps ^c); higher exponent = more weight
export const PROFILES = {
  balanced: [0.8, 0.30, 0.55],
  smooth:   [0.6, 0.25, 1.10],
  sharp:    [1.1, 0.40, 0.30],
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.ctx = c.getContext('2d', { willReadFrequently: true });
  return c;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load ' + src));
    img.src = src;
  });
}

function buildPalette(rgbaFrames, maxColors) {
  let total = 0;
  for (const f of rgbaFrames) total += f.length / 4;
  const stride = Math.max(1, Math.floor(total / 300000)) * 4; // cap the sample size
  let n = 0;
  for (const f of rgbaFrames) n += Math.ceil(f.length / stride);
  const samples = new Uint8Array(n * 4);
  let o = 0;
  for (const f of rgbaFrames) {
    for (let i = 0; i < f.length; i += stride) {
      if (f[i + 3] < 128) continue;                 // skip transparent pixels
      samples[o++] = f[i];
      samples[o++] = f[i + 1];
      samples[o++] = f[i + 2];
      samples[o++] = 255;
    }
  }
  const opaque = quantize(samples.subarray(0, o), Math.max(8, maxColors - 1), { format: 'rgb565' });
  const palette = opaque.concat([[0, 0, 0, 0]]);
  return { opaque, palette, transparentIndex: palette.length - 1 };
}

/** Encodes an animation (list of canvases) as an animated GIF with 1-bit alpha. */
export function encodeGif(frames, delays, { size, colors, drop = 1, smooth = true }) {
  const work = makeCanvas(size, size);
  const wctx = work.ctx;
  const picked = [];
  const pickedDelays = [];
  for (let i = 0; i < frames.length; i += drop) {
    picked.push(frames[i]);
    pickedDelays.push(delays[i] * drop);
  }

  const rgbaFrames = picked.map((f) => {
    wctx.imageSmoothingEnabled = smooth;   // pixel art modules turn this off
    wctx.clearRect(0, 0, size, size);
    wctx.drawImage(f, 0, 0, size, size);
    return wctx.getImageData(0, 0, size, size).data;
  });

  const { opaque, palette, transparentIndex } = buildPalette(rgbaFrames, colors);
  const gif = GIFEncoder();
  rgbaFrames.forEach((rgba, i) => {
    const index = applyPalette(rgba, opaque, 'rgb565');
    for (let p = 0; p < index.length; p++) {
      if (rgba[p * 4 + 3] < 128) index[p] = transparentIndex;
    }
    gif.writeFrame(index, size, size, {
      palette: i === 0 ? palette : undefined,
      delay: Math.max(20, Math.round(pickedDelays[i] / 10) * 10),
      transparent: true,
      transparentIndex,
      dispose: 2,
      repeat: i === 0 ? 0 : undefined,
    });
  });
  gif.finish();
  return gif.bytes();
}

function score(size, colors, drop, profile) {
  const [a, b, c] = PROFILES[profile] || PROFILES.balanced;
  return Math.pow(size / 512, a) * Math.pow(colors / 256, b) * Math.pow(1 / drop, c);
}

const frameCount = (n, drop) => Math.ceil(n / drop);

/**
 * How much gifsicle --lossy=N actually takes off, measured on these frames:
 * 0 -> 100 %, 30 -> 79 %, 80 -> 59 % (it barely helps past that).
 * Used to skip hopeless candidates and to pick the mildest level that can fit,
 * so the WASM is only run when it is worth it.
 */
function lossyFactor(lossy) {
  if (lossy <= 0) return 1;
  if (lossy <= 30) return 1 - lossy * ((1 - 0.79) / 30);
  if (lossy <= 80) return 0.79 - (lossy - 30) * ((0.79 - 0.59) / 50);
  return 0.59 - (lossy - 80) * 0.0008;
}

/**
 * Finds the best looking configuration that fits the budget.
 * One probe measures the real cost of the animation (bytes scale with size^1.5,
 * as measured on the Python version) and the estimate is recalibrated with
 * whatever each attempt actually weighs.
 */
export async function fitToBudget(frames, delays, opts = {}) {
  const {
    maxKb = 250, profile = 'balanced', maxSize = 512, upscale = true, smooth = true,
    gifsicle = false,          // post-process with gifsicle-wasm (-O3 --lossy)
    lossyLevels = [0, 30, 80], // tried in order until one fits
    maxGifsicleRuns = 10,      // each run costs a few hundred ms
    onTry = () => {},
  } = opts;
  const budget = maxKb * 1024;
  const cap = upscale ? maxSize : Math.min(maxSize, frames[0].width);
  const sizes = SIZES.filter((s) => s <= cap);
  const key = (c) => `${c.size}-${c.colors}-${c.drop}`;

  const probe = { size: sizes[Math.min(2, sizes.length - 1)], colors: 128, drop: 1 };
  const pb = encodeGif(frames, delays, { ...probe, smooth });
  onTry({ ...probe, kb: pb.length / 1024, probe: true });
  let k = pb.length / (Math.pow(probe.size, 1.5) * frameCount(frames.length, probe.drop));
  let factor = 1;
  const tried = new Set([key(probe)]);
  let smallest = { bytes: pb, ...probe, lossy: 0, kb: pb.length / 1024, fitted: pb.length <= budget };
  if (smallest.fitted && !gifsicle) return smallest;

  // with gifsicle we can afford candidates that start well over the budget:
  // --lossy=80 takes roughly 40% off
  const slack = gifsicle ? 2.2 : 0.95;
  let runs = 0;

  for (let round_ = 0; round_ < 4; round_++) {
    const cands = [];
    for (const drop of DROPS) {
      for (const size of sizes) {
        for (const colors of COLORS) {
          if (tried.has(key({ size, colors, drop }))) continue;
          const est = k * Math.pow(size, 1.5) * frameCount(frames.length, drop)
            * Math.pow(colors / 128, 0.4) * factor;
          // best case for this candidate: the strongest lossy level we allow
          const bestCase = gifsicle ? est * lossyFactor(Math.max(...lossyLevels)) : est;
          if (bestCase <= budget * (gifsicle ? 1.02 : 0.95)) {
            cands.push({ size, colors, drop, est, s: score(size, colors, drop, profile) });
          }
        }
      }
    }
    if (!cands.length) break;
    cands.sort((a, b) => b.s - a.s);
    const ratios = [];
    for (const cand of cands.slice(0, 5)) {
      tried.add(key(cand));
      const t0 = performance.now();
      const raw = encodeGif(frames, delays, { ...cand, smooth });
      let best = null;
      if (gifsicle && runs < maxGifsicleRuns) {
        // only the levels that can plausibly bring this one under the budget
        const needed = budget / raw.length;
        const levels = lossyLevels.filter((l) => l === 0 || lossyFactor(l) <= needed * 1.02);
        for (const lossy of levels) {
          const out = lossy === 0 ? raw : await gifsicleOptimize(raw, { lossy });
          if (lossy !== 0) runs++;
          const ms = Math.round(performance.now() - t0);
          onTry({ size: cand.size, colors: cand.colors, drop: cand.drop, lossy, kb: out.length / 1024, ms });
          if (out.length <= budget) { best = { bytes: out, lossy, ms }; break; }
          if (!best || out.length < best.bytes.length) best = { bytes: out, lossy, ms };
        }
        if (!best) best = { bytes: raw, lossy: 0, ms: Math.round(performance.now() - t0) };
      } else {
        const ms = Math.round(performance.now() - t0);
        onTry({ size: cand.size, colors: cand.colors, drop: cand.drop, lossy: 0, kb: raw.length / 1024, ms });
        best = { bytes: raw, lossy: 0, ms };
      }
      if (best.bytes.length <= budget) {
        return { bytes: best.bytes, size: cand.size, colors: cand.colors, drop: cand.drop,
                 lossy: best.lossy, kb: best.bytes.length / 1024, fitted: true };
      }
      ratios.push(raw.length / cand.est);
      if (best.bytes.length < smallest.bytes.length) {
        smallest = { bytes: best.bytes, size: cand.size, colors: cand.colors, drop: cand.drop,
                     lossy: best.lossy, kb: best.bytes.length / 1024, fitted: false };
      }
    }
    if (ratios.length) factor *= ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }
  return smallest;
}

export function toBlob(bytes) {
  return new Blob([bytes], { type: 'image/gif' });
}

export function toDataURL(bytes) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(toBlob(bytes));
  });
}
