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
import {
  clearOmeTiffFileHandle,
  getFileFromOmeTiffHandle,
  getStoredOmeTiffFileHandle,
} from "../utils/omeTiffLocalPersistence";
import {
  openOmeTiffAsPixelSources,
  openOmeTiffFromFile,
  computeOmeChannelRangeFromPixels,
} from "../ome/omeVivLoader";

const OME_TIFF_PUBLIC_PATH = "/public/image.ome.tif";

const API = API_BASE;

export default function useDataLoader() {
  const [meta, setMeta] = useState(null);
  const [points, setPoints] = useState([]); // legacy default raw
  const [pointsRaw, setPointsRaw] = useState([]);
  const [pointsUMAP, setPointsUMAP] = useState([]);
  const [loading, setLoading] = useState(true);

  // Render params (UI-bound)
  const [channels, setChannels] = useState([]);
  /** Latest channels for refreshData / prefetch without re-creating refreshData when selection changes. */
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
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
  const [omeTiffPresent, setOmeTiffPresent] = useState(false);
  /** Local OME-TIFF (browser File) — Viv path, no backend / no Zarr tiles */
  const [omeTiffFile, setOmeTiffFile] = useState(null);
  /** Handle persisted; after reload user must click to complete requestPermission. */
  const [omeTiffRestoreNeedsClick, setOmeTiffRestoreNeedsClick] = useState(false);
  const omeTiffSpatialActive = Boolean(omeTiffFile) || omeTiffPresent;
  /** channel_id (UI) → OME 0-based c from channel_info.json ome_c (from raw_index). */
  const [channelOmeIndexById, setChannelOmeIndexById] = useState({});
  /** channel_id (UI) -> channel display name, from channel_info.json */
  const [channelNameById, setChannelNameById] = useState({});
  /** channel_id (UI) -> whether explicit ome index exists in channel_info */
  const [channelHasExplicitOmeIndexById, setChannelHasExplicitOmeIndexById] = useState({});
  /** channel_id (UI) -> pixel range derived from OME-TIFF metadata */
  const [omePixelRangeByChannelId, setOmePixelRangeByChannelId] = useState({});

  const [chunkUV, setChunkUV] = useState({});
  const [atlasURL, setAtlasURL] = useState({}); // legacy merged atlas
  const [atlasByChannel, setAtlasByChannel] = useState({}); // per-ch grayscale
  const [fetchingChunks, setFetchingChunks] = useState(new Set());
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/public/channel_info.json?ts=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setChannelOmeIndexById({});
          return;
        }
        const data = await res.json();
        const m = {};
        const n = {};
        const explicit = {};
        for (const ch of data?.channels || []) {
          const id = Number(ch?.id);
          if (!Number.isFinite(id)) continue;
          n[id] = typeof ch?.name === "string" ? ch.name : "";
          const raw = ch.raw_index != null && ch.raw_index !== "" ? Number(ch.raw_index) : NaN;
          let omeC;
          // raw_index: 1-based OME channel index in file → Viv c = raw_index - 1
          if (Number.isFinite(raw) && raw >= 1) {
            omeC = Math.max(0, Math.floor(raw) - 1);
            explicit[id] = true;
            // JSON null → Number(null) is 0 (finite): must not treat as explicit ome_c.
          } else if (ch?.ome_c != null && ch.ome_c !== "" && Number.isFinite(Number(ch.ome_c))) {
            omeC = Number(ch.ome_c);
            explicit[id] = true;
          } else {
            omeC = id;
            explicit[id] = false;
          }
          m[id] = omeC;
        }
        if (!cancelled) {
          setChannelOmeIndexById(m);
          setChannelNameById(n);
          setChannelHasExplicitOmeIndexById(explicit);
        }
      } catch {
        if (!cancelled) {
          setChannelOmeIndexById({});
          setChannelNameById({});
          setChannelHasExplicitOmeIndexById({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  useEffect(() => {
    let cancelled = false;
    const hasRemoteOme = Boolean(!omeTiffFile && omeTiffPresent);
    const hasLocalOme = Boolean(omeTiffFile);
    if (!hasLocalOme && !hasRemoteOme) {
      setOmePixelRangeByChannelId({});
      return undefined;
    }

    const remoteUrl = hasRemoteOme
      ? (API_BASE
          ? `${API_BASE}${OME_TIFF_PUBLIC_PATH}`
          : `${typeof window !== "undefined" ? window.location.origin : ""}${OME_TIFF_PUBLIC_PATH}`)
      : null;

    (async () => {
      try {
        const source = hasLocalOme
          ? await openOmeTiffFromFile(omeTiffFile)
          : await openOmeTiffAsPixelSources(remoteUrl);
        if (cancelled) return;

        const mapped = {};
        const omeNameToIdx = {};
        for (let i = 0; i < (source?.names?.length || 0); i++) {
          const key = String(source.names[i] || "").trim().toLowerCase();
          if (key && !Object.prototype.hasOwnProperty.call(omeNameToIdx, key)) {
            omeNameToIdx[key] = i;
          }
        }
        const selectedList = Array.isArray(channels)
          ? channels.map((x) => Number(x)).filter((x) => Number.isFinite(x))
          : [];
        for (const id of selectedList) {
          const explicit = Boolean(channelHasExplicitOmeIndexById?.[id]);
          let omeIdx = Number(channelOmeIndexById?.[id]);
          if (!explicit) {
            const nm = String(channelNameById?.[id] || "").trim().toLowerCase();
            if (nm && Object.prototype.hasOwnProperty.call(omeNameToIdx, nm)) {
              omeIdx = Number(omeNameToIdx[nm]);
            }
          }
          if (!Number.isFinite(id) || !Number.isFinite(omeIdx) || omeIdx < 0) continue;
          const fromMetadata = source?.channelRanges?.[omeIdx];
          const computed = await computeOmeChannelRangeFromPixels(source, omeIdx);
          const r = computed || fromMetadata;
          if (!r) continue;
          mapped[id] = {
            data_min: Number.isFinite(r.dataMin) ? r.dataMin : 0,
            data_max: Number.isFinite(r.dataMax) ? r.dataMax : 65535,
            auto_min: Number.isFinite(r.autoMin) ? r.autoMin : 0,
            auto_max: Number.isFinite(r.autoMax) ? r.autoMax : 65535,
          };
        }
        setOmePixelRangeByChannelId(mapped);
      } catch {
        if (!cancelled) setOmePixelRangeByChannelId({});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    omeTiffFile,
    omeTiffPresent,
    channelOmeIndexById,
    channelNameById,
    channelHasExplicitOmeIndexById,
    channels,
  ]);

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

  const clearLocalOmeTiff = useCallback(() => {
    setOmeTiffFile(null);
    setOmeTiffRestoreNeedsClick(false);
    clearOmeTiffFileHandle();
  }, []);

  const restoreOmeTiffFromDisk = useCallback(async () => {
    const handle = await getStoredOmeTiffFileHandle();
    if (!handle) {
      setOmeTiffRestoreNeedsClick(false);
      return;
    }
    const file = await getFileFromOmeTiffHandle(handle);
    if (file) {
      setOmeTiffFile(file);
      setOmeTiffRestoreNeedsClick(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const handle = await getStoredOmeTiffFileHandle();
      if (!handle || cancelled) return;
      const file = await getFileFromOmeTiffHandle(handle);
      if (cancelled) return;
      if (file) {
        setOmeTiffFile(file);
        setOmeTiffRestoreNeedsClick(false);
      } else {
        setOmeTiffRestoreNeedsClick(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Project raw + UMAP, normalize each separately (raw stays in pixel space when OME-TIFF is loaded)
  const applyAllProjections = () => {
    if (!allCoords || allCoords.length === 0) {
      setPoints([]);
      setPointsRaw([]);
      setPointsUMAP([]);
      return;
    }

    if (omeTiffSpatialActive) {
      const rawProjected = allCoords.map((src) => {
        const raw = src?.raw || {};
        return {
          ...src,
          label: src.label ?? (src.id % 11),
          x: Number.isFinite(raw.x) ? raw.x : 0,
          y: Number.isFinite(raw.y) ? raw.y : 0,
          z: 0,
        };
      });
      setPointsRaw(rawProjected);
      setPoints(rawProjected);

      const umapGetter = (p) => {
        if (is3D && p.umap3d) return { x: p.umap3d.x, y: p.umap3d.y, z: p.umap3d.z ?? 0 };
        if (!is3D && p.umap2d) return { x: p.umap2d.x, y: p.umap2d.y, z: 0 };
        return { x: 0, y: 0, z: 0 };
      };
      const projectAndNormalize = (getter) => {
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
      setPointsUMAP(projectAndNormalize(umapGetter));
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

  /** Fast path: upload flags only (OME-TIFF / etc.) — do not wait for meta or coords. */
  const refreshUploadStatus = useCallback(async () => {
    try {
      const statusRes = await fetch(`/upload/status?ts=${Date.now()}`, { cache: "no-store" });
      if (!statusRes.ok) return;
      const statusData = await statusRes.json();
      setRawAnnotationColumns(statusData?.raw_annotation_columns || { celltype: false, neigh_names: false });
      setOmeTiffPresent(Boolean(statusData?.ome_tiff));
    } catch (_) {
      setRawAnnotationColumns({ celltype: false, neigh_names: false });
      setOmeTiffPresent(false);
    }
  }, []);

  const refreshData = useCallback(async (opts = {}) => {
    const skipLoading = opts?.skipLoading === true;
    if (!skipLoading) setLoading(true);
    try {
      const abort = new AbortController();
      // OME-TIFF / upload flags first so Spatial view can switch before heavy meta+coords
      await refreshUploadStatus();

      let metaJson = await fetchMeta(abort.signal);
      setMeta(metaJson);

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

      if (
        opts?.blockingAtlasPrefetch &&
        metaJson &&
        !metaJson.error &&
        coords.length > 0 &&
        metaJson.atlas?.tile != null
      ) {
        const tile = metaJson.atlas.tile;
        const chunkIds = [...new Set(coords.map((p) => p.chunk_id))];
        const selectedCh = channelsRef.current;
        const channelIds =
          Array.isArray(selectedCh) && selectedCh.length > 0
            ? [...selectedCh]
            : typeof metaJson.C === "number" && metaJson.C > 0
              ? Array.from({ length: metaJson.C }, (_, i) => i)
              : [];

        for (const chunkId of chunkIds) {
          try {
            const uv = await fetchUV(chunkId, tile, abort.signal);
            setChunkUV((prev) => (prev[chunkId] ? prev : { ...prev, [chunkId]: uv }));
          } catch (e) {
            console.error("blockingAtlasPrefetch UV", e);
          }
        }

        for (const chunkId of chunkIds) {
          for (const ch of channelIds) {
            try {
              const staticURL = staticAtlasURL(ch, tile, chunkId);
              const ok = await headStaticAtlas(staticURL, abort.signal);
              if (!ok) {
                let gen = await generateAtlasGrayGet(chunkId, ch, tile, abort.signal);
                if (!gen.ok && gen.status !== 304) {
                  if (gen.status === 405 || gen.status === 404) {
                    gen = await generateAtlasGrayPost(chunkId, ch, tile, abort.signal);
                    if (!gen.ok) continue;
                  } else {
                    continue;
                  }
                }
              }
              setAtlasByChannel((prev) => ({
                ...prev,
                [chunkId]: { ...(prev[chunkId] || {}), [ch]: staticURL },
              }));
            } catch (e) {
              console.error("blockingAtlasPrefetch atlas", e);
            }
          }
        }
      }
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
      if (!skipLoading) setLoading(false);
    }
  }, [refreshUploadStatus]);

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
  }, [allCoords, omeTiffSpatialActive]);

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

  // Prefetch UV + gray atlas (UMAP sprites + spatial hover); keep even with OME
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
    omeTiffPresent,
    omeTiffFile,
    setOmeTiffFile,
    clearLocalOmeTiff,
    omeTiffRestoreNeedsClick,
    restoreOmeTiffFromDisk,
    omeTiffSpatialActive,
    channelOmeIndexById,
    omePixelRangeByChannelId,
    /** Server-hosted OME-TIFF URL (only if no local file). */
    omeTiffUrl:
      !omeTiffFile && omeTiffPresent
        ? API_BASE
          ? `${API_BASE}${OME_TIFF_PUBLIC_PATH}`
          : `${typeof window !== "undefined" ? window.location.origin : ""}${OME_TIFF_PUBLIC_PATH}`
        : null,

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
    refreshUploadStatus,
    dataVersion,
    
    ensureUV,
    fetchAtlas,
    fetchAtlasGray,
  };
}
