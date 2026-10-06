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
    } catch (err) {
      return withCors(json({ error: err.message }, 500));
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

  const id = newId();
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
<meta http-equiv="refresh" content="0; url=${esc(APP)}">
</head><body style="background:#12100f;color:#f2e9e1;font:15px system-ui;margin:0;padding:3rem">
<p>opening <a style="color:#ff7a3d" href="${esc(APP)}">programa</a>…</p>
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
