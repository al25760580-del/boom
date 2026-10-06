/**
 * boom-embed — a tiny backend that exists only so links can be embedded.
 *
 * The GIF is rendered in the visitor's browser: canvas, gifenc and the optional
 * gifsicle WASM, exactly as it already is. When you press "upload + copy embed
 * link" the finished bytes are POSTed here, stored in R2, and served back from
 * a public URL ending in .gif — which is all Discord needs to embed it and
 * play the animation. No headless browser, no rendering on the server.
 *
 *   POST /g?fx=jet&size=192&kb=216&frames=49     body: the GIF bytes
 *          → { id, gif, view, url, size, kb, ... }
 *   GET  /g/<id>.gif                  → image/gif
 *   GET  /view?id=<id>                → HTML card whose og:image is /g/<id>.gif
 *   GET  /avatar/<discord id>.png     → that user's avatar (needs DISCORD_TOKEN)
 *   GET  /                            → redirect to the app
 */

const APP = 'https://al25760580-del.github.io/boom/programa.html';
const MAX_BYTES = 8 * 1024 * 1024;        // refuse anything absurd
const IMMUTABLE = 'public, max-age=31536000, immutable';
const TIMEOUT = 45_000;                   // browser sessions die at 60s

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-boom-key',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request, env) {
    // The browser posts cross-origin from GitHub Pages, so answer preflight.
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return Response.redirect(APP, 302);
      }

      if (url.pathname === '/g' && request.method === 'POST') {
        return withCors(await upload(request, env, url));
      }
      if (url.pathname.startsWith('/g/') && request.method === 'GET') {
        return withCors(await download(url.pathname.slice(3), env));
      }
      if (url.pathname === '/view' && request.method === 'GET') {
        return withCors(await view(url, env));
      }
      if (url.pathname.startsWith('/avatar/') && request.method === 'GET') {
        return withCors(await avatar(url, env));
      }
      // server-side rendering, for bots: the worker opens the app in headless
      // Chromium and hands back the GIF the browser just made
      if (url.pathname === '/render.gif' && request.method === 'GET') {
        const { bytes, cached } = await renderFromParams(url, env);
        return withCors(new Response(bytes, {
          headers: {
            'content-type': 'image/gif',
            'content-length': String(bytes.length),
            'cache-control': IMMUTABLE,
            'x-boom-cached': cached ? '1' : '0',
          },
        }));
      }
      if (url.pathname === '/render' && request.method === 'GET') {
        const { bytes, meta, id, cached } = await renderFromParams(url, env);
        return withCors(json({
          url: new URL(`/g/${id}.gif`, url.origin).toString(),
          view: new URL(`/view?id=${id}`, url.origin).toString(),
          bytes: bytes.length, ...meta, cached,
        }));
      }
    } catch (err) {
      // keep the status the endpoint asked for (400, 404, 429, 501…)
      return withCors(json({ error: err.message }, err.status || 500));
    }

    return withCors(json({ error: 'not found' }, 404));
  },
};

// ---- upload ---------------------------------------------------------------

async function upload(request, env, url) {
  // Optional shared secret, so strangers cannot fill your bucket.
  if (env.UPLOAD_KEY && request.headers.get('x-boom-key') !== env.UPLOAD_KEY) {
    return json({ error: 'missing or wrong x-boom-key' }, 401);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ error: 'empty body' }, 400);
  if (bytes.length > MAX_BYTES) return json({ error: 'too big' }, 413);

  const magic = String.fromCharCode(...bytes.slice(0, 6));
  if (magic !== 'GIF89a' && magic !== 'GIF87a') {
    return json({ error: 'that is not a GIF' }, 415);
  }

  // When the client tells us which image it used, the id is a hash of the
  // inputs, so the same request always lands on the same URL: a bot can build
  // https://<worker>/g/<hash>.gif itself, and a second identical render costs
  // nothing. Local file uploads have no URL, so they get a random id.
  const src = (url.searchParams.get('src') || '').slice(0, 512);
  const id = src
    ? await sha256([src, url.searchParams.get('fx'), url.searchParams.get('maxkb'),
                    url.searchParams.get('prefer'), url.searchParams.get('gifsicle'),
                    url.searchParams.get('lossy')].join('|'))
    : newId();
  const meta = {
    fx: (url.searchParams.get('fx') || '').slice(0, 32),
    size: (url.searchParams.get('size') || '').slice(0, 8),
    kb: (url.searchParams.get('kb') || '').slice(0, 12),
    frames: (url.searchParams.get('frames') || '').slice(0, 8),
    created: new Date().toISOString(),
  };

  await env.GIFS.put(`${id}.gif`, bytes, {
    httpMetadata: { contentType: 'image/gif', cacheControl: IMMUTABLE },
    customMetadata: meta,
  });

  return json({
    id,
    gif: `/g/${id}.gif`,
    view: `/view?id=${id}`,
    url: new URL(`/g/${id}.gif`, url.origin).toString(),
    share: new URL(`/view?id=${id}`, url.origin).toString(),
    ...meta,
  });
}

// ---- download -------------------------------------------------------------

async function download(key, env) {
  if (!/^[a-z0-9]+\.gif$/.test(key)) return json({ error: 'bad id' }, 400);
  const object = await env.GIFS.get(key);
  if (!object) return json({ error: 'no such gif' }, 404);

  return new Response(object.body, {
    headers: {
      'content-type': 'image/gif',
      'content-length': String(object.size),
      'cache-control': IMMUTABLE,
      'etag': object.httpEtag,
      'x-boom-fx': object.customMetadata?.fx || '',
    },
  });
}

// ---- the card a crawler reads ---------------------------------------------

async function view(url, env) {
  const id = url.searchParams.get('id') || '';
  if (!/^[a-z0-9]+$/.test(id)) return json({ error: 'bad id' }, 400);

  const head = await env.GIFS.head(`${id}.gif`);
  if (!head) return json({ error: 'no such gif' }, 404);

  const m = head.customMetadata || {};
  const gifUrl = new URL(`/g/${id}.gif`, url.origin).toString();
  const title = `programa · ${m.fx || 'effect'}`;
  const desc = [m.size && `${m.size}×${m.size}px`, m.kb && `${m.kb} KB`,
                m.frames && `${m.frames} frames`, 'transparent animated GIF']
    .filter(Boolean).join(' · ');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(gifUrl)}">
<meta property="og:image:type" content="image/gif">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(gifUrl)}">
${url.searchParams.has('preview') ? '' : `<meta http-equiv="refresh" content="0; url=${esc(APP)}">`}
</head><body style="background:#12100f;color:#f2e9e1;font:15px system-ui;margin:0;padding:${url.searchParams.has('preview') ? '0' : '3rem'}">
${url.searchParams.has('preview')
  ? `<img src="${esc(gifUrl)}" alt="result" style="display:block;width:100%;max-width:480px">
     <div style="padding:1rem">
       <div style="color:#ff7a3d;font-weight:600">${esc(title)}</div>
       <div style="opacity:.7;font-size:13px">${esc(desc)}</div>
     </div>`
  : `<p>opening <a style="color:#ff7a3d" href="${esc(APP)}">programa</a>…</p>`}
</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

// ---- Discord avatars ------------------------------------------------------

/**
 * GET /avatar/<user id>.png?size=256
 *
 * Turns a Discord user ID into an avatar image. It needs a bot token because
 * Discord's API is the only way to learn the avatar hash; the result is cached
 * for a day so one user costs at most one API call per day.
 */
async function avatar(url, env) {
  const id = url.pathname.slice('/avatar/'.length).replace(/\.png$/, '');
  if (!/^\d{17,20}$/.test(id)) return json({ error: 'that is not a Discord user ID' }, 400);
  if (!env.DISCORD_TOKEN) {
    return json({ error: 'DISCORD_TOKEN is not set — see worker/README.md' }, 501);
  }

  const size = Math.min(Math.max(parseInt(url.searchParams.get('size') || '256', 10) || 256, 16), 4096);
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const api = await fetch(`https://discord.com/api/v10/users/${id}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  });
  if (api.status === 404) return json({ error: 'no Discord user with that ID' }, 404);
  if (api.status === 429) {
    return json({ error: 'rate limited by Discord, try again in a moment' }, 429);
  }
  if (!api.ok) {
    return json({ error: `Discord API said ${api.status} (check DISCORD_TOKEN)` }, 502);
  }

  const user = await api.json();
  // No custom avatar: Discord's default is index = (id >> 22) % 6 for accounts
  // without a discriminator, and discriminator % 5 for the old ones.
  const cdn = user.avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=${size}`
    : `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(id, user.discriminator)}.png`;

  const image = await fetch(cdn);
  if (!image.ok) return json({ error: `avatar fetch failed (${image.status})` }, 502);

  const response = new Response(image.body, {
    headers: {
      'content-type': image.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=86400',
      'x-boom-avatar': user.avatar ? 'custom' : 'default',
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

function defaultAvatarIndex(id, discriminator) {
  if (discriminator && discriminator !== '0') return Number(discriminator) % 5;
  return Number(BigInt(id) >> 22n) % 6;
}

// ---- server-side rendering, for bots -------------------------------------

/**
 * GET /render.gif?url=<image>&fx=petpat   →  the GIF bytes
 * GET /render?url=<image>&fx=petpat       →  { url, view, bytes, size, kb, … }
 *
 * A Worker on the free plan only gets 10 ms of CPU per request and encoding a
 * GIF costs hundreds, so this does not encode anything itself: it opens the app
 * in headless Chromium (Browser Run), which spends browser minutes instead of
 * Worker CPU, and copies out the GIF the page produces. Results are stored in
 * R2 under a hash of the parameters, so the same request twice costs one render.
 */
async function renderFromParams(url, env) {
  const src = url.searchParams.get('url') || url.searchParams.get('discord');
  if (!src) throw httpError(400, 'url is required (or discord=<user id>)');

  let imageUrl = src;
  if (/^\d{17,20}$/.test(src)) {
    imageUrl = new URL(`/avatar/${src}.png?size=256`, url.origin).toString();
  } else if (!/^https?:\/\//i.test(src)) {
    throw httpError(400, 'url must be an http(s) image URL');
  }

  const params = new URLSearchParams(url.searchParams);
  params.delete('discord');
  params.set('url', imageUrl);
  if (!params.has('fx')) params.set('fx', 'petpat');

  const id = await sha256(params.toString());   // same parameters, same GIF
  const key = `${id}.gif`;

  const cached = await env.GIFS.get(key);
  if (cached) {
    return { bytes: new Uint8Array(await cached.arrayBuffer()),
             meta: cached.customMetadata || {}, id, cached: true };
  }

  const { bytes, meta } = await renderInBrowser(params, env);
  await env.GIFS.put(key, bytes, {
    httpMetadata: { contentType: 'image/gif', cacheControl: IMMUTABLE },
    customMetadata: { ...meta, kind: 'render' },
  });
  return { bytes, meta, id, cached: false };
}

async function renderInBrowser(params, env) {
  if (!env.BROWSER) {
    throw httpError(501, 'no BROWSER binding — add [browser] binding = "BROWSER" to wrangler.toml');
  }
  const page = new URL(APP);
  params.forEach((value, name) => page.searchParams.set(name, value));
  page.searchParams.set('embed', '1');          // ask the app for a data URL

  const browser = await launch(env);
  try {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 900, height: 900 });
    // keep whatever the page complains about, so a timeout says why
    const noise = [];
    tab.on('console', (m) => { if (m.type() === 'error') noise.push(m.text().slice(0, 160)); });
    tab.on('pageerror', (e) => noise.push(String(e).slice(0, 160)));
    tab.on('requestfailed', (r) => noise.push(`failed ${r.url().slice(0, 80)} ${r.failure()?.errorText || ''}`));

    await tab.goto(page.toString(), { waitUntil: 'networkidle2', timeout: TIMEOUT });

    let handle;
    try {
      handle = await tab.waitForFunction(
        () => (window.__PROGRAMA_RESULT__ && window.__PROGRAMA_RESULT__.ready
          ? window.__PROGRAMA_RESULT__ : false),
        { timeout: TIMEOUT, polling: 300 },
      );
    } catch (err) {
      const status = await tab.evaluate(
        () => (document.getElementById('status') || {}).textContent || '').catch(() => '');
      throw new Error(`page never finished (status: ${JSON.stringify(status || 'empty')}` +
        `${noise.length ? ` · ${noise.slice(0, 3).join(' | ')}` : ''})`);
    }
    const result = await handle.jsonValue();

    if (!result || !result.dataUrl) throw new Error('the page never finished a GIF');

    const bytes = base64ToBytes(result.dataUrl.slice(result.dataUrl.indexOf(',') + 1));
    const meta = { ...result, dataUrl: undefined };
    return { bytes, meta };
  } finally {
    await browser.close();                      // browser time is billed until it closes
  }
}

// puppeteer.launch() rejects with 429 when the account is out of browser time
// (10 min/day on Free) or launching too fast (one new browser every 20s).
async function launch(env) {
  // Imported lazily: the upload path never touches it, so it costs nothing
  // unless someone actually asks for a server-side render.
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  try {
    return await puppeteer.launch(env.BROWSER);
  } catch (err) {
    if (err && err.status === 429) {
      err.message = 'out of browser time (10 min/day on the free plan) — try again later';
    }
    throw err;
  }
}

// ---- helpers --------------------------------------------------------------

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function withCors(response) {
  for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
  return response;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sha256(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
