/**
 * modules/petpet/module.js
 *
 * "petpet": a hand patting your image, which gets squished on every pat.
 * Ported from https://benisland.neocities.org/petpet/ (benisland) - the frame
 * offsets and the hand placement are the ones from its main.js so the result
 * looks like the original.
 *
 * Asset: sprite.png - the hand sprite sheet, 5 frames of 112x112 (560x112).
 *
 * Module contract: see ../README.md
 */
import { makeCanvas, loadImage } from '../../core/encoder.js';

const asset = (p) => new URL(p, import.meta.url).href;

const OUT = 112;          // the animation is authored at 112x112
const FRAMES = 5;

// per frame squish of the image (from the original main.js)
const OFFSETS = [
  { x: 0,   y: 0,  w: 0,  h: 0 },
  { x: -4,  y: 12, w: 4,  h: -12 },
  { x: -12, y: 18, w: 12, h: -18 },
  { x: -12, y: 18, w: 12, h: -18 },
  { x: -8,  y: 12, w: 4,  h: -12 },
];

const DEFAULTS = {
  squish: 1.25,     // how much the image is squished
  scale: 0.875,     // size of the image inside the frame
  delay: 60,        // ms per frame
  spriteX: 14,      // resting position of the image
  spriteY: 20,
  spriteWidth: 112,
  flip: false,      // mirror the hand
};

export default {
  id: 'petpet',
  name: 'petpet',
  description: 'A hand pats your image while it gets squished.',
  nativeSize: OUT,
  maxSize: 160,                 // upscaling a 112px sprite much further looks soft
  upscale: true,
  variants: [{ id: 'petpet', name: 'petpet' }],
  params: [
    { id: 'squish', label: 'squish', type: 'range', min: 0.5, max: 2, step: 0.05, value: 1.25 },
    { id: 'delay', label: 'ms per frame', type: 'range', min: 20, max: 200, step: 10, value: 60 },
    { id: 'flip', label: 'flip hand', type: 'checkbox', value: false },
  ],

  /** @returns {{frames: HTMLCanvasElement[], delays: number[]}} */
  async build(image, { size = OUT, params = {}, onProgress = () => {} } = {}) {
    const g = { ...DEFAULTS, ...params };
    const hand = await loadImage(asset('sprite.png'));
    const spriteHeight = g.spriteWidth * (image.naturalHeight / image.naturalWidth);

    const frames = [];
    const delays = [];
    for (let f = 0; f < FRAMES; f++) {
      const c = makeCanvas(OUT, OUT);
      const ctx = c.ctx;
      ctx.imageSmoothingEnabled = false;

      const o = OFFSETS[f];
      const dx = Math.floor(g.spriteX + o.x * (g.squish * 0.4));
      const dy = Math.floor(g.spriteY + o.y * (g.squish * 0.9));
      let dw = Math.floor((g.spriteWidth + o.w * g.squish) * g.scale);
      const dh = Math.floor((spriteHeight + o.h * g.squish) * g.scale);

      // the image goes first, squished, then the hand on top
      ctx.save();
      ctx.translate(dx, dy);
      if (g.flip) {
        ctx.scale(-1, 1);
        dw *= -1;
      }
      ctx.drawImage(image, 0, 0, dw, dh);
      ctx.restore();

      const handY = Math.max(0, Math.floor(dy * 0.75 - Math.max(0, g.spriteY) - 0.5));
      ctx.drawImage(hand, f * OUT, 0, OUT, OUT, 0, handY, OUT, OUT);

      frames.push(c);
      delays.push(g.delay);
      onProgress(f + 1, FRAMES);
    }
    return { frames, delays };
  },
};
