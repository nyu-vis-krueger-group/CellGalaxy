/**
 * Shared HTMLImageElement loader with Promise dedupe, failed-URL eviction,
 * and a simple LRU cap so long sessions do not retain every atlas forever.
 */
const DEFAULT_MAX_ENTRIES = 64;

const _cache = new Map(); // url -> HTMLImageElement | Promise (insertion order = LRU)

function touch(key, value) {
  _cache.delete(key);
  _cache.set(key, value);
}

function evictIfNeeded(maxEntries) {
  while (_cache.size > maxEntries) {
    const oldest = _cache.keys().next().value;
    if (oldest == null) break;
    _cache.delete(oldest);
  }
}

export function loadImageCached(url, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (!url) return Promise.resolve(null);
  const key = String(url);
  const hit = _cache.get(key);
  if (hit instanceof HTMLImageElement && hit.complete && hit.naturalWidth > 0) {
    touch(key, hit);
    return Promise.resolve(hit);
  }
  if (hit && typeof hit.then === "function") return hit;

  const pending = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      touch(key, img);
      evictIfNeeded(maxEntries);
      resolve(img);
    };
    img.onerror = () => {
      _cache.delete(key);
      resolve(null);
    };
    img.src = key;
  });
  touch(key, pending);
  evictIfNeeded(maxEntries);
  return pending;
}
