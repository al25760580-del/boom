/**
 * modules/registry.js - which modules exist and how to load them.
 *
 * To add a new effect:
 *   1. create modules/<id>/ with your sprite(s) and a module.js
 *   2. add one entry here (id, name, folder, variants)
 *   That is it: the UI, the URL API and the encoder pick it up automatically.
 */
export const REGISTRY = [
  {
    id: 'explode',
    name: 'explosion',
    dir: 'explode',
    variants: [
      { id: 'nuke', name: 'nuke' },
      { id: 'house', name: 'house' },
      { id: 'earth', name: 'earth' },
      { id: 'supernova', name: 'supernova (implode)' },
      { id: 'airstrikes', name: 'air strikes' },
      { id: 'jet', name: 'plane crash' },
      { id: 'deltarune', name: 'deltarune' },
    ],
  },
  {
    id: 'petpet',
    name: 'petpet',
    dir: 'petpet',
    variants: [{ id: 'petpet', name: 'petpet' }],
  },
];

const cache = new Map();

/** Dynamically imports a module (only what is actually used gets downloaded). */
export function loadModule(id) {
  if (!cache.has(id)) {
    const entry = REGISTRY.find((m) => m.id === id);
    if (!entry) return Promise.reject(new Error('unknown module: ' + id));
    cache.set(id, import(`./${entry.dir}/module.js`).then((m) => m.default));
  }
  return cache.get(id);
}

/** Every selectable effect, flattened: {moduleId, variantId, name}. */
export function allEffects() {
  const out = [];
  for (const m of REGISTRY) {
    for (const v of m.variants) out.push({ moduleId: m.id, variantId: v.id, name: v.name });
  }
  return out;
}

/**
 * Resolves an effect id coming from the UI or the URL.
 * Accepts a variant id ("jet", "nuke") or a module id ("petpet", "explode").
 */
export function resolveFx(fxId) {
  if (!fxId) return null;
  for (const m of REGISTRY) {
    const v = m.variants.find((x) => x.id === fxId);
    if (v) return { moduleId: m.id, variantId: v.id, name: v.name };
  }
  const m = REGISTRY.find((x) => x.id === fxId);
  if (m) return { moduleId: m.id, variantId: m.variants[0].id, name: m.variants[0].name };
  return null;
}
