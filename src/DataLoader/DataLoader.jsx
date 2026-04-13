// Loads meta/coords/atlas; selection + render state.
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

const API = API_BASE;

export default function useDataLoader() {
  const [meta, setMeta] = useState(null);
  const [points, setPoints] = useState([]); // legacy default raw
  const [pointsRaw, setPointsRaw] = useState([]);
  const [pointsUMAP, setPointsUMAP] = useState([]);
  const [loading, setLoading] = useState(true);

  // Render params (UI-bound)
  const [channels, setChannels] = useState([]);
  const [weights, setWeights] = useState({});
  const [alphas, setAlphas] = useState({});
  const [colors, setColors] = useState({});
  // Per-channel window 0..65535
  const [windows, setWindows] = useState({});
  const [imageSize, setImageSize] = useState(1.5);
  // Raw size from tile/range; slider → UMAP only
  const [rawImageSize, setRawImageSize] = useState(1.5);

  const [renderMode, setRenderMode] = useState('sprites');
  const [is3D, setIs3D] = useState(false);
  
  // Cluster overlay: fill + outline
  const [clusterColorOn, setClusterColorOn] = useState(false);
  const [clusterOutlineOn, setClusterOutlineOn] = useState(false);
  // Fill opacity 0..1
  const [clusterOpacity, setClusterOpacity] = useState(1.0);
  // Outline width (px)
  const [clusterLineWidth, setClusterLineWidth] = useState(1);
  // LLM cluster text
  const [clusterAnnotationOn, setClusterAnnotationOn] = useState(false);
  const [clusterAnnotationModel, setClusterAnnotationModel] = useState("MedGemma");
  // UMAP cluster preview thumbs
  const [clusterPreviewOn, setClusterPreviewOn] = useState(false);

  // raw.json has celltype/neigh_names flags
  const [rawAnnotationColumns, setRawAnnotationColumns] = useState({ celltype: false, neigh_names: false });
  const [cellTypeAnnotationOn, setCellTypeAnnotationOn] = useState(false);
  const [neighNamesAnnotationOn, setNeighNamesAnnotationOn] = useState(false);
  
  // Single-view UMAP toggle
  const [useUMAP, setUseUMAP] = useState(false);

  const [chunkUV, setChunkUV] = useState({});
  const [atlasURL, setAtlasURL] = useState({}); // legacy merged atlas
  const [atlasByChannel, setAtlasByChannel] = useState({}); // per-ch grayscale
  const [fetchingChunks, setFetchingChunks] = useState(new Set());
  const [dataVersion, setDataVersion] = useState(0);

  // Request queue, max 6 parallel
  const limiterRef = useRef({ max: 6, inFlight: 0, queue: [] });
  const runWithLimit = (task) => new Promise((resolve) => {
    const run = async () => {
      limiterRef.current.inFlight++;
      try {
        const result = await task();
        resolve(result);
      } catch (e) {
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

  // coords.json rows
  const [allCoords, setAllCoords] = useState([]);

  const [selectionMode, setSelectionMode] = useState('none');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedRegions, setSelectedRegions] = useState(() => []);
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedRegions([]);
  };
  // Dim points not in filter
  const [filteredIds, setFilteredIds] = useState(() => new Set());

  function safeScale(v, minV, maxV) {
    const span = maxV - minV;
    if (!isFinite(span) || span === 0) return 0;
    return 2 * (v - minV) / span - 1;
  }

  // Default sprite size from tile (16→0.3, 64→1.5, linear).
  function defaultImageSizeForTile(tile) {
    const t = Number(tile) || 16;
    const minTile = 16;
    const maxTile = 64;
    const clamped = Math.max(minTile, Math.min(maxTile, t));
    const ratio = (clamped - minTile) / (maxTile - minTile);
    const minSize = 0.3;
    const maxSize = 1.5;
    return minSize + ratio * (maxSize - minSize);
  }

  // Raw view: sprite size from tile + raw span (ref viewport 500px, small overlap).
  const RAW_REFERENCE_VIEWPORT = 500;
  const RAW_GRID_SAFETY = 1.05;
  function imageSizeFromTileAndRawRange(tilePx, coords) {
    if (!coords?.length || tilePx == null || tilePx <= 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < coords.length; i++) {
      const r = coords[i]?.raw;
      if (r && typeof r.x === "number") { if (r.x < minX) minX = r.x; if (r.x > maxX) maxX = r.x; }
      if (r && typeof r.y === "number") { if (r.y < minY) minY = r.y; if (r.y > maxY) maxY = r.y; }
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (!Number.isFinite(spanX) || spanX <= 0 || !Number.isFinite(spanY) || spanY <= 0) return null;
    const sizeX = (tilePx * RAW_REFERENCE_VIEWPORT) / spanX;
    const sizeY = (tilePx * RAW_REFERENCE_VIEWPORT) / spanY;
    return Math.min(sizeX, sizeY) * RAW_GRID_SAFETY;
  }

  // Project raw + UMAP, normalize each separately
  const applyAllProjections = () => {
    if (!allCoords || allCoords.length === 0) {
      setPoints([]);
      setPointsRaw([]);
      setPointsUMAP([]);
      return;
    }

    const projectAndNormalize = (getter) => {
      // Pass 1: project + bbox
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

      // Pass 2: normalize to [-1,1]-ish
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

    const rawGetter = (p) =>
      p?.raw ? { x: p.raw.x, y: p.raw.y, z: 0 } : { x: 0, y: 0, z: 0 };
    const scaledRaw = projectAndNormalize(rawGetter);
    setPointsRaw(scaledRaw);

    const umapGetter = (p) => {
      if (is3D && p.umap3d) return { x: p.umap3d.x, y: p.umap3d.y, z: p.umap3d.z ?? 0 };
      if (!is3D && p.umap2d) return { x: p.umap2d.x, y: p.umap2d.y, z: 0 };
      return { x: 0, y: 0, z: 0 };
    };
    const scaledUMAP = projectAndNormalize(umapGetter);
    setPointsUMAP(scaledUMAP);

    // Legacy `points` = raw
    setPoints(scaledRaw);
  };

  const refreshData = useCallback(async () => {
    setLoading(true);
    try {
      const abort = new AbortController();
      let metaJson = await fetchMeta(abort.signal);
      setMeta(metaJson);

      // Upload status → annotation column flags
      try {
        const statusRes = await fetch(`/upload/status?ts=${Date.now()}`, { cache: "no-store", signal: abort.signal });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          setRawAnnotationColumns(statusData?.raw_annotation_columns || { celltype: false, neigh_names: false });
        }
      } catch (_) {
        setRawAnnotationColumns({ celltype: false, neigh_names: false });
      }

      let coords = await fetchCoords(abort.signal);
      if (!Array.isArray(coords)) coords = [];
      setAllCoords(coords);

      // Initial sizes from tile + raw span; UMAP capped by slider max
      const tilePx = metaJson?.atlas?.tile;
      const fromTileAndRange = tilePx != null && coords.length > 0
        ? imageSizeFromTileAndRawRange(tilePx, coords)
        : null;
      const UMAP_SIZE_CAP = 6;
      if (fromTileAndRange != null) {
        const byTile = defaultImageSizeForTile(tilePx);
        const size = Math.min(byTile, fromTileAndRange);
        setRawImageSize(size);
        setImageSize(Math.min(UMAP_SIZE_CAP, size));
      } else if (metaJson?.atlas?.tile != null) {
        const size = defaultImageSizeForTile(metaJson.atlas.tile);
        setRawImageSize(size);
        setImageSize(Math.min(UMAP_SIZE_CAP, size));
      }

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

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Rebuild projections when coords load
  useEffect(() => {
    if (allCoords.length > 0) applyAllProjections();
    else {
      setPoints([]);
      setPointsRaw([]);
      setPointsUMAP([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCoords]);

  // is3D flip → rebuild UMAP projection
  useEffect(() => {
    if (allCoords.length > 0) applyAllProjections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D]);

  // Chunk UV once
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

  // Legacy POST merged atlas per chunk
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

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    setAtlasURL((prev) => ({ ...prev, [chunkId]: url }));
    setFetchingChunks((s) => { const t = new Set(s); t.delete(chunkId); return t; });
  };

  // Grayscale atlas per channel (HEAD static → GET/POST generate)
  const fetchAtlasGray = async (chunkId, channel) => {
    const existing = atlasByChannel[chunkId]?.[channel];
    if (existing) return;
    if (fetchingChunks.has(`g_${chunkId}_${channel}`)) return;
    setFetchingChunks((s) => new Set([...s, `g_${chunkId}_${channel}`]));

    try {
      await runWithLimit(async () => {
        const t = meta?.atlas?.tile ?? 16;
        const staticURL = staticAtlasURL(channel, t, chunkId);

        // 1) HEAD static cache
        const ok = await headStaticAtlas(staticURL, undefined);
        if (ok) {
          setAtlasByChannel((prev) => ({
            ...prev,
            [chunkId]: { ...(prev[chunkId] || {}), [channel]: staticURL },
          }));
          return;
        }

        // 2) Generate: GET then POST if needed
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

        // 3) Point layer at static URL (browser cache)
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

  // Prefetch UV + gray atlas per chunk/channel
  useEffect(() => {
    if (!meta || loading) return;
    const chunks = new Set((allCoords || []).map((p) => p.chunk_id));
    (async () => {
      for (const c of chunks) {
        await ensureUV(c);
        for (const ch of (channels || [])) {
          await fetchAtlasGray(c, ch);
        }
        // fetchAtlas(c); // legacy merged atlas
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, loading, channels, renderMode, is3D, allCoords]);

  // Prewarm atlas on channel change
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
    meta,
    points,
    pointsRaw,
    pointsUMAP,
    loading,
    chunkUV,
    atlasURL,
    atlasByChannel,
    fetchingChunks,
    
    channels,
    weights,
    alphas,
    colors,
    windows,
    imageSize,
    rawImageSize,

    renderMode,
    is3D,
    
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

    rawAnnotationColumns,
    cellTypeAnnotationOn,
    setCellTypeAnnotationOn,
    neighNamesAnnotationOn,
    setNeighNamesAnnotationOn,
    
    useUMAP,

    selectionMode,
    setSelectionMode,
    selectedIds,
    setSelectedIds,
    selectedRegions,
    setSelectedRegions,
    clearSelection,
    filteredIds,
    setFilteredIds,
    
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
    
    ensureUV,
    fetchAtlas,
    fetchAtlasGray,
  };
}
