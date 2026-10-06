# 💥 programa — transparent image effects

Take an image, apply an effect (explosion, petpet, …) and get back a **transparent animated GIF**
that fits a **file size budget**. Everything runs in the browser, statically — no server, no uploads.

Based on [explode.moth.monster](https://explode.moth.monster/) by mothdotmonster and
[petpet](https://benisland.neocities.org/petpet/) by benisland.

## What makes it different

| | the original tools | this one |
|---|---|---|
| canvas | filled with white (`#FFF`) / green screen key | **transparent (RGBA)** |
| compositing | `drawImage` | `alpha_composite`, real alpha |
| file size | whatever comes out | searched until it fits `maxkb` |
| structure | one-off scripts | **modules**, one folder each |

## Quick start

```bash
python3 -m http.server 8010     # then open http://localhost:8010
```

## URL API

```
programa.html?url=<url-encoded image url>&fx=jet
```

| parameter | meaning |
|---|---|
| `url` | URL-encoded image URL (a `data:` URL works too) |
| `discord` | a Discord user ID — their avatar is used as the image (needs the worker, see [Embeds](#embeds)) |
| `fx` | effect id: any variant (`jet`, `nuke`, `airstrikes`, `petpet`, …) or a module id |
| `maxkb` | size budget in KB (default 250) |
| `prefer` | `balanced` (default) / `smooth` / `sharp` |
| module params | `squish=1.5`, `flip=1`, `keepAspect=1`, … |
| `raw=1` | hide all the chrome and show only the image (for embedding in an iframe) |
| `download=1` | trigger the download as soon as it is ready |
| `post=1` | `postMessage` the result as a data URL to `window.opener` / `window.parent` |
| `gifsicle=1` | post-process with gifsicle-WASM (`-O3 --lossy`): smaller file or more resolution |
| `lossy=N` | cap the lossy level used by gifsicle (30 = mild, 80 = aggressive, default: try both) |
| `proxy=1` | allow a public CORS proxy when the image host blocks direct loading |
| `share=1` | upload the result to the worker and leave the embed link in the status line |
| `render=<url>` | worker URL for this link only, instead of the `RENDER_BASE` baked into the page |

A bare effect name also works: `programa.html?url=<...>&jet`.

## Embeds

A crawler never runs JavaScript, and GitHub Pages serves the same HTML for
every query string, so a link to this page can never embed the result.

The fix is a ~150 line Cloudflare Worker in [`worker/`](worker/README.md) that
**renders nothing**: the GIF is made in the browser exactly as always, then
uploaded with `POST /g` and served back from
`https://<worker>/g/<id>.gif` — a URL that ends in `.gif` and answers
`image/gif`, which is all Discord needs to embed it and play the animation.
Storage is R2 (10 GB free), so there are no browser minutes and no per-render
cost.

```bash
cd worker && npm install && npx wrangler login
npx wrangler r2 bucket create boom-gifs
npx wrangler deploy          # then put the URL in RENDER_BASE in programa.html
```

In the app, **upload + copy embed link** does the whole thing. `/view?id=<id>`
is a card (`og:image` → the GIF) and `/g/<id>.gif` is the bare animation.
With `DISCORD_TOKEN` set as a secret, `GET /avatar/<user id>.png` also resolves
Discord avatars, which is what `?discord=<id>` uses.

Examples:

```
programa.html?url=https%3A%2F%2Fexample.com%2Fcat.png&fx=jet
programa.html?url=https%3A%2F%2Fexample.com%2Fcat.png&petpet&squish=1.6&maxkb=100
programa.html?url=https%3A%2F%2Fexample.com%2Fcat.png&fx=nuke&raw=1&prefer=sharp
```

**CORS**: the image is fetched from the browser, so the host has to send
`Access-Control-Allow-Origin`. If it does not, the page says so; `proxy=1` routes the request
through `images.weserv.nl` (off by default, and it means a third party sees the URL).

For programmatic use the page also exposes:

```js
window.Programa = { render, loadImageFromUrl, loadModule, allEffects, resolveFx, toDataURL };

// render(imageElement, {moduleId, variantId, params, maxKb, prefer}) ->
//   { blob, bytes, url, size, colors, drop, kb }
```

## Modules

Each effect lives in its own folder with its sprite(s) and its JS:

```
modules/
  registry.js          <- add one entry per module
  README.md            <- the module contract
  explode/
    module.js
    res/nuke/00.webp … (frames from the original site)
  petpet/
    module.js
    sprite.png         <- hand sprite sheet, 5 frames of 112x112
```

**To add your own**: create `modules/<id>/module.js` exporting the contract described in
`modules/README.md`, drop your assets next to it, and add one entry to `modules/registry.js`.
The UI, the URL API and the budget search pick it up automatically — no other file changes.

Current modules:

| module | effects | source |
|---|---|---|
| `explode` | nuke, house, earth, supernova, air strikes, plane crash, deltarune | explode.moth.monster (MIT-0) |
| `petpet` | petpet | benisland.neocities.org/petpet |

## Optional: gifsicle in the browser (WASM)

`gifsicle=1` loads [gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser)
(gifsicle 1.92 as WebAssembly, 341 KB, lazy loaded only when asked for) and runs
`-O3 --lossy=N` on top of the gifenc output. Measured on these frames:

| | 256 px · 256 colors | 192 px · 192 colors |
|---|---|---|
| gifenc | 378 KB | 231 KB |
| `-O3` | 375 KB (−1 %) | 227 KB (−2 %) |
| `-O3 --lossy=30` | 297 KB (−21 %) | 191 KB (−17 %) |
| `-O3 --lossy=80` | 224 KB (−41 %) | 146 KB (−36 %) |

So the win is `--lossy`, not `-O3` (gifenc already writes compact frames). What that
buys you at the same 250 KB budget:

| effect | without gifsicle | with gifsicle |
|---|---|---|
| nuke | 384 px · **9** frames | 256 px · **27** frames |
| plane crash | 224 px · 25 frames | **320 px** · 25 frames |

The search only runs the WASM when it can actually help: it knows how much each
level takes off (measured: 30 → 79 %, 80 → 59 %), skips candidates that could not
fit even at the strongest level, and uses the mildest level that does.

## Why the GIF is not always 512 px

The explosion frames are photographic and grainy, the worst case for GIF's LZW: one frame at
512 px already weighs ~127 KB, so 22 of them cannot fit in 250 KB at that size. The cost scales
with `size^1.5` (measured), so the encoder measures your animation and picks the best
combination of **resolution × colors × frame skipping** that fits. Each attempt takes ~200 ms
in the browser, so the search encodes real candidates instead of guessing.

Measured with `input.png` (160×160 PNG) and a 250 KB budget:

| effect | resolution | frames | bytes |
|---|---|---|---|
| nuke | 192 px · 192 colors | 27 | 236 634 |
| air strikes | 224 px · 192 colors | 14 | 224 467 |
| plane crash | 224 px · 192 colors | 25 | 224 742 |
| nuke + `gifsicle=1` | 256 px · 256 colors | 27 | 229 749 |
| plane crash + `gifsicle=1` | 320 px · 256 colors | 25 | 253 432 |
| petpet | 112 px · 128 colors | 5 | 20 132 |

All of them keep the alpha of the source: transparent corners, ~56 % coverage
(69 % for petpet, the hand is bigger than the image).

## Python pipeline (optional)

`explode.py` does the same as the `explode` module but encodes with ffmpeg + gifsicle, which
squeezes slightly more quality per KB. Useful for batch work.

```bash
pip install pillow numpy imageio-ffmpeg     # ffmpeg installs itself if missing

python3 explode.py input.png --fx nuke airstrikes jet --max-kb 250
python3 explode.py input.png --fx nuke --prefer smooth --keep-aspect
python3 explode.py input.png --fx nuke --format webp      # full alpha, much lighter
python3 server.py 8000                                    # local UI for the encoder
```

Output goes to `resultados/`. Frames are read from `modules/explode/res/`.

## Layout

```
programa.html          app + URL API
index.html             redirects to programa.html (for GitHub Pages)
core/encoder.js        gifenc wrapper: palette, encoding, budget search
modules/               one folder per effect (see modules/README.md)
vendor/gifenc.esm.js   GIF encoder (MIT)
vendor/gifsicle-wasm.js  gifsicle 1.92 as WASM (lazy loaded, see credits)
core/fx.js             explode()/implode() from the original site, as an ES module
explode.py, server.py  optional Python pipeline
web/index.html         UI for the Python server
site/                  untouched copy of the original site
tools/gifsicle         binary used by the Python pipeline
resultados/            generated GIFs (gitignored)
```

## Publishing to GitHub Pages

1. Push this repository to GitHub.
2. *Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root*.
3. Your app is at `https://<user>.github.io/<repo>/programa.html?url=...&fx=jet`.

Everything it needs is inside the repository, so nothing is fetched from a CDN.

## Credits / license

* Original site and explosion frames: [mothdotmonster](https://github.com/mothdotmonster/explode.moth.monster) — MIT-0 / WTFGFY.
* `fx.js`: adapted from a StackOverflow answer by Blindman67 — CC-BY-SA-4.0.
* petpet hand sprite and animation: [benisland](https://benisland.neocities.org/petpet/).
* `gifenc`: [mattdesl](https://github.com/mattdesl/gifenc) — MIT.
* `gifsicle`: [Eddie Kohler](https://www.lcdf.org/gifsicle/) — GPL-2.0, WASM build
  [gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser) by renzhezhilu (MIT for the
  wrapper). **It is optional and off by default**: if you publish the site and do not
  want GPL code in it, delete `vendor/gifsicle-wasm.js` and `core/gifsicle.js`; everything
  else keeps working, just without the `--lossy` savings.
* This port: same spirit, differences listed above.
