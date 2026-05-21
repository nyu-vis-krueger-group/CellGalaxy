/* eslint-disable no-console */

export const API_BASE =
  typeof window !== "undefined" &&
  window.location &&
  window.location.port === "3000"
    ? "http://localhost:8000"
    : "";

export function staticAtlasURL(channel, tile, chunkId) {
  return `${API_BASE}/public/cache/ch${channel}/tile_${tile}/chunk_${chunkId}.png`;
}

export async function fetchJSON(url, { signal, method = "GET", headers, body, cache = "no-store" } = {}) {
  const res = await fetch(url, { signal, method, headers, body, cache });
  if (!res.ok) {
    const text = await safeReadText(res);
    const err = new Error(`HTTP ${res.status} ${res.statusText} ${text ? "- " + text : ""}`);
    err.status = res.status;
    err.statusText = res.statusText;
    throw err;
  }
  return res.json();
}

export async function fetchMeta(signal) {
  try {
    return await fetchJSON(`${API_BASE}/meta`, { signal });
  } catch (e) {
    console.error("fetchMeta failed", e);
    return { error: "Failed to fetch meta" };
  }
}

export async function fetchViolinGlobalKDE(max = 80000, perc = 99.0, thr = 0.1, channels = null, grid = 256, signal) {
  try {
    const chParam = Array.isArray(channels) && channels.length > 0 ? `&channels=${channels.join(",")}` : "";
    return await fetchJSON(`${API_BASE}/violin/global_kde?max_samples_per_channel=${max}&perc_for_thr=${perc}&thr_factor=${thr}&grid=${grid}${chParam}`, { signal });
  } catch (e) {
    console.error("fetchViolinGlobalKDE failed", e);
    return { error: "Failed to fetch violin global KDE" };
  }
}
export async function fetchCoords(signal) {
  try {
    const url = `${API_BASE}/public/coords.json?ts=${Date.now()}`;
    const res = await fetch(url, { signal, cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
    return [];
  } catch (e) {
    console.warn("fetchCoords failed", e);
    return [];
  }
}

/** Full spatial centroids (all CSV rows) for spatial hover pick. */
export async function fetchSpatialCoords(signal) {
  try {
    const url = `${API_BASE}/public/spatial_coords.json?ts=${Date.now()}`;
    const res = await fetch(url, { signal, cache: "no-store" });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn("fetchSpatialCoords failed", e);
    return [];
  }
}

const _cellPreviewUrlCache = new Map();

/** PNG preview for one Zarr cell (off-atlas spatial hover). */
export function cellPreviewURL(cellId, channels, windows, size = 128) {
  const chList = (Array.isArray(channels) ? channels : []).map((c) => Number(c)).filter(Number.isFinite);
  if (chList.length === 0) return null;
  const mins = [];
  const maxs = [];
  for (const ch of chList) {
    const w = windows?.[ch] || {};
    mins.push(Number.isFinite(w.min) ? w.min : 0);
    maxs.push(Number.isFinite(w.max) ? w.max : 65535);
  }
  const key = `${cellId}|${chList.join(",")}|${mins.join(",")}|${maxs.join(",")}|${size}`;
  const cached = _cellPreviewUrlCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({
    channels: chList.join(","),
    win_min: mins.join(","),
    win_max: maxs.join(","),
    size: String(size),
  });
  const url = `${API_BASE}/cell/${cellId}/preview.png?${params}`;
  _cellPreviewUrlCache.set(key, url);
  return url;
}

export async function fetchUV(chunkId, tile, signal) {
  return fetchJSON(`${API_BASE}/atlas_uv/${chunkId}?tile=${tile}`, { signal });
}

export async function headStaticAtlas(url, signal) {
  try {
    const res = await fetch(url, { method: "HEAD", signal });
    return res.ok || res.status === 304;
  } catch (e) {
    return false;
  }
}

export async function generateAtlasGrayGet(chunkId, channel, tile, signal) {
  return fetch(`${API_BASE}/atlas/${chunkId}?channel=${channel}&tile=${tile}`, {
    method: "GET",
    signal,
  });
}

export async function generateAtlasGrayPost(chunkId, channel, tile, signal) {
  return fetch(`${API_BASE}/atlas/${chunkId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channels: [channel], tile }),
    signal,
  });
}

export function prewarm(channel, tile) {
  try {
    fetch(`${API_BASE}/prewarm?channel=${channel}&tile=${tile}`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

/** T1 neighbors; neighborSpace: umap | embedding */
export async function fetchT1(queryId, k = 8, signal, neighborSpace = "umap") {
  try {
    const sp = neighborSpace === "embedding" ? "embedding" : "umap";
    return await fetchJSON(
      `${API_BASE}/features/t1?q=${queryId}&k=${k}&neighbor_space=${encodeURIComponent(sp)}`,
      { signal }
    );
  } catch (e) {
    console.error("fetchT1 failed", e);
    return { error: "Failed to fetch T1" };
  }
}

export async function fetchT2(ids, signal) {
  try {
    const res = await fetch(`${API_BASE}/features/t2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("fetchT2 failed", e);
    return { error: "Failed to fetch T2" };
  }
}

export async function fetchRegionRepresentatives(regions, metric = "cosine_centered", signal) {
  try {
    const res = await fetch(`${API_BASE}/features/representatives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions, metric }),
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("fetchRegionRepresentatives failed", e);
    return { error: "Failed to fetch region representatives" };
  }
}

export async function fetchViolinSelectionKDE(ids, max = 30000, perc = 99.0, thr = 0.1, channels = null, grid = 192, signal) {
  try {
    // Cap ids sent to KDE so cost stays bounded (800 / 400 / 200 by selection size).
    const rawIds = Array.isArray(ids) ? ids : [];
    const total = rawIds.length;
    let idLimit;
    if (total <= 2000) {
      idLimit = 800;
    } else if (total <= 10000) {
      idLimit = 400;
    } else {
      idLimit = 200;
    }

    let effectiveIds = rawIds;
    if (effectiveIds.length > idLimit) {
      // Shuffle then take first idLimit (avoid always using prefix of list).
      const temp = effectiveIds.slice();
      for (let i = temp.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = temp[i];
        temp[i] = temp[j];
        temp[j] = t;
      }
      effectiveIds = temp.slice(0, idLimit);
    }

    const body = { ids: effectiveIds, max, perc, thr, grid };
    if (Array.isArray(channels) && channels.length > 0) body.channels = channels;
    const res = await fetch(`${API_BASE}/violin/selection_kde`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("fetchViolinSelectionKDE failed", e);
    return { error: "Failed to fetch violin selection KDE" };
  }
}

export async function fetchViolinSelectionCellKDE(
  ids,
  maxCells = 400,
  channels = null,
  grid = 192,
  signal
) {
  try {
    const body = { ids, max_cells: maxCells, grid };
    if (Array.isArray(channels) && channels.length > 0) body.channels = channels;
    const res = await fetch(`${API_BASE}/violin/selection_kde_cell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("fetchViolinSelectionCellKDE failed", e);
    return { error: "Failed to fetch violin selection KDE (cell means)" };
  }
}

export async function runLLMClusterChannelAvg(signal) {
  try {
    const res = await fetch(`${API_BASE}/llm/compute_cluster_channel_avg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("runLLMClusterChannelAvg failed", e);
    return { error: "Failed to run LLM precompute" };
  }
}

export async function runLLMGenerateClusterLabels(options = {}, signal) {
  try {
    const res = await fetch(`${API_BASE}/llm/generate_cluster_labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options || {}),
      signal,
    });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("runLLMGenerateClusterLabels failed", e);
    return { error: "Failed to generate cluster labels" };
  }
}

export async function fetchClusterLabels(signal) {
  try {
    const res = await fetch(`${API_BASE}/llm/cluster_labels`, { method: "GET", signal, cache: "no-store" });
    if (!res.ok) throw new Error(await safeReadText(res));
    return await res.json();
  } catch (e) {
    console.error("fetchClusterLabels failed", e);
    return { levels: {} };
  }
}
async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
