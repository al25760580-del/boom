/**
 * modules/explode/module.js
 *
 * The explosions from https://explode.moth.monster/ (mothdotmonster, MIT-0).
 * Assets: res/<explosion>/NN.webp (512x512 frames, from the original site).
 * The effect itself (explode/implode) lives in ../../core/fx.js.
 *
 * Module contract: see ../README.md
 */
import { makeCanvas, loadImage } from '../../core/encoder.js';
import { explode } from '../../core/fx.js';

const asset = (p) => new URL(p, import.meta.url).href;

// folder, first frame, last frame, delay ms, delay of the first frame, mode
export const VARIANTS = {
  nuke:       { dir: 'nuke',       first: 0, last: 21, delay: 40,  firstDelay: 40,  mode: 'explode' },
  house:      { dir: 'house',      first: 8, last: 35, delay: 40,  firstDelay: 40,  mode: 'explode' },
  earth:      { dir: 'earth',      first: 0, last: 29, delay: 40,  firstDelay: 40,  mode: 'explode' },
  supernova:  { dir: 'supernova',  first: 0, last: 29, delay: 40,  firstDelay: 40,  mode: 'implode' },
  airstrikes: { dir: 'airstrikes', first: 0, last: 26, delay: 40,  firstDelay: 160, mode: 'greenscreen' },
  jet:        { dir: 'jet',        first: 5, last: 52, delay: 40,  firstDelay: 160, mode: 'greenscreen' },
  deltarune:  { dir: 'deltarune',  first: 0, last: 16, delay: 100, firstDelay: 160, mode: 'greenscreen' },
};

const pad2 = (n) => String(n).padStart(2, '0');

function drawFit(ctx, image, size, keepAspect) {
  if (keepAspect) {
    const ratio = image.naturalWidth / image.naturalHeight;
    if (ratio > 1) {
      const h = size / ratio;
      ctx.drawImage(image, 0, (size - h) / 2, size, h);
    } else {
      const w = size * ratio;
      ctx.drawImage(image, (size - w) / 2, 0, w, size);
    }
  } else {
    ctx.drawImage(image, 0, 0, size, size);
  }
}

export default {
  id: 'explode',
  name: 'explosion',
  description: 'Bulges your image and then blows it up (or drops an explosion on top of it).',
  nativeSize: 512,
  maxSize: 512,
  upscale: false,
  variants: [
    { id: 'nuke', name: 'nuke' },
    { id: 'house', name: 'house' },
    { id: 'earth', name: 'earth' },
    { id: 'supernova', name: 'supernova (implode)' },
    { id: 'airstrikes', name: 'air strikes' },
    { id: 'jet', name: 'plane crash' },
    { id: 'deltarune', name: 'deltarune' },
  ],
  params: [
    { id: 'keepAspect', label: 'keep aspect ratio', type: 'checkbox', value: false },
  ],

  /** @returns {{frames: HTMLCanvasElement[], delays: number[]}} */
  async build(image, { size = 512, variant = 'nuke', params = {}, onProgress = () => {} } = {}) {
    const cfg = VARIANTS[variant] || VARIANTS.nuke;
    // the base canvas is transparent: the original site fills it with white
    const base = makeCanvas(size, size);
    drawFit(base.ctx, image, size, !!params.keepAspect);

    const frames = [];
    const delays = [];
    const total = cfg.last - cfg.first + 1;

    if (cfg.mode === 'greenscreen') {
      frames.push(base);
      delays.push(cfg.firstDelay);
      for (let i = cfg.first; i <= cfg.last; i++) {
        const f = await loadImage(asset(`res/${cfg.dir}/${pad2(i)}.webp`));
        const fr = makeCanvas(size, size);
        fr.ctx.drawImage(base, 0, 0);
        fr.ctx.drawImage(f, 0, 0, size, size);
        frames.push(fr);
        delays.push(cfg.delay);
        onProgress(i - cfg.first + 1, total);
      }
      return { frames, delays };
    }

    const amounts = cfg.mode === 'implode' ? [-25, -50, -100, -200] : [10, 20, 50, 100];
    frames.push(base);
    delays.push(cfg.delay);
    amounts.forEach((a, i) => {
      const scratch = makeCanvas(size, size);
      explode(a, 0.5, base, scratch);        // from fx.js
      frames.push(scratch);
      delays.push(cfg.delay);
      onProgress(i + 1, amounts.length + total);
    });
    for (let i = cfg.first; i <= cfg.last; i++) {
      const img = await loadImage(asset(`res/${cfg.dir}/${pad2(i)}.webp`));
      const f = makeCanvas(size, size);
      f.ctx.drawImage(img, 0, 0, size, size);
      frames.push(f);
      delays.push(cfg.delay);
      onProgress(amounts.length + i - cfg.first + 1, amounts.length + total);
    }
    return { frames, delays };
  },
};
