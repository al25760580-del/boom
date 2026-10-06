/**
 * Runs the real worker/src/index.js against in-memory shims for R2 and the
 * browser binding. No Cloudflare account needed.
 *
 *   node tools/test-worker.mjs
 */
import worker from '../worker/src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gif = new Uint8Array(readFileSync(join(here, '../resultados/input-nuke.gif')));

const store = new Map();
const GIFS = {
  async put(key, value, opts = {}) {
    store.set(key, { bytes: new Uint8Array(value), customMetadata: opts.customMetadata || {}, httpMetadata: opts.httpMetadata || {} });
  },
  async get(key) {
    const o = store.get(key);
    if (!o) return null;
    return { body: o.bytes, size: o.bytes.length, httpEtag: `"${key}"`,
             customMetadata: o.customMetadata, httpMetadata: o.httpMetadata,
             async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.length); } };
  },
  async head(key) {
    const o = store.get(key);
    if (!o) return null;
    return { size: o.bytes.length, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata };
  },
};
globalThis.caches = { default: { async match() { return null; }, async put() {} } };

let env = { GIFS, UPLOAD_KEY: '', DISCORD_TOKEN: '' };   // no BROWSER on purpose
const call = (path, init) => worker.fetch(new Request('https://w.test' + path, init), env);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---- upload ---------------------------------------------------------------
const up = await call('/g?fx=nuke&size=192&kb=216.4&frames=27', {
  method: 'POST', headers: { 'content-type': 'image/gif' }, body: gif });
const upJson = await up.json();
check('POST /g -> 200', up.status === 200, 'HTTP ' + up.status);
check('devuelve id/gif/view', !!upJson.id && !!upJson.gif && !!upJson.view,
      JSON.stringify({ id: upJson.id, gif: upJson.gif }));
check('CORS presente', up.headers.get('access-control-allow-origin') === '*');

// ---- download -------------------------------------------------------------
const dl = await call(upJson.gif);
const back = new Uint8Array(await dl.arrayBuffer());
check('GET /g/<id>.gif -> image/gif', dl.headers.get('content-type') === 'image/gif');
check('bytes identicos', back.length === gif.length && Buffer.compare(back, gif) === 0,
      `${back.length} vs ${gif.length}`);
check('cache inmutable', (dl.headers.get('cache-control') || '').includes('immutable'));

// ---- card -----------------------------------------------------------------
const card = await (await call(upJson.view)).text();
check('og:image apunta al .gif', card.includes(`og:image" content="https://w.test/g/${upJson.id}.gif"`));
check('og:title con el efecto', card.includes('programa · nuke'));
check('descripcion con medidas', card.includes('192×192px') && card.includes('216.4 KB'));
check('/view normal redirige a la app', card.includes('http-equiv="refresh"'));

const prev = await (await call(upJson.view + '&preview=1')).text();
check('preview=1 NO redirige', !prev.includes('http-equiv="refresh"'));
check('preview=1 muestra la imagen', prev.includes(`<img src="https://w.test/g/${upJson.id}.gif"`));

// ---- deterministic ids ----------------------------------------------------
const a = await (await call('/g?src=https://x/img.png&fx=petpat&maxkb=250&prefer=balanced',
  { method: 'POST', body: gif })).json();
const b = await (await call('/g?src=https://x/img.png&fx=petpat&maxkb=250&prefer=balanced',
  { method: 'POST', body: gif })).json();
const c = await (await call('/g?src=https://x/img.png&fx=nuke&maxkb=250&prefer=balanced',
  { method: 'POST', body: gif })).json();
check('mismos parametros -> mismo id', a.id === b.id, `${a.id} == ${b.id}`);
check('distinto efecto -> distinto id', a.id !== c.id, `${a.id} != ${c.id}`);
check('el id deterministico sirve en /g/<id>.gif',
      (await call(`/g/${a.id}.gif`)).status === 200);

// ---- validations ----------------------------------------------------------
check('cuerpo que no es GIF -> 415',
      (await call('/g', { method: 'POST', body: new Uint8Array([1, 2, 3, 4, 5, 6]) })).status === 415);
const missing = await call('/g/aabbccddeeff0011.gif');
check('id inexistente -> 404', missing.status === 404, 'HTTP ' + missing.status);
check('id con formato raro -> 400', (await call('/g/..%2Fetc.gif')).status === 400);
check('ruta desconocida -> 404', (await call('/nope')).status === 404);

env = { ...env, UPLOAD_KEY: 'secret' };
check('sin x-boom-key -> 401', (await call('/g', { method: 'POST', body: gif })).status === 401);
check('con x-boom-key -> 200',
      (await call('/g', { method: 'POST', headers: { 'x-boom-key': 'secret' }, body: gif })).status === 200);
env = { ...env, UPLOAD_KEY: '' };

// ---- server-side renders (no browser binding in this test) ----------------
check('/render sin url -> 400', (await call('/render')).status === 400);
const noBrowser = await call('/render.gif?url=https://x/i.png&fx=petpat');
check('/render.gif sin binding -> 501', noBrowser.status === 501, 'HTTP ' + noBrowser.status);

// ---- discord avatars ------------------------------------------------------
check('avatar con id invalido -> 400', (await call('/avatar/123.png')).status === 400);
const noToken = await call('/avatar/1385341957500567574.png');
check('avatar sin token -> 501', noToken.status === 501, (await noToken.json()).error);

// ---- misc -----------------------------------------------------------------
check('OPTIONS -> preflight',
      (await call('/g', { method: 'OPTIONS' })).headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS');
const root = await call('/');
check('GET / -> redirige a la app', root.status === 302 && root.headers.get('location').includes('github.io'));

console.log(`\n${pass} pasan · ${fail} fallan`);
process.exit(fail ? 1 : 0);
