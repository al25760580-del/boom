# worker/ — the tiny backend for embeds

`programa.html` is a static page, and crawlers do not run JavaScript: when you
paste a `?url=…&fx=jet` link into Discord, the bot downloads the HTML, reads the
`<meta>` tags and leaves. The GIF does not exist yet, so nothing can be
embedded.

This worker fixes that without rendering anything. **The GIF is still made in
the visitor's browser** — canvas, gifenc, the optional gifsicle WASM, all of it.
The worker only stores the finished bytes and serves them back:

```
browser renders ──POST /g──▶ worker ──▶ R2 ──▶ https://…/g/<id>.gif
                                                      ▲
Discord card ◀── GET /view?id=<id> ───────────────────┘
```

Because the URL ends in `.gif` and the content type is `image/gif`, Discord
embeds **and animates** it. No headless browser, no Browser Run, no browser
minutes.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/g?fx=jet&size=192&kb=216&frames=49` | stores the GIF bytes from the body, returns `{ id, gif, view, url, share }` |
| `GET` | `/g/<id>.gif` | the GIF, `image/gif`, cached forever |
| `GET` | `/view?id=<id>` | a card whose `og:image` is `/g/<id>.gif` |
| `GET` | `/avatar/<discord id>.png?size=256` | a Discord user's avatar (needs `DISCORD_TOKEN`) |
| `GET` | `/` | redirect to the app |

`POST /g` answers with CORS headers, so the page on GitHub Pages can upload
directly.

## Deploy, step by step

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)
and Node 20 or newer.

**1. Install and log in**

```bash
cd worker
npm install
npx wrangler login          # opens a browser window to authorise the CLI
```

**2. Create the bucket**

```bash
npx wrangler r2 bucket create boom-gifs
```

**3. Deploy**

```bash
npx wrangler deploy
```

Wrangler prints the URL, something like
`https://boom-embed.<your-subdomain>.workers.dev`. That is your **worker URL**.

**4. Tell the app about it**

`programa.html` already points at the deployed worker:

```js
const RENDER_BASE = 'https://boom.milanesa2con2limon.workers.dev';
```

The button in the app reads **upload + copy embed link**: it uploads the GIF,
then copies a `/view?id=…` link you can paste straight into Discord.

If you deploy your own copy, change that line to your URL (no trailing slash),
or leave it empty and pass a worker per link with `?render=<worker url>`.

> **The Worker name has to match `name` in `wrangler.toml`.** Workers Builds
> fails with `Failed to match Worker name` and tries to open a pull request
> otherwise. If you call yours something other than `boom`, change `name` in
> `wrangler.toml` to match it.

**5. Test it**

```bash
WORKER=https://boom-embed.<your-subdomain>.workers.dev

# upload a GIF you already have
curl -s -X POST "$WORKER/g?fx=nuke&size=192&kb=216&frames=27" \
     --data-binary @resultados/input-nuke.gif | tee /tmp/up.json

# fetch it back
ID=$(python3 -c "import json;print(json.load(open('/tmp/up.json'))['id'])")
curl -s -o /tmp/back.gif -w '%{http_code} %{content_type} %{size_download}\n' "$WORKER/g/$ID.gif"
cmp resultados/input-nuke.gif /tmp/back.gif && echo "byte identical"
```

Then paste `$WORKER/view?id=$ID` into Discord.

## For bots: `/petpet @user`

Two endpoints take the same parameters as the page and do the work on the
server, so a bot does not need a browser of its own:

```
GET /render.gif?url=<image>&fx=petpet     →  the GIF bytes
GET /render?url=<image>&fx=petpet         →  { url, view, bytes, size, kb, … }
GET /render?discord=<user id>&fx=petpet   →  same, with that user's avatar
```

```js
// from a Discord slash command, ~4 lines:
const r = await fetch(`https://boom.milanesa2con2limon.workers.dev/render?` +
  new URLSearchParams({ url: member.displayAvatarURL({ size: 256 }), fx: 'petpet' }));
const { url } = await r.json();
await interaction.reply(url);        // Discord embeds and animates it
```

### URLs you can build without asking

An id is `sha256` of the inputs, so **the same parameters always produce the
same URL** — a bot can work it out itself and skip the round trip:

```js
const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode([src, fx, maxkb, prefer, gifsicle, lossy].join('|'))))]
  .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

const url = `https://boom.milanesa2con2limon.workers.dev/g/${id}.gif`;
```

Use the defaults when you omit a field: `maxkb=250`, `prefer=balanced`,
`gifsicle=0`, `lossy=` (empty). If that URL 404s, nobody has rendered that
combination yet — call `/render` once, and it will exist forever after.

### What `/render` costs

Workers Free gives **10 ms of CPU per request**, and encoding a GIF takes
hundreds of milliseconds, so this cannot run as plain Worker code. `/render`
opens the app in headless Chromium (Browser Run) instead, which spends *browser
minutes* rather than Worker CPU: **10 minutes a day** on the free plan, roughly
120 renders, one new browser every 20 seconds. Results are stored in R2 under
the hash above, so a repeated request never touches the browser again.

If you outgrow it, the options are Workers Paid ($5/month, render in pure JS
with no browser at all) or rendering in the bot process itself with
`@napi-rs/canvas`.

## Uploads are open on purpose

`UPLOAD_KEY` is empty, so anyone can `POST /g`. That is deliberate: it is a
toy for everyone. Storage is capped by the bucket (10 GB free ≈ 40,000 GIFs) and
nothing else depends on it.

## Optional hardening

**Stop strangers from uploading** — put a secret in `wrangler.toml` and send it
as a header:

```toml
[vars]
UPLOAD_KEY = "something-long-and-random"
```

The app sends it automatically as `x-boom-key` once you set the same value in
`programa.html` (`const UPLOAD_KEY = '…'`).

**Discord avatars** — to use `?discord=<user id>` you need a bot token:

1. <https://discord.com/developers/applications> → *New Application* → name it
   anything.
2. *Bot* → *Reset Token* → copy the token. (No intents or permissions needed;
   it only reads public user data.)
3. Store it as a secret, never in the file:

```bash
npx wrangler secret put DISCORD_TOKEN
```

Now `https://<worker>/avatar/1385341957500567574.png?size=256` returns that
user's avatar, or `404` if no such user exists. Results are cached for a day, so
each user costs at most one Discord API call per day.

## Costs and limits

| | Free plan |
| --- | --- |
| Workers | 100,000 requests/day |
| R2 storage | 10 GB (≈ 40,000 GIFs at 250 KB) |
| R2 writes | 1,000,000/month |
| R2 reads | 10,000,000/month |
| Egress | free |

Realistically you will never leave the free tier. If you want old GIFs to
disappear on their own, add a lifecycle rule to the bucket:
*R2 → boom-gifs → Settings → Object lifecycle rules → Delete after 90 days*.

## Troubleshooting

**Discord shows the old image.** Discord caches embeds by URL. Every upload gets
a new id, so upload again and share the new link.

**`404 no such gif`.** The id is unknown — either it was never uploaded, or the
object was deleted by a lifecycle rule.

**`501 DISCORD_TOKEN is not set`.** Run `npx wrangler secret put DISCORD_TOKEN`
and try again.

**`429 rate limited by Discord`.** The avatar lookup hit Discord's API limits.
Wait a moment; the next request is cached for 24 h.

**Local testing.** `npx wrangler dev --remote` runs against real R2. Plain
`npx wrangler dev` keeps storage in memory and forgets everything on restart.
