import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drawCellPreviewToCanvas } from "../../Viewer/HoverPreview/HoverPreview";
import "../../FeatureDock/FeatureDock.css";
import "./LocalFeaturePanel.css";

function cosineSimTo01(sim) {
  const s = typeof sim === "number" ? sim : 0;
  return Math.max(0, Math.min(1, (s + 1) * 0.5));
}

function clearSimilarityRankingGlobals(viewerId) {
  if (typeof window === "undefined") return;
  const rankingKey = `__showSimilarityRanking_${viewerId}`;
  if (window[rankingKey]) window[rankingKey](null);
  if (typeof window.__showSimilarityRanking === "function") {
    window.__showSimilarityRanking(null);
  }
  if (typeof window.__showSimilarityRankingUMAP === "function") {
    window.__showSimilarityRankingUMAP(null);
  }
}

function Thumb({
  object,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  size = 96,
  label,
  onClick,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !object) return;
    (async () => {
      await drawCellPreviewToCanvas({
        canvas,
        object,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        channels,
        colors,
        alphas,
        windows,
        previewSize: size,
      });
    })();
  }, [
    object,
    iconMappingsByChunk,
    chunkUV,
    atlasByChannel,
    channels,
    colors,
    alphas,
    windows,
    size,
  ]);

  const handleClick = () => {
    if (onClick && object) {
      onClick(object);
    }
  };

  return (
    <div className="thumb" onClick={handleClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          display: "block",
        }}
      />
      {label ? <div className="label">{label}</div> : null}
    </div>
  );
}

export default function LocalFeaturePanel({
  data,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  points = [],
  viewerId = "raw",
  similarityNeighborSpace = "umap",
  onSimilarityNeighborSpaceChange,
}) {
  const gallerySpace = similarityNeighborSpace === "embedding" ? "embedding" : "umap";
  const effectiveNeighborSpace =
    (data?.neighbor_space ?? gallerySpace) === "embedding" ? "embedding" : "umap";
  const isEmbedding = effectiveNeighborSpace === "embedding";
  const galleryTitle = isEmbedding
    ? "Similarity Gallery (Embedding Space)"
    : "Similarity Gallery (UMAP Space)";
  const localMetricsTitle = isEmbedding
    ? "Local Metrics (embedding neighbors, feature space)"
    : "Local Metrics (UMAP neighbors, feature space)";
  const similarityHistTitle = isEmbedding
    ? "Similarity histogram · embedding kNN"
    : "Similarity histogram · UMAP kNN";

  const cycleGallerySpace = useCallback(
    (delta) => {
      if (!onSimilarityNeighborSpaceChange) return;
      const order = ["umap", "embedding"];
      const i = order.indexOf(gallerySpace);
      const next = order[(i + delta + order.length) % order.length];
      if (next !== gallerySpace) onSimilarityNeighborSpaceChange(next);
    },
    [gallerySpace, onSimilarityNeighborSpaceChange]
  );
  const mapById = useMemo(() => {
    const m = new Map();
    for (const p of points) m.set(p.id, p);
    // T1 may include atlas-ready coords for neighbors not present in the current points array.
    for (const c of data?.coords || []) {
      if (!c || c.id == null || m.has(c.id)) continue;
      if (c.chunk_id == null || c.local_index == null) continue;
      m.set(c.id, c);
    }
    return m;
  }, [points, data]);

  const queryObj = mapById.get(data?.query);
  const neighborObjs = useMemo(() => {
    const arr = (data?.neighbors || []).map((n) => ({
      ...n,
      object: mapById.get(n.id),
    }));
    return arr.filter((x) => x.object);
  }, [data, mapById]);

  const rankingIds = useMemo(
    () =>
      data
        ? [data.query, ...(data.neighbors || []).map((n) => n.id)].filter((id) => id != null)
        : [],
    [data]
  );

  const focusCellWithRankings = useCallback(
    (obj) => {
      if (!obj || typeof window === "undefined") return;
      const focusKey = `__focusCell_${viewerId}`;
      if (window[focusKey]) window[focusKey]({ id: obj.id });
      if (typeof window.__focusCell === "function") window.__focusCell({ id: obj.id });
      if (typeof window.__focusCellUMAP === "function") window.__focusCellUMAP({ id: obj.id });
      if (rankingIds.length === 0) return;
      const rankingKey = `__showSimilarityRanking_${viewerId}`;
      if (window[rankingKey]) window[rankingKey](rankingIds);
      if (typeof window.__showSimilarityRanking === "function") {
        window.__showSimilarityRanking(rankingIds);
      }
      if (typeof window.__showSimilarityRankingUMAP === "function") {
        window.__showSimilarityRankingUMAP(rankingIds);
      }
    },
    [rankingIds, viewerId]
  );

  const canvasRef = useRef(null);
  const layoutRef = useRef({});
  useEffect(() => {
    const sims = (data?.similarities || [])
      .map((s) => (typeof s === "number" ? (s + 1) * 0.5 : null))
      .filter((s) => typeof s === "number" && Number.isFinite(s));
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 120;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!sims.length) return;

    const X_MIN = 0;
    const X_MAX = 1.0;
    const X_SPAN = Math.max(1e-6, X_MAX - X_MIN);


    const simsIn = sims.filter((s) => s >= X_MIN && s <= X_MAX);
    const base = simsIn.length > 0 ? simsIn : sims;

    const bins = Math.min(16, Math.max(8, Math.round(Math.sqrt(base.length || sims.length) * 2)));
    const hist = new Array(bins).fill(0);
    for (const s of base) {
      let t;
      const norm = (s - X_MIN) / X_SPAN;
      t = Math.floor(Math.max(0, Math.min(0.9999, norm)) * (bins - 1));
      if (t < 0) t = 0; if (t >= bins) t = bins - 1;
      hist[t]++;
    }
    const maxCount = Math.max(...hist);

    const margin = { left: 40, right: 10, top: 8, bottom: 28 };
    const plotW = Math.max(10, w - margin.left - margin.right);
    const plotH = Math.max(10, h - margin.top - margin.bottom);
    const x0 = margin.left;
    const y0 = h - margin.bottom;

    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(x0, y0 - plotH, plotW, plotH);

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + plotW, y0);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y0 - plotH);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const t = i / yTicks;
      const yy = y0 - t * plotH;
      const v = Math.round(t * maxCount);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x0 + plotW, yy);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(String(v), x0 - 6, yy);
    }

    const decimals = X_SPAN < 0.05 ? 3 : 2;
    const tickCount = 10;
    for (let i = 0; i <= tickCount; i++) {
      const val = X_MIN + (X_SPAN * i) / tickCount;
      const t = (val - X_MIN) / X_SPAN;
      const xx = x0 + t * plotW;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(val.toFixed(decimals), xx, y0 + 4);
    }
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Similarity", x0 + plotW / 2, h);
    ctx.save();
    ctx.translate(12, y0 - plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("count", 0, 0);
    ctx.restore();

    const barSlot = plotW / bins;
    const barW = Math.max(1, barSlot * 0.42);
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = 6;
    for (let i = 0; i < bins; i++) {
      const v = hist[i];
      const bh = maxCount ? (v / maxCount) * plotH : 0;
      const bx = x0 + i * barSlot + (barSlot - barW) / 2;
      const by = y0 - bh;
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.globalAlpha = 0.8;
      const r = 3;
      const w2 = barW, h2 = bh;
      ctx.beginPath();
      ctx.moveTo(bx, by + r);
      ctx.arcTo(bx, by, bx + r, by, r);
      ctx.arcTo(bx + w2, by, bx + w2, by + r, r);
      ctx.lineTo(bx + w2, by + h2);
      ctx.lineTo(bx, by + h2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    if (maxCount > 0 && bins > 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < bins; i++) {
        const centerVal = X_MIN + (i + 0.5) * (X_SPAN / bins);
        const t = (centerVal - X_MIN) / X_SPAN;
        const xx = x0 + t * plotW;
        const normCount = hist[i] / maxCount;
        const yy = y0 - normCount * plotH * 0.9;
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    const barRects = [];
    {
      const barSlot2 = plotW / bins;
      const barW2 = Math.max(1, barSlot2 * 0.42);
      for (let i = 0; i < bins; i++) {
        const cxVal = X_MIN + (i + 0.5) * (X_SPAN / bins);
        const v = hist[i];
        const bh = maxCount ? (v / maxCount) * plotH : 0;
        const bx = x0 + i * barSlot2 + (barSlot2 - barW2) / 2;
        barRects.push({ x: bx, y: y0 - bh, w: barW2, h: bh, count: v, center: cxVal });
      }
    }
    layoutRef.current = {
      x0, y0, plotW, plotH, X_MIN, X_SPAN,
      barRects,
      medX: null,
      medianVal: null,
      band: null,
    };
  }, [data]);

  useEffect(() => {
    if (!data || typeof window === "undefined" || rankingIds.length === 0) return;
    const rankingKey = `__showSimilarityRanking_${viewerId}`;
    if (window[rankingKey]) window[rankingKey](rankingIds);
    if (typeof window.__showSimilarityRanking === "function") {
      window.__showSimilarityRanking(rankingIds);
    }
    if (typeof window.__showSimilarityRankingUMAP === "function") {
      window.__showSimilarityRankingUMAP(rankingIds);
    }
    return () => clearSimilarityRankingGlobals(viewerId);
  }, [data, viewerId, rankingIds]);

  const wrapperRef = useRef(null);
  const [globalTooltip, setGlobalTooltip] = useState(null);

  const onMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const l = layoutRef.current || {};
    if (!l || !l.plotW) return;
    for (const r of l.barRects || []) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        const wrap = wrapperRef.current;
        const ww = wrap?.clientWidth || rect.width;
        const wh = wrap?.clientHeight || rect.height;
        const tipW = 180, tipH = 50;
        const lx = Math.max(8, Math.min(mx + 12, ww - tipW - 8));
        const ly = Math.max(8, Math.min(my + 12, wh - tipH - 8));
        setGlobalTooltip({ x: lx, y: ly, lines: [`sim ≈ ${r.center.toFixed(4)}`, `count = ${r.count}`] });
        return;
      }
    }
    setGlobalTooltip(null);
  };
  const onMouseLeave = () => setGlobalTooltip(null);

  if (!data) return null;

  return (
    <div>
      <div className="feature-section">
        <div className={onSimilarityNeighborSpaceChange ? "gallery-space-shell" : undefined}>
          {onSimilarityNeighborSpaceChange ? (
            <button
              type="button"
              className="gallery-space-arrow gallery-space-arrow-left"
              aria-label="Previous: switch between UMAP and embedding neighbor space"
              onClick={() => cycleGallerySpace(-1)}
            >
              ‹
            </button>
          ) : null}
          <div className={onSimilarityNeighborSpaceChange ? "gallery-space-inner" : undefined}>
            <div className="feature-title">{galleryTitle}</div>
            <div className="gallery-t1">
              <div className="gallery-query">
                {queryObj && (
                  <Thumb
                    object={queryObj}
                    iconMappingsByChunk={iconMappingsByChunk}
                    chunkUV={chunkUV}
                    atlasByChannel={atlasByChannel}
                    channels={channels}
                    colors={colors}
                    alphas={alphas}
                    windows={windows}
                    size={96}
                    label="query"
                    onClick={focusCellWithRankings}
                  />
                )}
              </div>
              <div className="neighbors-grid">
                {neighborObjs.slice(0, 8).map((n) => (
                  <Thumb
                    key={n.id}
                    object={n.object}
                    iconMappingsByChunk={iconMappingsByChunk}
                    chunkUV={chunkUV}
                    atlasByChannel={atlasByChannel}
                    channels={channels}
                    colors={colors}
                    alphas={alphas}
                    windows={windows}
                    size={64}
                    label={`sim ${cosineSimTo01(n.similarity).toFixed(2)}`}
                    onClick={focusCellWithRankings}
                  />
                ))}
              </div>
            </div>
          </div>
          {onSimilarityNeighborSpaceChange ? (
            <button
              type="button"
              className="gallery-space-arrow gallery-space-arrow-right"
              aria-label="Next: switch between UMAP and embedding neighbor space"
              onClick={() => cycleGallerySpace(1)}
            >
              ›
            </button>
          ) : null}
        </div>
      </div>

      <div className="feature-section">
        <div className="feature-title">{localMetricsTitle}</div>
        <div className="metrics-wrap">
        <div className="metric-card">
          <div className="metric-row">
            <div className="metric-name">Compactness</div>
            <div className="metric-pad-right">
              <div
                className="metric-line"
                aria-label="compactness line"
                title={typeof data?.compactness === "number" ? `raw=${data.compactness.toFixed(4)}` : ""}
              >
                <div className="metric-tick" />
                {(() => {
                  const p = Math.max(0, Math.min(1, data?.percentiles?.compactness ?? 0));
                  const left = `${(p * 100).toFixed(1)}%`;
                  return <div className="metric-dot" style={{ left, background: '#d9d9d9' }} />;
                })()}
              </div>
              <div className="metric-legend">
                <div>low</div>
                <div className="center">median</div>
                <div className="right">high</div>
              </div>
            </div>
            <div className="metric-value">
              {typeof data?.percentiles?.compactness === "number" ? (
                <>
                  <div className="pctl-num">{Math.round((data.percentiles.compactness) * 100)}th</div>
                  <div className="pctl-suffix">percentile</div>
                </>
              ) : (
                "--"
              )}
            </div>
          </div>
          <div className="metric-row">
            <div className="metric-name">Difference between Query and Neighbors</div>
            <div className="metric-pad-right">
              <div
                className="metric-line"
                aria-label="difference line"
                title={typeof data?.difference === "number" ? `raw=${data.difference.toFixed(4)}` : ""}
              >
                <div className="metric-tick" />
                {(() => {
                  const p = Math.max(0, Math.min(1, data?.percentiles?.difference ?? 0));
                  const left = `${(p * 100).toFixed(1)}%`;
                  return <div className="metric-dot" style={{ left, background: '#bfbfbf' }} />;
                })()}
              </div>
              <div className="metric-legend">
                <div>typical</div>
                <div className="center">median</div>
                <div className="right">unique</div>
              </div>
            </div>
            <div className="metric-value">
              {typeof data?.percentiles?.difference === "number" ? (
                <>
                  <div className="pctl-num">{Math.round((data.percentiles.difference) * 100)}th</div>
                  <div className="pctl-suffix">percentile</div>
                </>
              ) : (
                "--"
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      <div className="feature-section">
        <div className="feature-title">{similarityHistTitle}</div>
        <div ref={wrapperRef} className="hist-wrapper">
        <canvas
            className="hist-canvas"
            ref={canvasRef}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          />
          {globalTooltip && (
            <div
              className="fixed-tooltip"
              style={{
                left: Math.round(globalTooltip.x),
                top: Math.round(globalTooltip.y),
              }}
            >
              {globalTooltip.lines.map((t, i) => (
                <div key={i} style={{ opacity: i === 0 ? 1 : 0.8 }}>{t}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


