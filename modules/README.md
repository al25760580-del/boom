# Adding a module

Every effect lives in its own folder with its sprite(s) and its own JS:

```
modules/
  registry.js        <- list of modules (add one line per module)
  <my-module>/
    module.js        <- required
    sprite.png       <- whatever assets you need
```

## 1. `module.js` contract

```js
export default {
  id: 'my-module',            // matches the folder name
  name: 'my effect',
  description: 'one line for the UI',
  nativeSize: 512,            // size the frames are authored at
  maxSize: 512,               // never export larger than this
  variants: [                 // at least one
    { id: 'default', name: 'default' },
  ],
  params: [                   // optional, rendered in the UI and accepted via URL
    { id: 'squish', label: 'squish', type: 'range', min: 0.5, max: 2, step: 0.05, value: 1.25 },
    { id: 'flip',   label: 'flip',   type: 'checkbox', value: false },
  ],

  /**
   * @param {HTMLImageElement} image  the user's image (already loaded)
   * @param {object} opts  {size, variant, params, onProgress(done, total)}
   * @returns {{frames: HTMLCanvasElement[], delays: number[]}}
   */
  async build(image, { size, variant, params, onProgress }) {
    // return one canvas per frame and its delay in milliseconds
  },
};
```

Rules of thumb:

* **Draw on a transparent canvas.** The encoder turns every pixel with
  `alpha < 128` into the transparent index, so just leave the background empty.
* **Load your assets with `new URL('sprite.png', import.meta.url)`** — plain
  relative paths resolve against the page, not against the module, and break as
  soon as the page is served from a different folder.
* Frames may be returned at `nativeSize`; the encoder resizes them to whatever
  the size budget ends up needing.
* Keep `build()` cheap enough to be called once per export (a few hundred ms).

## 2. Register it

Add one entry to `registry.js`:

```js
{
  id: 'my-module',
  name: 'my effect',
  dir: 'my-module',                                   // folder name
  variants: [{ id: 'default', name: 'default' }],
}
```

The UI, the URL API (`programa.html?url=...&fx=default`) and the budget search
pick it up from there — no other file has to change.

## 3. URL API

```
programa.html?url=<encoded image url>&fx=jet
programa.html?url=<...>&fx=petpet&squish=1.5&delay=40
```

| parameter | meaning |
|---|---|
| `url` | URL-encoded image URL (or a `data:` URL) |
| `fx` | effect id: any variant id (`jet`, `nuke`, `petpet`, …) or module id |
| `maxkb` | size budget in KB (default 250) |
| `prefer` | `balanced` / `smooth` / `sharp` |
| any module param | e.g. `squish=1.5`, `flip=1`, `keepAspect=1` |
| `raw=1` | hide the UI, show only the image (for embedding) |
| `download=1` | trigger the download when it is ready |
| `post=1` | `postMessage` the result as a data URL to the opener/parent |
| `proxy=1` | allow a public CORS proxy if the image host blocks direct loading |

A bare effect name also works: `programa.html?url=<...>&jet`.
