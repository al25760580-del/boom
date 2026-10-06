/**
 * core/gifsicle.js - optional post-processing with gifsicle compiled to WASM.
 *
 * gifenc writes a decent GIF, but gifsicle adds two things it cannot do:
 *   -O3   frame diffing: each frame only stores the pixels that changed
 *   --lossy=N  colour smoothing that LZW compresses much better
 *
 * That is the difference between shipping 192px and 256px under the same
 * budget. It costs a 341 KB download, so it is loaded lazily and only when
 * the caller asks for it (UI checkbox or ?gifsicle=1).
 *
 * gifsicle-wasm-browser (MIT) by renzhezhilu - gifsicle 1.92 by Eddie Kohler.
 */
let loader = null;

export function loadGifsicle() {
  if (!loader) {
    loader = import('../vendor/gifsicle-wasm.js').then((m) => m.default);
  }
  return loader;
}

/**
 * @param {Uint8Array} bytes  a GIF produced by gifenc
 * @param {{level?: number, lossy?: number}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function gifsicleOptimize(bytes, { level = 3, lossy = 0 } = {}) {
  const gifsicle = await loadGifsicle();
  const input = new File([bytes.slice()], 'in.gif', { type: 'image/gif' });
  const flags = [`-O${level}`];
  if (lossy) flags.push(`--lossy=${lossy}`);
  const out = await gifsicle.run({
    input: [{ file: input, name: 'in.gif' }],
    command: [`${flags.join(' ')} in.gif -o /out/out.gif`],
  });
  const file = Array.isArray(out) ? out[0] : out;
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}
