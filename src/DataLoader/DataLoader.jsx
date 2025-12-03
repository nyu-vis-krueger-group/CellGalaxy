// =============================
// useDataLoader.js  (with selection states)
// =============================
import { useEffect, useState, useRef, useCallback } from "react";
import {
  API_BASE,
  fetchMeta,
  fetchCoords,
  fetchUV,
  staticAtlasURL,
  headStaticAtlas,
  generateAtlasGrayGet,
  generateAtlasGrayPost,
  prewarm as prewarmAPI,
} from "../api/api";

// API base is centralized in ../api/api
const API = API_BASE;

export default function useDataLoader() {
  const [meta, setMeta] = useState(null);
  const [points, setPoints] = useState([]); // legacy single set (kept for compatibility)
  const [pointsRaw, setPointsRaw] = useState([]); // raw projection
  const [pointsUMAP, setPointsUMAP] = useState([]); // UMAP projection (2D/3D depending on is3D)
  const [loading, setLoading] = useState(true);

  // Rendering parameters (can be bound to UI)
  const [channels, setChannels] = useState([]);
  const [weights, setWeights] = useState({});
  const [alphas, setAlphas] = useState({});
  const [colors, setColors] = useState({});
  // New: per-channel window (min/max, unit consistent with backend: 0..65535)
  const [windows, setWindows] = useState({});
  const [imageSize, setImageSize] = useState(1.5);

  // Rendering mode settings
  const [renderMode, setRenderMode] = useState('sprites'); // 'sprites' | 'points'
  const [is3D, setIs3D] = useState(false); // 2D/3D toggle
  
  // —— Clustering overlay settings ——
  // two independent toggles: color overlay & outline
  const [clusterColorOn, setClusterColorOn] = useState(false);
  const [clusterOutlineOn, setClusterOutlineOn] = useState(false);
  // opacity for color overlay [0..1]
  const [clusterOpacity, setClusterOpacity] = useState(1.0);
  // line width (px) for outline mode
  const [clusterLineWidth, setClusterLineWidth] = useState(1.5);
  // cluster text annotation (LLM titles/descriptions)
  const [clusterAnnotationOn, setClusterAnnotationOn] = useState(false);
  const [clusterAnnotationModel, setClusterAnnotationModel] = useState("MedGemma");
  // Toggle for the visibility of fixed cluster preview images (off by default, enabled by user)
  const [clusterPreviewOn, setClusterPreviewOn] = useState(false);
  
  // UMAP mode settings (kept for compatibility, side-by-side uses both)
  const [useUMAP, setUseUMAP] = useState(false);

  // UV mapping and atlas URL for each chunk
  const [chunkUV, setChunkUV] = useState({});
  const [atlasURL, setAtlasURL] = useState({}); // Old: single atlas synthesized by server (kept for compatibility)
  const [atlasByChannel, setAtlasByChannel] = useState({}); // New: grayscale atlas per channel
  const [fetchingChunks, setFetchingChunks] = useState(new Set());
  const [dataVersion, setDataVersion] = useState(0);

  // Simple concurrency limiter (default max 6 concurrent requests)
  const limiterRef = useRef({ max: 6, inFlight: 0, queue: [] });
  const runWithLimit = (task) => new Promise((resolve) => {
    const run = async () => {
      limiterRef.current.inFlight++;
      try {
        const result = await task();
        resolve(result);
      } catch (e) {
        // Avoid unhandled rejection bubbling up
        try {
          console.error("runWithLimit task error", e);
        } catch {}
        resolve(undefined);
      } finally {
        limiterRef.current.inFlight--;
        const next = limiterRef.current.queue.shift();
        if (next) next();
      }
    };
    if (limiterRef.current.inFlight < limiterRef.current.max) run();
    else limiterRef.current.queue.push(run);
  });

  // Store all coordinate data (raw/UMAP2D/UMAP3D)
  const [allCoords, setAllCoords] = useState([]);

  // —— Selection related (new) ——
  const [selectionMode, setSelectionMode] = useState('none'); // 'none' | 'box' | 'lasso'
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedRegions, setSelectedRegions] = useState(() => []); // array of Set<number>
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedRegions([]);
  };
  // —— Filtered ids (dim non-matching) ——
  const [filteredIds, setFilteredIds] = useState(() => new Set());

  // —— Utility: safe normalization, avoid division by 0 ——
  function safeScale(v, minV, maxV) {
    const span = maxV - minV;
    if (!isFinite(span) || span === 0) return 0;
    return 2 * (v - minV) / span - 1;
  }

  // —— Utility: derive a reasonable default imageSize from atlas tile size —— 
  // Requirements: tile=64 → default 1.5; tile=16 → default 0.3; linear interpolation in between.
  function defaultImageSizeForTile(tile) {
    const t = Number(tile) || 16;
    const minTile = 16;
    const maxTile = 64;
    const clamped = Math.max(minTile, Math.min(maxTile, t));
    const ratio = (clamped - minTile) / (maxTile - minTile); // 0..1
    const minSize = 0.3;
    const maxSize = 1.5;
    return minSize + ratio * (maxSize - minSize);
  }

  // Build both projections (raw and UMAP) and normalize each set independently
  const applyAllProjections = () => {
    if (!allCoords || allCoords.length === 0) {
      setPoints([]);
      setPointsRaw([]);
      setPointsUMAP([]);
      return;
    }

    // Helper: project and normalize
    const projectAndNormalize = (getter) => {
      // First pass: project points and compute min/max without spreading large arrays
      const projected = new Array(allCoords.length);
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;

      for (let i = 0; i < allCoords.length; i++) {
        const src = allCoords[i];
        const { x, y, z } = getter(src);
        const item = { ...src, x, y, z: z ?? 0 };
        projected[i] = item;

        const vx = item.x;
        const vy = item.y;
        const vz = item.z || 0;
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }

      // Second pass: normalize
      for (let i = 0; i < projected.length; i++) {
        const p = projected[i];
        projected[i] = {
          ...p,
          label: p.label ?? (p.id % 11),
          x: safeScale(p.x, minX, maxX),
          y: -safeScale(p.y, minY, maxY),
          z: safeScale(p.z || 0, minZ, maxZ),
        };
      }
      return projected;
    };

    // Raw (2D)
    const rawGetter = (p) =>
      p?.raw ? { x: p.raw.x, y: p.raw.y, z: 0 } : { x: 0, y: 0, z: 0 };
    const scaledRaw = projectAndNormalize(rawGetter);
    setPointsRaw(scaledRaw);

    // UMAP (2D/3D depending on is3D)
    const umapGetter = (p) => {
      if (is3D && p.umap3d) return { x: p.umap3d.x, y: p.umap3d.y, z: p.umap3d.z ?? 0 };
      if (!is3D && p.umap2d) return { x: p.umap2d.x, y: p.umap2d.y, z: 0 };
      return { x: 0, y: 0, z: 0 };
    };
    const scaledUMAP = projectAndNormalize(umapGetter);
    setPointsUMAP(scaledUMAP);

    // Keep legacy `points` for compatibility (default to raw)
    setPoints(scaledRaw);
  };

  const refreshData = useCallback(async () => {
    setLoading(true);
    try {
      const abort = new AbortController();
      let metaJson = await fetchMeta(abort.signal);
      setMeta(metaJson);

      // Reset default size control value based on atlas tile size of current dataset
      if (metaJson && metaJson.atlas && metaJson.atlas.tile) {
        setImageSize(defaultImageSizeForTile(metaJson.atlas.tile));
      }

      let coords = await fetchCoords(abort.signal);
      if (!Array.isArray(coords)) coords = [];
      setAllCoords(coords);
      if (coords.length === 0) {
        setPoints([]);
        setChunkUV({});
        setAtlasURL({});
        setAtlasByChannel({});
        setFetchingChunks(new Set());
      }

      if (!metaJson || metaJson.error || coords.length === 0) {
        setChannels([]);
        setWeights({});
        setAlphas({});
        setColors({});
        setWindows({});
      }

      setDataVersion((v) => v + 1);
    } catch (error) {
      console.error("Failed to refresh data", error);
      setMeta({ error: "Failed to refresh data" });
      setAllCoords([]);
      setPoints([]);
      setChunkUV({});
      setAtlasURL({});
      setAtlasByChannel({});
      setFetchingChunks(new Set());
      setChannels([]);
      setWeights({});
      setAlphas({});
      setColors({});
      setWindows({});
      setDataVersion((v) => v + 1);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch meta + coords
  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // When allCoords data is loaded, build both projections
  useEffect(() => {
    if (allCoords.length > 0) applyAllProjections();
    else {
      setPoints([]);
      setPointsRaw([]);
      setPointsUMAP([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCoords]);

  // When 2D/3D mode changes, rebuild projections (side-by-side uses both)
  useEffect(() => {
    if (allCoords.length > 0) applyAllProjections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D]);

  // Fetch UV for a chunk (only once)
  const ensureUV = async (chunkId) => {
    if (!meta) return;
    if (chunkUV[chunkId]) return;
    try {
      const uv = await fetchUV(chunkId, meta.atlas.tile, undefined);
      setChunkUV((prev) => ({ ...prev, [chunkId]: uv }));
    } catch (e) {
      console.error("ensureUV failed", e);
    }
  };

  // Request atlas for a chunk (server-side RGBA synthesis)
  const fetchAtlas = async (chunkId) => {
    if (atlasURL[chunkId]) return;
    if (fetchingChunks.has(chunkId)) return;
    setFetchingChunks(new Set([...fetchingChunks, chunkId]));

    const body = {
      channels,
      composite: { weights, alphas, colors },
      tile: meta?.atlas?.tile ?? 16,
      profile: "default_v1",
    };

    const res = await fetch(`${API}/atlas/${chunkId}`, {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error("atlas request failed", await res.text());
      setFetchingChunks((s) => { const t = new Set(s); t.delete(chunkId); return t; });
      return;
    }

    // Convert image response to blob URL
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    setAtlasURL((prev) => ({ ...prev, [chunkId]: url }));
    setFetchingChunks((s) => { const t = new Set(s); t.delete(chunkId); return t; });
  };

  // Request "single-channel grayscale" atlas for a chunk (frontend overlays coloring), unified via /atlas
  const fetchAtlasGray = async (chunkId, channel) => {
    const existing = atlasByChannel[chunkId]?.[channel];
    if (existing) return;
    if (fetchingChunks.has(`g_${chunkId}_${channel}`)) return;
    setFetchingChunks((s) => new Set([...s, `g_${chunkId}_${channel}`]));

    try {
      await runWithLimit(async () => {
        const t = meta?.atlas?.tile ?? 16;
        const staticURL = staticAtlasURL(channel, t, chunkId);

        // 1) First try HEAD to probe static cache at fixed path (avoid duplicate image downloads)
        const ok = await headStaticAtlas(staticURL, undefined);
        if (ok) {
          setAtlasByChannel((prev) => ({
            ...prev,
            [chunkId]: { ...(prev[chunkId] || {}), [channel]: staticURL },
          }));
          return;
        }

        // 2) If not exists, trigger generation (GET alias → fallback to POST on failure)
        let gen = await generateAtlasGrayGet(chunkId, channel, t, undefined);
        if (!gen.ok && gen.status !== 304) {
          if (gen.status === 405 || gen.status === 404) {
            gen = await generateAtlasGrayPost(chunkId, channel, t, undefined);
            if (!gen.ok) {
              try { console.error("atlas generate POST failed", gen.status, await gen.text()); } catch {}
              return;
            }
          } else {
            try { console.error("atlas generate GET failed", gen.status, await gen.text()); } catch {}
            return;
          }
        }

        // 3) After generation, use static URL directly (let deck.gl load and use browser cache)
        setAtlasByChannel((prev) => ({
          ...prev,
          [chunkId]: { ...(prev[chunkId] || {}), [channel]: staticURL },
        }));
      });
    } catch (e) {
      console.error("atlas(single) GET error", e);
    } finally {
      setFetchingChunks((s) => { const t = new Set(s); t.delete(`g_${chunkId}_${channel}`); return t; });
    }
  };

  // Calculate priority chunks (group by chunk, fetch all); use allCoords to cover both views
  useEffect(() => {
    if (!meta || loading) return;
    const chunks = new Set((allCoords || []).map((p) => p.chunk_id));
    (async () => {
      for (const c of chunks) {
        await ensureUV(c);
        // New approach: frontend overlay -> fetch grayscale atlas for each channel
        for (const ch of (channels || [])) {
          await fetchAtlasGray(c, ch);
        }
        // Compatible with old approach: can also keep backend synthesis (can be gradually removed)
        // fetchAtlas(c);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, loading, channels, renderMode, is3D, allCoords]);

  // When selected channels change, notify backend for async prewarming to reduce subsequent first-packet latency
  useEffect(() => {
    if (!meta || !channels || channels.length === 0) return;
    const t = meta?.atlas?.tile ?? 16;
    (async () => {
      for (const ch of channels) {
        try {
          prewarmAPI(ch, t);
        } catch {}
      }
    })();
  }, [channels, meta]);

  return {
    // Data state
    meta,
    points, // legacy
    pointsRaw,
    pointsUMAP,
    loading,
    chunkUV,
    atlasURL,
    atlasByChannel,
    fetchingChunks,
    
    // Rendering parameters
    channels,
    weights,
    alphas,
    colors,
    windows,
    imageSize,
    
    // Rendering mode
    renderMode,
    is3D,
    
    // Clustering overlay
    clusterColorOn,
    setClusterColorOn,
    clusterOutlineOn,
    setClusterOutlineOn,
    clusterOpacity,
    setClusterOpacity,
    clusterLineWidth,
    setClusterLineWidth,
    clusterAnnotationOn,
    setClusterAnnotationOn,
    clusterAnnotationModel,
    setClusterAnnotationModel,
    clusterPreviewOn,
    setClusterPreviewOn,
    
    // UMAP mode (kept for compatibility)
    useUMAP,

    // —— Selection (exported for App/Viewer/Control use) ——
    selectionMode,
    setSelectionMode,
    selectedIds,
    setSelectedIds,
    selectedRegions,
    setSelectedRegions,
    clearSelection,
    filteredIds,
    setFilteredIds,
    
    // Setter functions
    setChannels,
    setWeights,
    setAlphas,
    setColors,
    setWindows,
    setRenderMode,
    setIs3D,
    setUseUMAP,
    setImageSize,
    refreshData,
    dataVersion,
    
    // Data fetching functions
    ensureUV,
    fetchAtlas,
    fetchAtlasGray,
  };
}
